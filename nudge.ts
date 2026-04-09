import { AGENT_SESSIONS, TMUX_PATH } from './config'
import { tryNudge, buildWakeMessage, type NudgeUrgency } from './debounce'
import type { TaskDB } from './db'
import type { AuditLog } from './audit'

export function resolveSession(agent: string): string | null {
  const label = agent.toLowerCase()
  return AGENT_SESSIONS[label] ?? null
}

export function buildNudgeCommand(session: string, message: string): string[] {
  return [TMUX_PATH, 'send-keys', '-t', session, message, 'Enter']
}

// Test-mode guard: when running under `bun test`, Bun sets process.env.NODE_ENV = 'test'
// automatically. We also honor an explicit THREADWORK_NUDGE_DISABLE escape hatch for
// running scripts locally without spamming real agent sessions.
//
// Without this guard, tests that use isolated TEST_DBs would still fire real tmux
// send-keys at real claude-{agent} sessions via the side-effectful nudgeAgent,
// producing fixture-title spam in running agents' main threads.
//
// BUG FIX 2026-04-09 (GOD_20260409_2229_6732): the original guard included a
// `typeof Bun.jest === 'function'` check intended to detect `bun test`. That symbol
// is ALWAYS exposed by the Bun runtime regardless of whether you're in test mode —
// so `nudgeAgent()` silently no-op'd every single call in production (MCP server,
// watchdog, everywhere). Removed — we now rely only on NODE_ENV and the explicit
// env escape hatch. If test runs start firing nudges again, set
// THREADWORK_NUDGE_DISABLE=1 in the test harness instead.
const NUDGE_DISABLED =
  process.env.NODE_ENV === 'test' ||
  process.env.THREADWORK_NUDGE_DISABLE === '1'

// v2-lite debounce plumbing — module-level so every callsite goes through
// the same debounce state. Main/server/watchdog set this once at boot via
// configureNudgeDebounce(). If unset, nudgeAgent behaves exactly as before
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
}

async function sendTmux(session: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const cmd = buildNudgeCommand(session, message)
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, error: `tmux failed (exit ${exitCode}): ${stderr.trim()}` }
  }
  return { ok: true }
}

export async function nudgeAgent(
  agent: string,
  message: string,
  options?: NudgeOptions,
): Promise<{ ok: boolean; error?: string; suppressed?: boolean; pendingCount?: number }> {
  const session = resolveSession(agent)
  if (!session) {
    return { ok: false, error: `Unknown agent: ${agent}` }
  }

  if (NUDGE_DISABLED) {
    // No-op in test mode — tests that need to assert on nudges should check
    // the audit log or use dependency injection, not observe real tmux side effects.
    return { ok: true }
  }

  const urgency: NudgeUrgency = options?.urgency ?? 'normal'

  // If debounce hasn't been configured, or the caller explicitly opted out,
  // fall back to direct send (legacy behavior).
  if (!_debounceDb || options?.bypassDebounce) {
    return sendTmux(session, message)
  }

  const result = tryNudge(_debounceDb, agent, urgency)

  if (!result.shouldFire) {
    // Suppressed — audit-log for metrics (v_nudge_metrics_24h view).
    if (_debounceAudit) {
      try {
        _debounceAudit.log('watchdog', 'nudge_suppressed', {
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
      _debounceAudit.log('watchdog', 'nudge_fired', {
        target: agent,
        urgency,
        reason: result.reason ?? 'window_elapsed',
        pending_count: result.pendingCount,
      })
    } catch { /* same */ }
  }

  const sendResult = await sendTmux(session, payload)
  return { ...sendResult, suppressed: false, pendingCount: result.pendingCount }
}
