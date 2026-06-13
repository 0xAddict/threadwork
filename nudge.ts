import { AGENT_SESSIONS, TMUX_PATH } from './config'
import { tryNudge, buildWakeMessage, type NudgeUrgency } from './debounce'
import type { TaskDB } from './db'
import type { AuditLog } from './audit'
import { NUDGE_ACTIONS } from './nudge-actions'

export function resolveSession(agent: string | null | undefined): string | null {
  if (!agent) return null
  const label = agent.toLowerCase()
  return AGENT_SESSIONS[label] ?? null
}

/**
 * #13012 Sub-Sprint C / Item 8b — web-user / non-agent creator notify mapping.
 *
 * A web-created board card has from_agent='web-user' (a non-roster creator).
 * The complete_task auto-nudge nudges task.from_agent → dispatchAgentNudge
 * ('web-user') → resolveSession('web-user') returns null (not in AGENT_SESSIONS)
 * → the dispatcher returns { ok:false, error:'Unknown agent: web-user' } and the
 * completion path surfaces a spurious "Unknown agent" warning.
 *
 * This maps a non-roster creator to a REAL roster recipient so the notify
 * resolves cleanly instead of erroring. Resolution order:
 *   1. If `creator` is already a roster agent → use it (unchanged behavior; the
 *      normal agent-to-agent completion nudge is preserved exactly).
 *   2. Else (web-user / any non-agent creator) → fall back to a real recipient:
 *      the card's assignee/owner (`fallback`, typically task.to_agent — the
 *      agent who built the card and is the natural "your card is done"
 *      recipient) if it is a roster agent, otherwise BOSS (the approver-proxy
 *      who relays acceptance to Gwei). Boss is always a valid roster session, so
 *      this never returns an unresolvable target.
 *
 * The team GROUP post (postToGroupThreaded) is unaffected — it always fires and
 * is the human-visible trail; this just keeps the tmux agent-nudge from erroring
 * on a web creator. Pure mapping; no side effects.
 *
 * @param creator  the raw from_agent on the card (may be 'web-user' etc.)
 * @param fallback the card's assignee/owner (task.to_agent) — preferred real
 *                 recipient when the creator is a non-agent. May be null.
 * @returns a roster agent label guaranteed resolvable by resolveSession.
 */
export function resolveNotifyTarget(
  creator: string | null | undefined,
  fallback: string | null | undefined,
): string {
  const creatorLabel = creator?.toLowerCase()
  if (creatorLabel && AGENT_SESSIONS[creatorLabel]) return creatorLabel

  const fallbackLabel = fallback?.toLowerCase()
  if (fallbackLabel && AGENT_SESSIONS[fallbackLabel]) return fallbackLabel

  // Approver-proxy: boss relays acceptance to Gwei. Always a valid session.
  return 'boss'
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

export type TmuxFailReason =
  | 'tmux_missing'
  | 'session_gone'
  | 'send_keys_error'
  | 'load_buffer_error'
  | 'verify_failed'
  | 'empty_message'
  | 'discovery_ping_failed'

function classifyTmuxStderr(stderr: string): TmuxFailReason {
  const s = stderr.toLowerCase()
  if (
    s.includes("can't find session") ||
    s.includes('no such session') ||
    s.includes('session not found') ||
    s.includes("can't find pane") ||
    s.includes('no such pane')
  ) {
    return 'session_gone'
  }
  return 'send_keys_error'
}

async function runTmux(
  argv: string[],
): Promise<{ ok: boolean; error?: string; reason?: TmuxFailReason }> {
  let proc
  try {
    proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/ENOENT|not found|command not found/i.test(msg)) {
      return { ok: false, error: `tmux_missing: ${msg}`, reason: 'tmux_missing' }
    }
    return { ok: false, error: `spawn_failed: ${msg}`, reason: 'send_keys_error' }
  }
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    const reason = classifyTmuxStderr(stderr)
    return {
      ok: false,
      error: `tmux failed (exit ${exitCode}): ${stderr.trim()}`,
      reason,
    }
  }
  return { ok: true }
}

