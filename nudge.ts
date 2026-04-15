import { AGENT_SESSIONS, TMUX_PATH } from './config'
import { tryNudge, buildWakeMessage, type NudgeUrgency } from './debounce'
import type { TaskDB } from './db'
import type { AuditLog } from './audit'
import { NUDGE_ACTIONS } from './nudge-actions'

export function resolveSession(agent: string): string | null {
  const label = agent.toLowerCase()
  return AGENT_SESSIONS[label] ?? null
}

export function buildNudgeCommand(session: string, message: string): string[] {
  return [TMUX_PATH, 'send-keys', '-t', session, message, 'C-m']
}

/**
 * Build the three-step submit-verify send-keys sequence for a pane.
 * Returns [escapeCmd, literalCmd, cmCmd] argv arrays.
 *
 * Per Decision #41 (2026-04-15): the Claude Code TUI does NOT reliably submit
 * on a single 'Enter' keystroke when a paste arrives into a stale input buffer.
 * The fix: Escape any in-progress menu/prompt, paste the payload literally with
 * -l (no escape interpretation), then send C-m (the actual submit key, not the
 * 'Enter' string alias tmux maps inconsistently).
 */
export function buildNudgeSequence(
  session: string,
  message: string,
): [string[], string[], string[]] {
  return [
    [TMUX_PATH, 'send-keys', '-t', session, 'Escape'],
    [TMUX_PATH, 'send-keys', '-t', session, '-l', message],
    [TMUX_PATH, 'send-keys', '-t', session, 'C-m'],
  ]
}

// Test-mode guard: when running under `bun test`, Bun sets process.env.NODE_ENV = 'test'
// automatically. We also honor an explicit THREADWORK_NUDGE_DISABLE escape hatch for
// running scripts locally without spamming real agent sessions.
const NUDGE_DISABLED =
  process.env.NODE_ENV === 'test' ||
  process.env.THREADWORK_NUDGE_DISABLE === '1'

// v2-lite debounce plumbing — module-level so every callsite goes through
// the same debounce state. Main/server/watchdog set this once at boot via
// configureNudgeDebounce(). If unset, dispatchAgentNudge behaves exactly as before
// (no debounce, no suppression).
let _debounceDb: TaskDB | null = null
let _debounceAudit: AuditLog | null = null

export function configureNudgeDebounce(taskDb: TaskDB, audit?: AuditLog): void {
  _debounceDb = taskDb
  _debounceAudit = audit ?? null
}

export interface NudgeOptions {
  /** Debounce priority hint. 'urgent' bypasses the suppression window. */
  urgency?: NudgeUrgency
  /** Skip debounce entirely for this call (e.g., raw test harness). */
  bypassDebounce?: boolean
  /** Source agent label for audit attribution (who is nudging). Defaults to 'watchdog'. */
  source?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function runTmux(argv: string[]): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, error: `tmux failed (exit ${exitCode}): ${stderr.trim()}` }
  }
  return { ok: true }
}

async function capturePane(session: string): Promise<string> {
  const proc = Bun.spawn([TMUX_PATH, 'capture-pane', '-t', session, '-p'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) return ''
  return await new Response(proc.stdout).text()
}

/**
 * Submit a nudge payload to a tmux pane using the Escape + literal-paste + C-m
 * sequence (see buildNudgeSequence), then verify the payload landed via
 * capture-pane (3 retries × 200ms, NO resubmit on failure).
 *
 * Per Decision #41 (2026-04-15). Replaces the old single-shot 'Enter' approach
 * that silently failed when the Claude Code TUI consumed the key as a newline
 * instead of submit.
 */
async function sendTmuxNudgeV2(
  session: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const [escapeCmd, literalCmd, cmCmd] = buildNudgeSequence(session, message)

  const escapeResult = await runTmux(escapeCmd)
  if (!escapeResult.ok) return escapeResult
  await sleep(50)

  const literalResult = await runTmux(literalCmd)
  if (!literalResult.ok) return literalResult
  await sleep(30)

  const cmResult = await runTmux(cmCmd)
  if (!cmResult.ok) return cmResult

  // Verify-and-error loop (no resubmit). 3 retries × 200ms.
  // Needle is a short prefix of the payload — long messages may wrap in
  // capture-pane output, so we probe for a short unique token instead.
  const needle = message.trimStart().slice(0, 24)
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(200)
    const pane = await capturePane(session)
    if (pane.includes(needle)) {
      return { ok: true }
    }
  }
  return {
    ok: false,
    error: 'verify_failed: payload not visible in pane after 3 retries',
  }
}

