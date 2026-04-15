// v2-lite watchdog sprint (2026-04-09)
//
// Nudge debounce helper — suppresses redundant tmux nudges within a
// configurable window so agents aren't woken repeatedly by the watchdog
// loop or concurrent event sources. All wake signals funnel through
// tryNudge(); the suppressed count is reported on the next fire so the
// woken agent can see "you have N pending events" without per-event
// nudging.
//
// Feature-gated via THREADWORK_DEBOUNCE_ENABLED (default OFF). When
// disabled, tryNudge is a pass-through: it reports shouldFire=true with
// pendingCount=0 and does not touch the tw_nudge_debounce row.
//
// Timestamp comparison policy: SQLite datetimes are 'YYYY-MM-DD HH:MM:SS' UTC;
// always parse with `new Date(v + 'Z').getTime()` before comparing to
// `Date.now()`. See sprint 2026-04-09-v2-lite-watchdog.

import type { TaskDB } from './db'

export type NudgeUrgency = 'low' | 'normal' | 'high' | 'urgent'

export interface TryNudgeResult {
  shouldFire: boolean
  pendingCount: number
  reason?: 'disabled' | 'first' | 'window_elapsed' | 'urgent_bypass' | 'debounced'
  windowRemainingMs?: number
}

export interface DebounceConfig {
  windowSec: number
  enabled: boolean
}

export const DEFAULT_WINDOW_SEC = 90

export function getDebounceConfig(): DebounceConfig {
  const rawSec = process.env.THREADWORK_DEBOUNCE_WINDOW_SEC
  const parsedSec = rawSec ? Number(rawSec) : NaN
  const windowSec = Number.isFinite(parsedSec) && parsedSec > 0 ? parsedSec : DEFAULT_WINDOW_SEC
  const enabled = process.env.THREADWORK_DEBOUNCE_ENABLED === '1'
  return { windowSec, enabled }
}

const URGENCY_RANK: Record<NudgeUrgency, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
}

function rankUrgency(u: string | null | undefined): number {
  if (!u) return URGENCY_RANK.normal
  return URGENCY_RANK[(u as NudgeUrgency)] ?? URGENCY_RANK.normal
}

/**
 * Record a pending event for an agent WITHOUT firing a nudge.
 * Increments pending_count and upgrades last_urgency if this event is
 * higher priority than the prior highest. Use when you know a nudge
 * was already suppressed elsewhere in the cycle.
 */
export function recordPendingEvent(
  taskDb: TaskDB,
  agent: string,
  urgency: NudgeUrgency = 'normal',
): void {
  const cfg = getDebounceConfig()
  if (!cfg.enabled) return

  taskDb.run(db => {
    const row = db.prepare(
      'SELECT pending_count, last_urgency FROM tw_nudge_debounce WHERE agent = ?'
    ).get(agent) as { pending_count: number; last_urgency: string } | null

    if (!row) {
      db.prepare(`
        INSERT INTO tw_nudge_debounce (agent, last_nudged_at, pending_count, last_urgency, updated_at)
        VALUES (?, NULL, 1, ?, datetime('now'))
      `).run(agent, urgency)
      return
    }

    const nextUrgency =
      rankUrgency(urgency) > rankUrgency(row.last_urgency) ? urgency : row.last_urgency

    db.prepare(`
      UPDATE tw_nudge_debounce SET
        pending_count = pending_count + 1,
        last_urgency = ?,
        updated_at = datetime('now')
      WHERE agent = ?
    `).run(nextUrgency, agent)
  })
}

/**
 * Attempt to nudge an agent, honoring the debounce window.
 *
 * Returns { shouldFire, pendingCount, reason }. Caller fires the actual
 * tmux send-keys only when shouldFire === true. pendingCount includes the
 * current event and any previously-suppressed events since the last fire.
 *
 * Fires if:
 *   - debounce is disabled (pass-through)
 *   - no prior nudge has ever been sent for this agent
 *   - (now - last_nudged_at) >= windowSec
 *   - urgency === 'urgent'
 *
 * When it fires: updates last_nudged_at=now and resets pending_count=0.
 * When it suppresses: increments pending_count and upgrades last_urgency.
 */
export function tryNudge(
  taskDb: TaskDB,
  agent: string,
  urgency: NudgeUrgency = 'normal',
): TryNudgeResult {
  const cfg = getDebounceConfig()
  if (!cfg.enabled) {
    return { shouldFire: true, pendingCount: 0, reason: 'disabled' }
  }

  return taskDb.run(db => {
    const nowMs = Date.now()
    const row = db.prepare(
      'SELECT last_nudged_at, pending_count, last_urgency FROM tw_nudge_debounce WHERE agent = ?'
    ).get(agent) as { last_nudged_at: string | null; pending_count: number; last_urgency: string } | null

    const windowMs = cfg.windowSec * 1000

    // First time this agent has ever been considered — fire immediately.
    if (!row) {
      db.prepare(`
        INSERT INTO tw_nudge_debounce (agent, last_nudged_at, pending_count, last_urgency, updated_at)
        VALUES (?, datetime('now'), 0, ?, datetime('now'))
      `).run(agent, urgency)
      return { shouldFire: true, pendingCount: 1, reason: 'first' }
    }

    let lastNudgedMs = 0
    if (row.last_nudged_at) {
      const parsed = new Date(row.last_nudged_at + 'Z').getTime()
      lastNudgedMs = Number.isNaN(parsed) ? 0 : parsed
    }

    const elapsedMs = nowMs - lastNudgedMs
    const windowElapsed = lastNudgedMs === 0 || elapsedMs >= windowMs
    const isUrgent = urgency === 'urgent'

    if (windowElapsed || isUrgent) {
      // Fire: reset pending_count, update last_nudged_at.
      // pendingCount reported is the count we're about to collapse (prior
      // suppressed + this one).
      const pendingCount = row.pending_count + 1
      db.prepare(`
        UPDATE tw_nudge_debounce SET
          last_nudged_at = datetime('now'),
          pending_count = 0,
          last_urgency = ?,
          updated_at = datetime('now')
        WHERE agent = ?
      `).run(urgency, agent)
      return {
        shouldFire: true,
        pendingCount,
        reason: isUrgent && !windowElapsed ? 'urgent_bypass' : (lastNudgedMs === 0 ? 'first' : 'window_elapsed'),
      }
    }

    // Suppress: increment pending_count, upgrade urgency if higher.
    const nextUrgency =
      rankUrgency(urgency) > rankUrgency(row.last_urgency) ? urgency : row.last_urgency
    db.prepare(`
      UPDATE tw_nudge_debounce SET
        pending_count = pending_count + 1,
        last_urgency = ?,
        updated_at = datetime('now')
      WHERE agent = ?
    `).run(nextUrgency, agent)

    return {
      shouldFire: false,
      pendingCount: row.pending_count + 1,
      reason: 'debounced',
      windowRemainingMs: Math.max(0, windowMs - elapsedMs),
    }
  })
}

/**
 * Build the uniform wake message for a collapsed batch of events.
 * pendingCount should come from tryNudge's TryNudgeResult.
 */
export function buildWakeMessage(pendingCount: number): string {
  const n = Math.max(1, pendingCount)
  return `[wake] you have ${n} pending event${n === 1 ? '' : 's'} — call list_tasks and read_status to see what changed.`
}