async function capturePane(session: string): Promise<string> {
  // -S -50 -E -1 → last 50 lines. Claude Code's streaming panel can be
  // very tall, so -S -20 (council suggestion) was too shallow per external
  // research. 50 lines covers typical streaming response panels without
  // O(scrollback) cost.
  const proc = Bun.spawn(
    [TMUX_PATH, 'capture-pane', '-t', session, '-p', '-S', '-50', '-E', '-1'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  if (exitCode !== 0) return ''
  return await new Response(proc.stdout).text()
}

// Per-session serializer. Both nudge and interrupt dispatchers route through
// withSessionLock to prevent the Ctrl-C / paste / C-m interleave race flagged
// by the codex commit review — module state previously had only debounce/audit
// handles, no mutex.
const _sessionLocks: Map<string, Promise<unknown>> = new Map()

async function withSessionLock<T>(
  session: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = _sessionLocks.get(session) ?? Promise.resolve()
  const current: Promise<T> = prev.then(
    () => fn(),
    () => fn(),
  )
  const tracked: Promise<unknown> = current.catch(() => {})
  _sessionLocks.set(session, tracked)
  try {
    return await current
  } finally {
    if (_sessionLocks.get(session) === tracked) {
      _sessionLocks.delete(session)
    }
  }
}

const NUDGE_BUFFER_PREFIX = 'threadwork-nudge-'

function normalizePaneText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Submit a nudge payload to a tmux pane.
 *
 * Strategy (per Decision #41 + post-council codex chairman + external deep
 * research feeding back anthropics/claude-code#31739):
 *
 *   1. Reject empty messages at the edge — otherwise needle='' produces
 *      vacuous-match verify-success (codex B1).
 *   2. Strip literal newlines from the payload — Ink's text-input treats
 *      \n as key.enter (newline in composer) and only \r as key.return
 *      (submit). A payload containing \n would compose multi-line input,
 *      potentially submitting at the wrong point.
 *   3. Preamble C-m: send a no-op C-m to wake the TUI's EventBroker from
 *      idle-dropped-keys state. On a long-idle pane, Ink's crossterm
 *      EventStream stops processing key events; this C-m re-activates it.
 *      Proven on steve (idle 9+ min) and sadie (controlled A/B test).
 *   4. Capture a baseline pane snapshot BEFORE paste so we can delta-verify.
 *   5. `load-buffer` + `paste-buffer -p -d -b` into the target pane. This
 *      mirrors the claude_code_agent_farm / awslabs/cli-agent-orchestrator
 *      production pattern. `-p` enables bracketed paste, `-d` deletes the
 *      named buffer after paste, `-b` uses a unique buffer name to avoid
 *      clobbering concurrent pastes.
 *   6. 200ms settle delay (agent_farm's production value).
 *   7. `send-keys C-m` to submit. C-m is the literal Ctrl-M keystroke, not
 *      tmux's `'Enter'` alias which maps inconsistently across TUIs.
 *   8. Delta verify: 3 retries × 400ms. Success = normalized 48-char needle
 *      now appears at a LATER position in the pane tail than in the
 *      baseline capture. Kills the stale-content false-positive class.
 *
 * Claude Code v2.1.108 (anthropics/claude-code#31739) fixed the underlying
 * Ink + crossterm EventStream dropped-key state at the TUI level. This
 * implementation is belt-and-suspenders for older TUIs and portability.
 */
/**
 * Result of sendTmuxNudgeV2 — split contract per #929 Fix-C.
 *
 * `sentOk` reflects whether the send-keys/load-buffer/paste/C-m sequence
 * completed without throwing. `verifyOk` reflects whether the post-submit
 * delta-verify loop saw the needle advance past baseline. `ok` is an alias
 * for `sentOk` retained for backward compatibility with internal callers.
 *
 * The verify check is structurally false-prone on busy/streaming panes
 * (lastIndexOf over last-50-lines pane tail returns -1 when the streaming
 * response rolls the needle off-tail), so callers MUST gate audit/delivery
 * decisions on `sentOk`, not on `verifyOk`. `verifyOk=false` should surface
 * as a soft observability signal (nudge_verify_warn), not a delivery failure.
 */
export interface SendTmuxNudgeResult {
  ok: boolean
  sentOk: boolean
  verifyOk: boolean
  error?: string
  reason?: TmuxFailReason
}

async function sendTmuxNudgeV2(
  session: string,
  message: string,
): Promise<SendTmuxNudgeResult> {
  if (!message || !message.trim()) {
    return {
      ok: false,
      sentOk: false,
      verifyOk: false,
      error: 'empty_message: refusing to nudge with blank payload',
      reason: 'empty_message',
    }
  }

  const safeMessage = message.replace(/\r?\n/g, ' ')
  const normalizedMessage = normalizePaneText(safeMessage)
  const needle = normalizedMessage.slice(0, 48)

  // Preamble C-m: wake the TUI's EventBroker from idle-dropped-keys state.
  // On a long-idle Claude Code pane, the Ink crossterm EventStream stops
  // processing key events (anthropics/claude-code#31739, Codex #12645).
  // A no-op C-m on an empty prompt re-activates the EventStream so the
  // real C-m after the paste registers as a submit event.
  // If the prompt has leftover text, this submits it first — acceptable
  // because stale input should not accumulate in a healthy agent pane.
  // Proven on steve (idle 9+ min → C-m woke) and sadie (idle → new method
  // with preamble C-m succeeded where old method without it failed).
  await runTmux([TMUX_PATH, 'send-keys', '-t', session, 'C-m'])
  await sleep(300)

  const baselinePane = await capturePane(session)
  const baselineIdx = normalizePaneText(baselinePane).lastIndexOf(needle)

  const buffer = `${NUDGE_BUFFER_PREFIX}${session}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`

  let loadProc
  try {
    loadProc = Bun.spawn([TMUX_PATH, 'load-buffer', '-b', buffer, '-'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      sentOk: false,
      verifyOk: false,
      error: `load_buffer_spawn_failed: ${msg}`,
      reason: /ENOENT/i.test(msg) ? 'tmux_missing' : 'load_buffer_error',
    }
  }
  try {
    loadProc.stdin.write(safeMessage)
    loadProc.stdin.end()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      sentOk: false,
      verifyOk: false,
      error: `load_buffer_stdin_failed: ${msg}`,
      reason: 'load_buffer_error',
    }
  }
  const loadExit = await loadProc.exited
  if (loadExit !== 0) {
    const stderr = await new Response(loadProc.stderr).text()
    return {
      ok: false,
      sentOk: false,
      verifyOk: false,
      error: `load_buffer_failed (exit ${loadExit}): ${stderr.trim()}`,
      reason: classifyTmuxStderr(stderr) === 'session_gone'
        ? 'session_gone'
        : 'load_buffer_error',
    }
  }

  const pasteResult = await runTmux([
    TMUX_PATH,
    'paste-buffer',
    '-p',
    '-d',
    '-b',
    buffer,
    '-t',
    session,
  ])
  if (!pasteResult.ok) {
    // On paste failure, `-d` did NOT delete the buffer — clean it up.
    void runTmux([TMUX_PATH, 'delete-buffer', '-b', buffer])
    return {
      ok: false,
      sentOk: false,
      verifyOk: false,
      error: pasteResult.error,
      reason: pasteResult.reason,
    }
  }

  // 200ms settle — agent_farm's production value. Gives the TUI a beat to
  // process the bracketed paste before we submit.
  await sleep(200)

  const cmResult = await runTmux([TMUX_PATH, 'send-keys', '-t', session, 'C-m'])
  if (!cmResult.ok) {
    return {
      ok: false,
      sentOk: false,
      verifyOk: false,
      error: cmResult.error,
      reason: cmResult.reason,
    }
  }

  // SEND-KEYS PATH SUCCEEDED — past this point sentOk is unconditionally true.
  // The delta-verify loop is best-effort observability ONLY. Per #929 Fix-C,
  // a verify-fail no longer fails the nudge: on a busy/streaming pane,
  // `lastIndexOf` over the last-50-lines pane tail returns -1 once the
  // streaming response rolls the needle off-tail, producing false negatives.
  // Callers gate audit on sentOk; verifyOk surfaces as nudge_verify_warn.
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(400)
    const pane = await capturePane(session)
    const currentIdx = normalizePaneText(pane).lastIndexOf(needle)
    if (currentIdx > baselineIdx) {
      return { ok: true, sentOk: true, verifyOk: true }
    }
  }
  return {
    ok: true,
    sentOk: true,
    verifyOk: false,
    error:
      'verify_failed: payload did not advance past baseline in pane tail after 3 × 400ms retries',
    reason: 'verify_failed',
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
    const sendResult = await withSessionLock(session, () =>
      sendTmuxNudgeV2(session, message),
    )
    if (sendResult.sentOk) {
      // #929 Fix-C: audit on send-keys success regardless of verify outcome.
      logDelivered(source, agent, message)
      if (!sendResult.verifyOk && _debounceAudit) {
        try {
          _debounceAudit.log(source, NUDGE_ACTIONS.VERIFY_WARN, {
            target: agent,
            reason: sendResult.reason ?? 'verify_failed',
            error: sendResult.error ?? 'unknown',
            message: message.slice(0, 200),
          })
        } catch {}
      }
    } else if (_debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
          target: agent,
          reason: 'send_keys_error',
          error: sendResult.error ?? 'unknown',
        })
      } catch {}
    }
    return sendResult.ok
      ? { ok: true }
      : { ok: false, error: sendResult.error }
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

  const sendResult = await withSessionLock(session, () =>
    sendTmuxNudgeV2(session, payload),
  )
  if (sendResult.sentOk) {
    // #929 Fix-C: audit on send-keys success regardless of verify outcome.
    // Canonical delivery audit — emitted whenever the keystroke sequence
    // reached tmux without throwing. Verify-fail is a soft warn, not a fail.
    logDelivered(source, agent, payload)
    if (!sendResult.verifyOk && _debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.VERIFY_WARN, {
          target: agent,
          reason: sendResult.reason ?? 'verify_failed',
          error: sendResult.error ?? 'unknown',
          message: payload.slice(0, 200),
        })
      } catch {}
    }
  } else if (_debounceAudit) {
    try {
      _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
        target: agent,
        reason: 'send_keys_error',
        error: sendResult.error ?? 'unknown',
      })
    } catch {}
  }
  return sendResult.ok
    ? { ok: true, suppressed: false, pendingCount: result.pendingCount }
    : {
        ok: false,
        error: sendResult.error,
        suppressed: false,
        pendingCount: result.pendingCount,
      }
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

  // Serialize interrupt against concurrent nudges on the same session —
  // prevents the Ctrl-C/paste/C-m interleave race flagged by codex review.
  const interruptResult = await withSessionLock(session, () =>
    runTmux([TMUX_PATH, 'send-keys', '-t', session, 'C-c']),
  )

  if (!interruptResult.ok) {
    if (_debounceAudit) {
      try {
        _debounceAudit.log(source, NUDGE_ACTIONS.DELIVERY_FAILED, {
          target: agent,
          reason: interruptResult.reason ?? 'send_keys_error',
          error: interruptResult.error ?? 'unknown',
          kind: 'interrupt',
        })
      } catch {}
    }
    return { ok: false, error: interruptResult.error ?? 'interrupt_failed' }
  }

  if (_debounceAudit) {
    try {
      _debounceAudit.log(source, NUDGE_ACTIONS.INTERRUPTED, { target: agent, reason })
    } catch {}
  }

  return { ok: true }
}