// Preflight check: does the tmux session actually exist on the running tmux server?
// This catches stale-target failure (session killed + recreated between nudges, or
// never booted). Returns true if the session exists, false otherwise.
async function sessionExists(session: string): Promise<boolean> {
  const proc = Bun.spawn([TMUX_PATH, 'has-session', '-t', session], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  return exitCode === 0
}

/**
 * Emit the canonical nudge_sent + agent_nudged audit rows on successful delivery.
 *
 * Sprint #256 spec gate 3: `audit_log('agent_nudged')` appears EXACTLY ONCE in the
 * codebase, and that one place is here. Any other file writing this literal is a
 * bug. Enforced by tests/guardrails/no-direct-nudge-paths.test.ts.
 */
function logDelivered(source: string, agent: string, message: string): void {
  if (!_debounceAudit) return
  try {
    // New canonical name (dispatcher-emitted).
    _debounceAudit.log(source, NUDGE_ACTIONS.SENT, { target: agent, message })
    // Legacy alias kept for metrics view compatibility with pre-sprint-#256 rows.
    _debounceAudit.log(source, NUDGE_ACTIONS.AGENT_NUDGED_LEGACY, { target: agent, message })
  } catch { /* audit failure must never break a nudge decision */ }
}

/**
 * Canonical dispatcher for all agent nudges.
 *
 * Sprint #256 spec gate 1: `dispatchAgentNudge` is the single public entry point
 * for anything that wants to send a tmux nudge to another agent. Server.ts and
 * watchdog.ts MUST call this function and nothing else. Do not re-add direct
 * tmux send-keys or direct audit_log('agent_nudged') anywhere else.
 *
 * Order of operations (council spec Q2):
 *   1. Resolve target session FRESH (stateless, no cache)
 *   2. Write nudge_requested audit row (intent)
 *   3. If NUDGE_DISABLED (test mode) → bail with ok
 *   4. If debounce configured → tryNudge; emit suppressed row on suppress
 *   5. If should fire → emit nudge_fired row
 *   6. Preflight: has-session check
 *   7. Send-keys; emit nudge_sent + agent_nudged on success OR nudge_delivery_failed on error
 */
export async function dispatchAgentNudge(
  agent: string,
  message: string,
  options?: NudgeOptions,
): Promise<{ ok: boolean; error?: string; suppressed?: boolean; pendingCount?: number }> {
  const session = resolveSession(agent)
  const source = options?.source ?? 'watchdog'

  if (!session) {
    return { ok: false, error: `Unknown agent: ${agent}` }
  }

  // Emit the intent row first. This is what the dispatcher unconditionally writes
  // to prove it was invoked, regardless of whether the keystrokes end up landing.
  if (_debounceAudit) {
    try {
      _debounceAudit.log(source, NUDGE_ACTIONS.REQUESTED, {
        target: agent,
        urgency: options?.urgency ?? 'normal',
        message,
      })
    } catch { /* intent-log failure must never break a nudge */ }
  }

  if (NUDGE_DISABLED) {
    // No-op in test mode — tests that need to assert on nudges should check
    // the audit log or use dependency injection, not observe real tmux side effects.
    return { ok: true }
  }

  const urgency: NudgeUrgency = options?.urgency ?? 'normal'

  // If debounce hasn't been configured, or the caller explicitly opted out,
  // fall back to direct send (legacy behavior). Still emit canonical delivery
  // audit rows on the success path.
  if (!_debounceDb || options?.bypassDebounce) {
    const aliveDirect = await sessionExists(session)
    if (!aliveDirect) {
      if (_debounceAudit) {
        try {
          _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
            target: agent,
            reason: 'no_target_pane',
            session,
          })
        } catch {}
      }
      return { ok: false, error: `no_target_pane: ${session}` }
    }
    const sendResult = await sendTmuxNudgeV2(session, message)
    if (sendResult.ok) {
      logDelivered(source, agent, message)
    } else if (_debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
          target: agent,
          reason: 'send_keys_error',
          error: sendResult.error ?? 'unknown',
        })
      } catch {}
    }
    return sendResult
  }

  const result = tryNudge(_debounceDb, agent, urgency)

  if (!result.shouldFire) {
    // Suppressed — audit-log for metrics (v_nudge_metrics_24h view).
    // CRITICAL: do NOT write agent_nudged here. Suppressed = no keystrokes = no nudge event.
    if (_debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.SUPPRESSED, {
          target: agent,
          urgency,
          reason: result.reason ?? 'debounced',
          window_ms_remaining: result.windowRemainingMs ?? 0,
          pending_count: result.pendingCount,
        })
      } catch { /* audit failure must never break a nudge decision */ }
    }
    return { ok: true, suppressed: true, pendingCount: result.pendingCount }
  }

  // Fire: use the uniform wake payload if pendingCount > 1 (batched wake).
  // For a first-time / single-event fire, the original message is clearer
  // and won't claim "you have 1 pending event" (redundant with the wake).
  const payload = result.pendingCount > 1 ? buildWakeMessage(result.pendingCount) : message

  if (_debounceAudit) {
    try {
      _debounceAudit.log(source, NUDGE_ACTIONS.FIRED, {
        target: agent,
        urgency,
        reason: result.reason ?? 'window_elapsed',
        pending_count: result.pendingCount,
      })
    } catch { /* same */ }
  }

  // Preflight: confirm the target pane is alive BEFORE send-keys. Catches the
  // stale-target failure mode that the respawn test asserts against.
  const alive = await sessionExists(session)
  if (!alive) {
    if (_debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
          target: agent,
          reason: 'no_target_pane',
          session,
        })
      } catch {}
    }
    return { ok: false, error: `no_target_pane: ${session}`, suppressed: false, pendingCount: result.pendingCount }
  }

  const sendResult = await sendTmuxNudgeV2(session, payload)
  if (sendResult.ok) {
    // Canonical delivery audit — only on successful keystroke send.
    logDelivered(source, agent, payload)
  } else if (_debounceAudit) {
    try {
      _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
        target: agent,
        reason: 'send_keys_error',
        error: sendResult.error ?? 'unknown',
      })
    } catch {}
  }
  return { ...sendResult, suppressed: false, pendingCount: result.pendingCount }
}

/**
 * Deprecated alias kept for backward compatibility with any callers that
 * haven't been migrated yet. New code must call `dispatchAgentNudge`.
 *
 * Tests may still import this under the old name; that is allowed and the
 * guardrail test accounts for it.
 */
export const nudgeAgent = dispatchAgentNudge

/**
 * Canonical dispatcher for sending Ctrl+C (interrupt) to another agent's pane.
 *
 * Sprint #256 spec gate 4: raw `tmux send-keys` invocations MUST live only inside
 * this file (or test files). server.ts::interrupt_agent used to shell out
 * directly via `Bun.spawn([TMUX_PATH, 'send-keys', ..., 'C-c'])`; that was a
 * bypass of the dispatcher boundary. All interrupt sends now go through here.
 */
export async function dispatchAgentInterrupt(
  agent: string,
  reason: string,
  options?: { source?: string },
): Promise<{ ok: boolean; error?: string }> {
  const session = resolveSession(agent)
  const source = options?.source ?? 'watchdog'

  if (!session) {
    return { ok: false, error: `Unknown agent: ${agent}` }
  }

  if (NUDGE_DISABLED) {
    return { ok: true }
  }

  const alive = await sessionExists(session)
  if (!alive) {
    if (_debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
          target: agent,
          reason: 'no_target_pane',
          session,
          kind: 'interrupt',
        })
      } catch {}
    }
    return { ok: false, error: `no_target_pane: ${session}` }
  }

  const proc = Bun.spawn([TMUX_PATH, 'send-keys', '-t', session, 'C-c'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    if (_debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
          target: agent,
          reason: 'send_keys_error',
          error: stderr.trim(),
          kind: 'interrupt',
        })
      } catch {}
    }
    return { ok: false, error: `tmux failed (exit ${exitCode}): ${stderr.trim()}` }
  }

  if (_debounceAudit) {
    try {
      _debounceAudit.log(source, NUDGE_ACTIONS.INTERRUPTED, { target: agent, reason })
    } catch {}
  }

  return { ok: true }
}
