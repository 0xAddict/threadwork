#!/usr/bin/env bun
// watchdog.ts — Durable controller loop with session-aware escalation
//
// Sprint 3: Rewritten from one-shot cron to persistent singleton loop.
// Acquires a watchdog lease, reconciles due tasks every WATCHDOG_CADENCE_SEC,
// checks agent sessions for liveness, and handles escalation idempotently.

import { statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Sprint 1 / DEL-1: Canonical label schema validation (C0.4)
// Fail-hard on schema mismatch to prevent silent label drift (premortem DD1/DD12)
// ---------------------------------------------------------------------------
import { validateLabels, schemaCheck, isReadyForDispatch } from './inhibit-engine'

// Re-export for cross-module access
export { validateLabels, schemaCheck, isReadyForDispatch }
import { TaskDB, type Task } from './db'
import { MemoryDB } from './memory'
import { DecisionDB, expireStaleDecisions, type Decision, type DecisionWithDetail } from './decision'
import { AuditLog } from './audit'
import { dispatchAgentNudge, configureNudgeDebounce } from './nudge'
import { postToGroup, formatDecisionExpired, esc } from './notify'
import { checkAndRunDebrief } from './debrief'
import { MemoryConsolidator } from './consolidator'
import {
  DB_PATH,
  AGENT_SESSIONS,
  TMUX_PATH,
  WATCHDOG_CADENCE_SEC,
  UNCLAIMED_CHECK_SEC,
  SESSION_TIMEOUT_SEC,
  SUPERVISION_DEFAULTS,
  WORKER_AGENTS,
  BOSS_AGENT,
  TEAM_AGENTS,
  CONSOLIDATION_DRY_RUN,
  CONSOLIDATION_CHECK_INTERVAL_MS,
} from './config'

// ---------------------------------------------------------------------------
// Blocked state TTL — if a worker reports blocked and then dies, stop relaying
// after this many seconds without a fresh heartbeat.
// ---------------------------------------------------------------------------

const BLOCKED_TTL_SEC = 600 // 10 minutes

// #823: cap on long-block (`human` / `external_api` / `upstream_task`) relays
// without an intervening heartbeat. After this many relays, escalate once and
// stop scheduling re-checks. A heartbeat after `blocked_at` resets the counter.
const LONG_BLOCK_RELAY_CAP = 3

// ---------------------------------------------------------------------------
// Restart-window suppression (TG #5371 / task #1134)
// ---------------------------------------------------------------------------
// When an agent restarts (SessionStart hook fires), its main thread goes silent
// for 60–300s while the new session boots. During this window the watchdog was
// firing false-positive heartbeat-overdue nudges and circuit-open Telegram
// pages to GweiSprayer. session-boot.sh now touches a per-agent flag file in
// ~/.claude/state/restart-window/{agent}.flag at session start. The watchdog
// reads the flag's mtime and suppresses the two restart-driven alert types
// while the flag is fresh (< 300s old). Self-expires via mtime so a stalled
// restart resumes alerting after the TTL — we don't silently lose visibility
// on a real outage. Subagent-stall-watcher.sh (40-min stall detector) and
// level-3 boss-escalation are NOT gated by this — only the worker-level
// heartbeat-overdue nudge and the circuit-open page.
const RESTART_WINDOW_TTL_SEC = 300 // 5 minutes
const RESTART_WINDOW_DIR = join(homedir(), '.claude', 'state', 'restart-window')

function isRestartWindowActive(agent: string): { active: boolean; ageSec: number | null } {
  try {
    const flagPath = join(RESTART_WINDOW_DIR, `${agent}.flag`)
    const stat = statSync(flagPath)
    const ageSec = (Date.now() - stat.mtimeMs) / 1000
    return { active: ageSec < RESTART_WINDOW_TTL_SEC, ageSec }
  } catch {
    return { active: false, ageSec: null }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  checked: number
  nudged: number
  escalated: number
  blocked_relayed: number
  dead_sessions: number
  decisions_expired: number
  decisions_nudged: number
  decisions_ready: number
  idle_nudges: number
  circuits_recovered: number
}

export interface WatchdogConfig {
  cadenceSec: number
  sessionTimeoutSec: number
  leaseTimeoutSec: number
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [watchdog] ${msg}`)
}

function logError(msg: string, err?: unknown): void {
  console.error(`[${new Date().toISOString()}] [watchdog] ERROR: ${msg}`, err ?? '')
}

// ---------------------------------------------------------------------------
// Legacy exports (backward compatibility)
// ---------------------------------------------------------------------------

export function findStaleTasks(taskDb: TaskDB, minutesThreshold: number, audit?: AuditLog): Task[] {
  const db = (taskDb as any).db
  const stale = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'in_progress'
    AND claimed_at < datetime('now', '-' || ? || ' minutes')
  `).all(minutesThreshold) as Task[]

  if (!audit) return stale

  return stale.filter((task: Task) => {
    const activity = audit.getAgentActivity(task.to_agent, minutesThreshold)
    return activity.length === 0
  })
}

export function findUnclaimedTasks(taskDb: TaskDB, minutesThreshold: number): Task[] {
  const db = (taskDb as any).db
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND created_at < datetime('now', '-' || ? || ' minutes')
  `).all(minutesThreshold) as Task[]
}

export function determineAction(nudgeCount: number): 'first_nudge' | 'second_nudge' | 'escalate' {
  if (nudgeCount === 0) return 'first_nudge'
  if (nudgeCount === 1) return 'second_nudge'
  return 'escalate'
}

// ---------------------------------------------------------------------------
// TaskReconciler — the durable watchdog controller
// ---------------------------------------------------------------------------

export class TaskReconciler {
  private taskDb: TaskDB
  private audit: AuditLog
  private config: WatchdogConfig
  private holderId: string
  private pid: number

  constructor(taskDb: TaskDB, audit: AuditLog, config?: Partial<WatchdogConfig>) {
    this.taskDb = taskDb
    this.audit = audit
    this.config = {
      cadenceSec: config?.cadenceSec ?? WATCHDOG_CADENCE_SEC,
      sessionTimeoutSec: config?.sessionTimeoutSec ?? SESSION_TIMEOUT_SEC,
      leaseTimeoutSec: config?.leaseTimeoutSec ?? 120,
    }
    this.holderId = `watchdog-${process.pid}-${Date.now()}`
    this.pid = process.pid
  }

  // -------------------------------------------------------------------------
  // 1. SINGLETON LEASE
  // -------------------------------------------------------------------------

  /**
   * Acquire or renew the singleton watchdog lease.
   * Returns true if this instance holds the lease; false if another active holder exists.
   *
   * Uses INSERT ... ON CONFLICT to atomically acquire if:
   *   - No lease exists, OR
   *   - The existing lease is expired (expires_at < now), OR
   *   - We already hold the lease (holder matches)
   */
  acquireOrRenewLease(): boolean {
    return this.taskDb.run(db => {
      const leaseTimeoutSec = this.config.leaseTimeoutSec

      // Try to acquire or renew
      const result = db.prepare(`
        INSERT INTO watchdog_lease (id, holder, acquired_at, expires_at, pid)
        VALUES (1, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'), ?)
        ON CONFLICT(id) DO UPDATE SET
          holder = excluded.holder,
          acquired_at = CASE
            WHEN watchdog_lease.holder = excluded.holder THEN watchdog_lease.acquired_at
            ELSE datetime('now')
          END,
          expires_at = datetime('now', '+' || ? || ' seconds'),
          pid = excluded.pid
        WHERE watchdog_lease.expires_at < datetime('now')
           OR watchdog_lease.holder = excluded.holder
      `).run(this.holderId, leaseTimeoutSec, this.pid, leaseTimeoutSec)

      // If changes is 0, another active holder has the lease
      if (result.changes === 0) {
        // Double-check: does a lease row exist?
        const existing = db.prepare('SELECT holder, expires_at FROM watchdog_lease WHERE id = 1').get() as { holder: string; expires_at: string } | null
        if (existing) {
          log(`Lease held by ${existing.holder} (expires ${existing.expires_at}), skipping cycle`)
          return false
        }
        // No row at all — try raw insert
        db.prepare(`
          INSERT INTO watchdog_lease (id, holder, acquired_at, expires_at, pid)
          VALUES (1, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'), ?)
        `).run(this.holderId, leaseTimeoutSec, this.pid)
      }

      return true
    })
  }

  // -------------------------------------------------------------------------
  // 2. DUE-TIME-DRIVEN TASK RECONCILIATION
  // -------------------------------------------------------------------------

  /**
   * Query all tasks with next_check_at <= now and reconcile each one.
   */
  async reconcileDueTasks(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      checked: 0,
      nudged: 0,
      escalated: 0,
      blocked_relayed: 0,
      dead_sessions: 0,
      decisions_expired: 0,
      decisions_nudged: 0,
      decisions_ready: 0,
      idle_nudges: 0,
      circuits_recovered: 0,
    }

    // Query due tasks (exclude escalation tasks — they must NOT be re-escalated)
    const dueTasks = this.taskDb.run(db =>
      db.prepare(`
        SELECT * FROM tasks
        WHERE next_check_at <= datetime('now')
        AND status NOT IN ('completed', 'cancelled')
        AND description NOT LIKE 'ESCALATION%'
        ORDER BY next_check_at ASC
      `).all() as Task[]
    )

    for (const task of dueTasks) {
      result.checked++
      try {
        await this.reconcileTask(task, result)
      } catch (err) {
        logError(`Failed to reconcile task #${task.id}`, err)
      }
    }

    // Also check for unclaimed tasks without next_check_at
    await this.checkUnclaimedTasks(result)

    return result
  }

  /**
   * Reconcile a single due task based on its state.
   */
  private async reconcileTask(task: Task, result: ReconcileResult): Promise<void> {
    // (a) BLOCKED: relay to supervisor — but check TTL first.
    // blocked_on semantics (added for #416):
    //   human | external_api | upstream_task → long-block mode. next_check_at
    //     was set at block time using eta_sec or 48h default. The BLOCKED_TTL_SEC
    //     short path does NOT apply. On next_check_at expiry, re-relay to
    //     supervisor and extend the window — do NOT clear blocked_at.
    //   agent | null (legacy) → short-block mode. BLOCKED_TTL_SEC (600s)
    //     applies. On expiry, clear blocked_at and fall through to escalation.
    //
    // (#823) Before either branch fires, check the SIBLING-COMPLETION
    // short-circuit: if this task is blocked AND has a parent AND a sibling
    // task completed AFTER the block began, the work shipped via the sibling.
    // Auto-resolve so we stop re-relaying every 48h forever.
    if (task.blocked_at && task.parent_task_id) {
      const sib = this.taskDb.run(db =>
        db.prepare(`
          SELECT 1 FROM tasks
          WHERE parent_task_id = ?
            AND id != ?
            AND status = 'completed'
            AND completed_at > ?
          LIMIT 1
        `).get(task.parent_task_id, task.id, task.blocked_at)
      )
      if (sib) {
        this.taskDb.run(db => {
          db.prepare(`
            UPDATE tasks SET
              status = 'completed',
              result = COALESCE(result, '') || ' [auto: superseded by sibling]',
              completed_at = COALESCE(completed_at, datetime('now')),
              blocked_at = NULL,
              blocked_reason = NULL,
              blocked_on = NULL,
              next_check_at = NULL
            WHERE id = ?
          `).run(task.id)
        })
        this.audit.log('watchdog', 'auto_resolved_via_sibling', {
          task_id: task.id,
          parent_task_id: task.parent_task_id,
        }, task.id)
        log(`Auto-resolved task #${task.id} via sibling completion (parent=${task.parent_task_id})`)
        return
      }
    }

    if (task.blocked_at) {
      const blockedOn = (task as any).blocked_on as string | null
      const isLongBlock = blockedOn === 'human' || blockedOn === 'external_api' || blockedOn === 'upstream_task'

      if (isLongBlock) {
        // Long-block: task is waiting on something external. Do NOT apply
        // BLOCKED_TTL_SEC and do NOT clear blocked_at. The watchdog only
        // picks this task up again when next_check_at fires (set by the
        // caller's eta_sec or 48h default). On re-check, relay to supervisor
        // again and re-extend the check window.
        //
        // (#823) Cap the number of relays without an intervening heartbeat.
        // Reset the counter if last_heartbeat_at is newer than blocked_at
        // (worker is alive and producing progress despite still being marked
        // blocked). Once the cap is reached, escalate-once-and-stop: drop
        // next_check_at so the watchdog stops picking the task back up.

        const heartbeatFresh = task.last_heartbeat_at
          && new Date(task.last_heartbeat_at + 'Z').getTime() > new Date(task.blocked_at + 'Z').getTime()
        if (heartbeatFresh) {
          this.taskDb.run(db => {
            db.prepare('UPDATE tasks SET blocked_relay_count = 0 WHERE id = ?').run(task.id)
          })
          ;(task as any).blocked_relay_count = 0
        }

        const relayCount = ((task as any).blocked_relay_count as number | null) ?? 0

        if (relayCount >= LONG_BLOCK_RELAY_CAP) {
          log(`Long-block relay cap reached for task #${task.id} (count=${relayCount}, cap=${LONG_BLOCK_RELAY_CAP}) — escalating once and halting relays`)
          this.taskDb.run(db => {
            db.prepare('UPDATE tasks SET next_check_at = NULL WHERE id = ?').run(task.id)
          })
          this.audit.log('watchdog', 'blocked_relay_cap_reached', {
            task_id: task.id,
            blocked_on: blockedOn,
            relay_count: relayCount,
            cap: LONG_BLOCK_RELAY_CAP,
          }, task.id)
          return
        }

        const DEFAULT_LONG_BLOCK_SEC = 172800 // 48h
        log(`Long-blocked task #${task.id} (blocked_on=${blockedOn}, relay ${relayCount + 1}/${LONG_BLOCK_RELAY_CAP}) — re-relaying to supervisor, extending check window by ${DEFAULT_LONG_BLOCK_SEC}s`)
        this.taskDb.run(db => {
          db.prepare(`
            UPDATE tasks SET
              next_check_at = datetime('now', '+' || ? || ' seconds'),
              blocked_relay_count = COALESCE(blocked_relay_count, 0) + 1
            WHERE id = ?
          `).run(DEFAULT_LONG_BLOCK_SEC, task.id)
        })
        await this.handleBlocked(task, result)
        return
      }

      // Short-block (blocked_on=agent or legacy/null): use BLOCKED_TTL_SEC
      const blockedStale = this.isOverdue(task.blocked_at, BLOCKED_TTL_SEC)
      const heartbeatFresh = task.last_heartbeat_at
        && new Date(task.last_heartbeat_at + 'Z').getTime() > new Date(task.blocked_at + 'Z').getTime()

      if (blockedStale && !heartbeatFresh) {
        const blockedSince = task.blocked_at
        const lastHeartbeat = task.last_heartbeat_at
        log(`Blocked TTL expired for task #${task.id} (blocked_on=${blockedOn ?? 'null'}, blocked ${blockedSince}, last heartbeat ${lastHeartbeat}) — clearing blocked state`)
        this.taskDb.run(db => {
          db.prepare(`
            UPDATE tasks SET blocked_at = NULL, blocked_reason = NULL, blocked_on = NULL WHERE id = ?
          `).run(task.id)
        })
        this.audit.log('watchdog', 'blocked_ttl_expired', {
          task_id: task.id,
          agent: task.to_agent,
          blocked_on: blockedOn,
          blocked_since: blockedSince,
          last_heartbeat: lastHeartbeat,
        }, task.id)
        task.blocked_at = null
        task.blocked_reason = null
        // DO NOT return — fall through to (b), (c), (d), (e), (f)
      } else {
        await this.handleBlocked(task, result)
        return
      }
    }

    // (b) PENDING (unclaimed): nudge the assigned agent
    if (task.status === 'pending') {
      await this.handleUnclaimed(task, result)
      return
    }

    // Sprint 4: Check circuit breaker — try half_open transition if cooldown elapsed
    this.taskDb.tryHalfOpen(task.to_agent)

    // For in_progress tasks, check session liveness first
    // (c) WORKER SESSION DEAD
    if (task.worker_session_id || task.to_agent) {
      const sessionDead = this.isSessionDead(task.to_agent)
      if (sessionDead) {
        await this.handleDeadSession(task, result)
        return
      }
    }

    // (d) HEARTBEAT OVERDUE
    const hbTimeout = task.heartbeat_timeout_sec ?? SUPERVISION_DEFAULTS.heartbeat_timeout_sec
    if (task.last_heartbeat_at && this.isOverdue(task.last_heartbeat_at, hbTimeout)) {
      await this.handleHeartbeatOverdue(task, hbTimeout, result)
      return
    }

    // (e) PROGRESS OVERDUE (heartbeat ok, but no progress)
    const progTimeout = task.progress_timeout_sec ?? SUPERVISION_DEFAULTS.progress_timeout_sec
    if (task.last_progress_at && this.isOverdue(task.last_progress_at, progTimeout)) {
      await this.handleProgressOverdue(task, progTimeout, result)
      return
    }

    // (f) HEALTHY: task is fine, recompute next_check_at
    this.setNextCheck(task.id, hbTimeout)
  }

  // -------------------------------------------------------------------------
  // 3a. BLOCKED HANDLER
  // -------------------------------------------------------------------------

  private async handleBlocked(task: Task, result: ReconcileResult): Promise<void> {
    const supervisor = task.supervisor_agent ?? 'boss'
    const reason = task.blocked_reason ?? 'No reason provided'
    const msg = `BLOCKED: Task #${task.id} (${task.to_agent}) is blocked: ${reason}`

    // #615 Phase 1: dedup identical blocked_relay alerts within cooldown.
    // State changes (different reason/supervisor) re-fire immediately because
    // the payload hash differs.
    if (this.taskDb.shouldAlert(task.id, 'blocked_relay', { supervisor, reason })) {
      log(`Relaying blocked status for task #${task.id} to ${supervisor}`)

      // Nudge supervisor
      await dispatchAgentNudge(supervisor, msg)

      // Post to Telegram for visibility
      await postToGroup(`\u26a0\ufe0f ${esc(msg)}`)

      this.audit.log('watchdog', 'blocked_relay', {
        task_id: task.id,
        supervisor,
        reason,
      }, task.id)

      result.blocked_relayed++
    }

    // Re-check in 60 seconds (keep relaying until unblocked — level-triggered)
    this.setNextCheck(task.id, 60)
  }

  // -------------------------------------------------------------------------
  // 3b. DEAD SESSION HANDLER
  // -------------------------------------------------------------------------

  private async handleDeadSession(task: Task, result: ReconcileResult): Promise<void> {
    const supervisor = task.supervisor_agent ?? 'boss'
    const level = (task.escalation_level ?? 0)

    log(`Dead session detected for task #${task.id} (worker: ${task.to_agent})`)

    // Sprint 4: Record crash fault.
    // S2.1 parity: subagent tasks carry to_agent = supervisor (parent). A crashed
    // subagent must NOT charge the parent's circuit breaker — same reasoning as the
    // heartbeat overdue guard in handleHeartbeatOverdue.
    if (task.kind === 'subagent') {
      log(`Subagent task #${task.id} dead session — skipping parent fault (parent: ${task.to_agent})`)
      this.audit.log('watchdog', 'subagent_dead_session', {
        task_id: task.id,
        parent_agent: task.to_agent,
      }, task.id)
    } else {
      this.taskDb.recordFault(task.to_agent, 'crash')
    }

    // Check if an escalation task already exists for this
    if (this.escalationExists(task.id, level + 1)) {
      log(`Escalation already exists for task #${task.id} at level ${level + 1}, skipping`)
      this.setNextCheck(task.id, 120)
      return
    }

    // Create escalation task for boss
    const escalationDesc = `ESCALATION L${level + 1}: Task #${task.id} (${task.to_agent}) \u2014 worker session dead, task abandoned. Original: ${task.description}`

    this.taskDb.run(db => {
      // Create the escalation task (self-assigned to boss so trigger does not fire)
      db.prepare(`
        INSERT INTO tasks (from_agent, to_agent, description, priority, supervisor_agent)
        VALUES ('watchdog', 'boss', ?, 'urgent', 'watchdog')
      `).run(escalationDesc)

      // Update escalation level on original task
      db.prepare(`
        UPDATE tasks SET
          escalation_level = ?,
          next_check_at = datetime('now', '+120 seconds')
        WHERE id = ?
      `).run(level + 1, task.id)
    })

    // Notify boss (do NOT nudge the dead worker)
    await dispatchAgentNudge('boss', `DEAD SESSION: Task #${task.id} (${task.to_agent}) \u2014 worker session is dead. Escalation task created.`)
    await postToGroup(`\ud83d\udea8 DEAD SESSION: Task \\#${task.id} \\(${esc(task.to_agent)}\\) \u2014 worker session dead\\. Escalated to Boss\\.`)

    this.audit.log('watchdog', 'dead_session_escalation', {
      task_id: task.id,
      worker: task.to_agent,
      escalation_level: level + 1,
    }, task.id)

    result.escalated++
    result.dead_sessions++
  }

  // -------------------------------------------------------------------------
  // 3c. HEARTBEAT OVERDUE HANDLER
  // -------------------------------------------------------------------------

  private async handleHeartbeatOverdue(task: Task, timeoutSec: number, result: ReconcileResult): Promise<void> {
    // (#850 Layer 1) Terminal-status guard. The batch query excludes
    // completed/cancelled tasks, but rows are snapshotted once per cycle then
    // iterated with awaits — a task completed mid-cycle still carries a stale
    // in_progress status on the in-memory snapshot (TOCTOU race, observed on
    // #842 → L5-L8). Re-read live status by id (cheap, inside the run wrapper
    // for WAL/lease discipline). If terminal, disarm watchdog re-pickup by
    // nulling next_check_at (mirrors the #823 escalate-once-and-stop) and
    // return WITHOUT escalating.
    const live = this.taskDb.run(db =>
      db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)) as { status: string } | undefined
    if (!live || live.status === 'completed' || live.status === 'cancelled') {
      this.taskDb.run(db => db.prepare('UPDATE tasks SET next_check_at = NULL WHERE id = ?').run(task.id))
      this.audit.log('watchdog', 'heartbeat_overdue_skipped_terminal', {
        task_id: task.id,
        worker: task.to_agent,
        status: live?.status ?? 'missing',
      }, task.id)
      return
    }

    const level = (task.escalation_level ?? 0)
    const newLevel = level + 1

    log(`Heartbeat overdue for task #${task.id} (worker: ${task.to_agent}, level ${level} -> ${newLevel})`)

    // Restart-window gate (task #1134). If the worker's session just restarted,
    // silence is expected — suppress the worker-level nudge and skip recording
    // a fault (which would prematurely open the circuit). Boss escalation at
    // level >= 3 is NOT suppressed: if the restart never recovers, the TTL
    // (5 min) expires and normal alerting resumes.
    const restartWindow = isRestartWindowActive(task.to_agent)

    // Sprint 4: Record fault and check circuit breaker
    // S2.1 fix: Do NOT charge subagent heartbeat faults to the parent's circuit breaker.
    // Subagent tasks have to_agent = supervisor (parent), so faulting to_agent would
    // penalize the parent for a child's timeout.
    if (task.kind === 'subagent') {
      log(`Subagent task #${task.id} heartbeat overdue — skipping parent fault (parent: ${task.to_agent})`)
      this.audit.log('watchdog', 'subagent_heartbeat_overdue', {
        task_id: task.id,
        parent_agent: task.to_agent,
        timeout_sec: timeoutSec,
        escalation_level: newLevel,
      }, task.id)
    } else if (restartWindow.active) {
      // Suppress fault recording during a restart window. Without this, three
      // watchdog ticks across a 90-300s restart can climb the fault counter to
      // 3 and trip the circuit breaker on a healthy agent.
      log(`Fault recording for ${task.to_agent} task #${task.id} suppressed — restart window active (flag age ${restartWindow.ageSec?.toFixed(1)}s)`)
      this.audit.log('watchdog', 'restart_window_suppressed', {
        task_id: task.id,
        agent: task.to_agent,
        flag_age_sec: restartWindow.ageSec,
        suppressed: 'fault_record',
        timeout_sec: timeoutSec,
      }, task.id)
    } else {
      const faultResult = this.taskDb.recordFault(task.to_agent, 'timeout')
      if (faultResult.circuit_state === 'open') {
        // #615 Phase 1: dedup circuit_open alerts per agent. Hash on agent only
        // (not fault_count) so once OPEN, alerts only re-fire after the cooldown
        // window or after circuit closes/recovers.
        if (this.taskDb.shouldAlert(0, `circuit_open:${task.to_agent}`, { agent: task.to_agent })) {
          log(`Circuit OPEN for ${task.to_agent} (${faultResult.fault_count} faults). Alerting boss.`)
          await this.taskDb.run(async () => {}) // no-op, just for type
          await dispatchAgentNudge('boss', `Circuit OPEN for ${task.to_agent}: ${faultResult.fault_count} consecutive faults. Agent degraded.`, { urgency: 'urgent' })
          await postToGroup(`\u26a0\ufe0f Circuit breaker OPEN for ${esc(task.to_agent)} \\- ${faultResult.fault_count} faults`)
        }
      }
    }

    // (#850 Layer 2) Dedup the heartbeat-overdue alerts within the shouldAlert
    // cooldown, mirroring the blocked_relay path (#615 Phase 1). The payload
    // includes `level`, so a genuine level transition re-fires immediately
    // (state-change semantics) while a stuck-at-same-level loop is suppressed
    // for 1800s. Wraps BOTH the boss escalation and the worker nudge.
    const hbAlertOk = this.taskDb.shouldAlert(task.id, 'heartbeat_overdue', { agent: task.to_agent, level: newLevel })

    if (newLevel >= 3) {
      // Escalate to boss (intentionally NOT gated by restart window — if a
      // restart genuinely never recovers, the level-3 page is our last line of
      // visibility on the agent and must still fire).
      if (hbAlertOk) {
        await this.escalateToBoss(task, newLevel, `heartbeat overdue (${timeoutSec}s timeout, level ${newLevel})`)
        result.escalated++
      }
    } else if (restartWindow.active) {
      // Suppress the worker-facing nudge during the restart window. We still
      // bump escalation_level / next_check_at below so a never-recovering
      // restart will eventually hit level 3 and escalate to boss.
      log(`Heartbeat-overdue nudge to ${task.to_agent} (task #${task.id}) suppressed — restart window active`)
      this.audit.log('watchdog', 'restart_window_suppressed', {
        task_id: task.id,
        agent: task.to_agent,
        flag_age_sec: restartWindow.ageSec,
        suppressed: 'heartbeat_overdue_nudge',
        timeout_sec: timeoutSec,
        escalation_level: newLevel,
      }, task.id)
    } else if (hbAlertOk) {
      // Nudge the worker (gated by shouldAlert — see #850 Layer 2 above)
      const msg = `Heartbeat overdue: Task #${task.id} has not sent a heartbeat in ${timeoutSec}s. Send a write_status update. (escalation level ${newLevel}/3)`
      await dispatchAgentNudge(task.to_agent, msg)
      result.nudged++
    }

    // Increment escalation level and set next check
    this.taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          escalation_level = ?,
          nudge_count = nudge_count + 1,
          next_check_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(newLevel, timeoutSec, task.id)
    })

    this.audit.log('watchdog', newLevel >= 3 ? 'heartbeat_escalation' : 'heartbeat_nudge', {
      task_id: task.id,
      worker: task.to_agent,
      escalation_level: newLevel,
      timeout_sec: timeoutSec,
    }, task.id)
  }

  // -------------------------------------------------------------------------
  // 3d. PROGRESS OVERDUE HANDLER
  // -------------------------------------------------------------------------

  private async handleProgressOverdue(task: Task, timeoutSec: number, result: ReconcileResult): Promise<void> {
    const supervisor = task.supervisor_agent ?? 'boss'
    const level = (task.escalation_level ?? 0)
    const newLevel = level + 1

    log(`Progress overdue for task #${task.id} (worker: ${task.to_agent}, supervisor: ${supervisor})`)

    const msg = `Progress overdue: Task #${task.id} (${task.to_agent}) \u2014 worker is alive but no progress in ${timeoutSec}s. (escalation level ${newLevel})`

    // Nudge the supervisor
    await dispatchAgentNudge(supervisor, msg)

    // Also nudge the worker
    await dispatchAgentNudge(task.to_agent, `Progress check: Task #${task.id} \u2014 no progress update in ${timeoutSec}s. Send write_status with progress=true.`)

    // Update escalation level
    this.taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          escalation_level = ?,
          nudge_count = nudge_count + 1,
          next_check_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(newLevel, Math.floor(timeoutSec / 2), task.id)
    })

    this.audit.log('watchdog', 'progress_overdue', {
      task_id: task.id,
      worker: task.to_agent,
      supervisor,
      escalation_level: newLevel,
      timeout_sec: timeoutSec,
    }, task.id)

    result.nudged++
  }

  // -------------------------------------------------------------------------
  // 3e. UNCLAIMED TASK HANDLER
  // -------------------------------------------------------------------------

  private async handleUnclaimed(task: Task, result: ReconcileResult): Promise<void> {
    // Backlog/unassigned tasks (migration 0007: to_agent nullable) have nobody
    // to nudge. Skip cleanly rather than passing null into dispatchAgentNudge,
    // which would crash resolveSession (#832).
    if (!task.to_agent) {
      log(`Unclaimed task #${task.id} has no assignee — skipping nudge`)
      return
    }

    const level = (task.escalation_level ?? 0)
    const newLevel = level + 1

    log(`Unclaimed task #${task.id} assigned to ${task.to_agent} (level ${newLevel})`)

    const msg = `Reminder: Task #${task.id} is pending and assigned to you: ${task.description}`
    await dispatchAgentNudge(task.to_agent, msg)

    // Update escalation level and next_check_at
    this.taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          escalation_level = ?,
          nudge_count = nudge_count + 1,
          next_check_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(newLevel, UNCLAIMED_CHECK_SEC, task.id)
    })

    this.audit.log('watchdog', 'unclaimed_nudge', {
      task_id: task.id,
      worker: task.to_agent,
      escalation_level: newLevel,
    }, task.id)

    result.nudged++

    // If repeatedly unclaimed, escalate to boss
    if (newLevel >= 3) {
      await this.escalateToBoss(task, newLevel, `unclaimed for ${newLevel} check cycles`)
      result.escalated++
    }
  }

  // -------------------------------------------------------------------------
  // Check for unclaimed tasks without next_check_at set
  // -------------------------------------------------------------------------

  private async checkUnclaimedTasks(result: ReconcileResult): Promise<void> {
    const unclaimed = this.taskDb.run(db =>
      db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'pending'
        AND next_check_at IS NULL
        AND created_at < datetime('now', '-' || ? || ' seconds')
        AND description NOT LIKE 'ESCALATION%'
      `).all(UNCLAIMED_CHECK_SEC) as Task[]
    )

    for (const task of unclaimed) {
      result.checked++
      try {
        await this.handleUnclaimed(task, result)
      } catch (err) {
        logError(`Failed to handle unclaimed task #${task.id}`, err)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. IDEMPOTENT ESCALATION
  // -------------------------------------------------------------------------

  /**
   * Create an escalation task for boss, but only if one does not already exist.
   */
  private async escalateToBoss(task: Task, level: number, reason: string): Promise<void> {
    // CRITICAL: Never escalate an escalation task (prevents infinite cascade)
    if (task.description.startsWith('ESCALATION')) {
      log(`Refusing to escalate task #${task.id} — it is itself an escalation task. Completing it instead.`)
      this.taskDb.run(db => {
        db.prepare("UPDATE tasks SET status = 'completed', result = 'Auto-closed: escalation tasks are not re-escalatable', completed_at = datetime('now'), next_check_at = NULL WHERE id = ?").run(task.id)
      })
      return
    }

    if (this.escalationExists(task.id, level)) {
      log(`Escalation for task #${task.id} at level ${level} already exists, skipping`)
      return
    }

    const escalationDesc = `ESCALATION L${level}: Task #${task.id} (${task.to_agent}) \u2014 ${reason}. Original: ${task.description}`

    this.taskDb.run(db => {
      db.prepare(`
        INSERT INTO tasks (from_agent, to_agent, description, priority, supervisor_agent)
        VALUES ('watchdog', 'boss', ?, 'urgent', 'watchdog')
      `).run(escalationDesc)
    })

    await dispatchAgentNudge('boss', `Escalation L${level}: Task #${task.id} (${task.to_agent}) \u2014 ${reason}`)
    await postToGroup(`\ud83d\udea8 Escalation L${level}: Task \\#${task.id} \\(${esc(task.to_agent)}\\) \\- ${esc(reason)}`)

    this.audit.log('watchdog', 'escalation_created', {
      task_id: task.id,
      level,
      reason,
      worker: task.to_agent,
    }, task.id)
  }

  /**
   * Check if an escalation task already exists for a given task_id.
   */
  private escalationExists(taskId: number, _level: number): boolean {
    return this.taskDb.run(db => {
      const row = db.prepare(`
        SELECT id FROM tasks
        WHERE description LIKE 'ESCALATION%'
        AND description LIKE ?
        AND status != 'completed'
        LIMIT 1
      `).get(`%#${taskId}%`)
      return row != null
    })
  }

  // -------------------------------------------------------------------------
  // 5. SESSION HEARTBEAT CHECKS
  // -------------------------------------------------------------------------

  /**
   * Check all agent sessions for liveness.
   * Marks stale sessions as 'dead' and verifies via tmux.
   */
  async checkAgentSessions(): Promise<void> {
    const timeoutSec = this.config.sessionTimeoutSec

    // Find stale sessions
    const staleSessions = this.taskDb.run(db =>
      db.prepare(`
        SELECT * FROM agent_sessions
        WHERE last_seen_at < datetime('now', '-' || ? || ' seconds')
        AND state = 'alive'
      `).all(timeoutSec) as Array<{
        agent: string
        session_id: string
        last_seen_at: string
        state: string
      }>
    )

    for (const session of staleSessions) {
      // Verify via tmux
      const tmuxSessionName = AGENT_SESSIONS[session.agent] ?? session.session_id
      const isAlive = await this.checkTmuxSession(tmuxSessionName)

      if (isAlive) {
        // Tmux says alive — reconcile by updating last_seen_at
        log(`Session ${session.agent} (${tmuxSessionName}) \u2014 tmux says alive, reconciling last_seen_at`)
        this.taskDb.run(db => {
          db.prepare(`
            UPDATE agent_sessions SET last_seen_at = datetime('now')
            WHERE agent = ?
          `).run(session.agent)
        })
      } else {
        // Confirmed dead — Sprint 4: record crash fault and clear stale state
        log(`Session ${session.agent} (${tmuxSessionName}) \u2014 confirmed DEAD`)
        this.taskDb.run(db => {
          db.prepare(`
            UPDATE agent_sessions SET state = 'dead'
            WHERE agent = ?
          `).run(session.agent)
        })
        this.taskDb.recordFault(session.agent, 'crash')

        // Clear stale heartbeat timing so watchdog picks up tasks immediately
        this.taskDb.run(db => {
          db.prepare(`
            UPDATE tasks SET next_check_at = datetime('now')
            WHERE to_agent = ? AND status = 'in_progress'
          `).run(session.agent)
        })

        await postToGroup(`\u26a0\ufe0f Agent ${esc(session.agent)} session \\(${esc(tmuxSessionName)}\\) is dead\\.`)
        this.audit.log('watchdog', 'session_dead', {
          agent: session.agent,
          session: tmuxSessionName,
        })
      }
    }

    // Also check known agent sessions that may not be in the DB
    for (const [agent, tmuxSession] of Object.entries(AGENT_SESSIONS)) {
      const inDb = this.taskDb.run(db =>
        db.prepare('SELECT agent FROM agent_sessions WHERE agent = ?').get(agent)
      )
      if (!inDb) {
        // Not tracked yet — check tmux and register
        const isAlive = await this.checkTmuxSession(tmuxSession)
        this.taskDb.run(db => {
          db.prepare(`
            INSERT INTO agent_sessions (agent, session_id, last_seen_at, state)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(agent) DO UPDATE SET
              session_id = excluded.session_id,
              last_seen_at = datetime('now'),
              state = excluded.state
          `).run(agent, tmuxSession, isAlive ? 'alive' : 'dead')
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Check if a tmux session exists (is alive).
   */
  private async checkTmuxSession(sessionName: string): Promise<boolean> {
    try {
      const proc = Bun.spawnSync([TMUX_PATH, 'has-session', '-t', sessionName], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return proc.exitCode === 0
    } catch {
      return false
    }
  }

  /**
   * Check if a given timestamp + timeout is overdue (i.e., in the past).
   */
  private isOverdue(timestamp: string, timeoutSec: number): boolean {
    const ts = new Date(timestamp + 'Z').getTime()
    const now = Date.now()
    return (now - ts) > (timeoutSec * 1000)
  }

  /**
   * Check if a worker's session is dead (by DB state).
   */
  private isSessionDead(agent: string): boolean {
    const session = this.taskDb.run(db =>
      db.prepare('SELECT state FROM agent_sessions WHERE agent = ?').get(agent) as { state: string } | null
    )
    if (session && session.state === 'dead') {
      return true
    }
    return false
  }

  /**
   * Set next_check_at for a task.
   */
  private setNextCheck(taskId: number, delaySec: number): void {
    this.taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET next_check_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(delaySec, taskId)
    })
  }

  // -------------------------------------------------------------------------
  // 6. DECISION LIFECYCLE MONITORING
  // -------------------------------------------------------------------------

  /**
   * Monitor open decisions for three conditions:
   *   (a) Expire stale decisions whose deadline has passed
   *   (b) Nudge agents when a decision has been 'open' for > 10 min with no positions
   *   (c) Notify Boss when all expected positions are in (ready to finalize)
   */
  async monitorDecisions(result: ReconcileResult): Promise<void> {
    const mem = new MemoryDB(this.taskDb)
    const dec = new DecisionDB(this.taskDb, mem)

    // (a) Expire stale decisions
    const expiredCount = expireStaleDecisions(dec)
    if (expiredCount > 0) {
      result.decisions_expired += expiredCount
      log(`Expired ${expiredCount} stale decision(s)`)

      // Post Telegram notifications for each newly-expired decision
      // Re-fetch expired decisions from last minute to notify
      const recentExpired = this.taskDb.run(db =>
        db.prepare(`
          SELECT * FROM decisions
          WHERE status = 'expired'
          AND finalized_at >= datetime('now', '-60 seconds')
          ORDER BY finalized_at DESC
        `).all() as Decision[]
      )
      for (const d of recentExpired) {
        await postToGroup(formatDecisionExpired(d))
        this.audit.log('watchdog', 'decision_expired', {
          decision_id: d.id,
          title: d.title,
        })
      }
    }

    // (b) Nudge for stale open decisions (open > 10 min, no positions)
    // getOpenDecisions() already filters to status IN ('open','positions','critique'),
    // but we also guard explicitly here to ensure finalized/expired/cancelled decisions
    // are never nudged even if the in-memory list is stale.
    const TERMINAL_STATUSES_SET = new Set(['finalized', 'expired', 'cancelled'])
    const openDecisions = dec.getOpenDecisions().filter(d => !TERMINAL_STATUSES_SET.has(d.status))
    const now = Date.now()
    const TEN_MINUTES_MS = 10 * 60 * 1000

    // SQLite datetime('now') stores as 'YYYY-MM-DD HH:MM:SS' (no T, no Z).
    // We must match that format for string comparison in audit queries.
    const sqliteDatetime = (ms: number): string => {
      const d = new Date(ms)
      return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
    }

    // In-cycle tracking Set to prevent double-nudging the same decision within
    // a single watchdog cycle (guards against audit write latency edge cases).
    const nudgedThisCycle = new Set<number>()
    const notifiedThisCycle = new Set<number>()

    for (const d of openDecisions) {
      // Guard: only nudge decisions in 'open' status (no positions submitted yet).
      // Skip finalized, expired, cancelled, or decisions that already have positions.
      if (d.status !== 'open') continue

      const createdAt = new Date(d.created_at.replace(' ', 'T') + 'Z').getTime()
      const ageMs = now - createdAt
      if (ageMs < TEN_MINUTES_MS) continue

      // Skip if already nudged this cycle
      if (nudgedThisCycle.has(d.id)) continue

      // Check if we already nudged for this decision recently (within last 10 min).
      // Use a high limit to ensure we don't miss prior nudge entries in busy systems.
      const recentNudge = this.audit.query({
        agent: 'watchdog',
        action: 'decision_position_nudge',
        since: sqliteDatetime(now - TEN_MINUTES_MS),
        limit: 500,
      }).find(e => {
        try {
          const detail = JSON.parse(e.detail ?? '{}')
          return detail.decision_id === d.id
        } catch { return false }
      })
      if (recentNudge) continue

      // Nudge all worker agents to submit positions
      const agentsToNudge = [...WORKER_AGENTS]
      const nudgeMsg = `Decision #${d.id} "${d.title}" has been open for ${Math.floor(ageMs / 60000)} min with no positions. Please submit your position.`
      for (const agent of agentsToNudge) {
        await dispatchAgentNudge(agent, nudgeMsg)
      }

      this.audit.log('watchdog', 'decision_position_nudge', {
        decision_id: d.id,
        title: d.title,
        agents_nudged: agentsToNudge,
        age_min: Math.floor(ageMs / 60000),
      })

      nudgedThisCycle.add(d.id)
      result.decisions_nudged++
      log(`Nudged agents for decision #${d.id} (open ${Math.floor(ageMs / 60000)} min, no positions)`)
    }

    // (c) Detect decisions ready to finalize
    // A decision in 'positions' or 'critique' status where >= 2 distinct agents
    // have submitted positions is considered ready for Boss to finalize.
    const POSITION_QUORUM = 2

    for (const d of openDecisions) {
      // Guard: only check decisions in 'positions' or 'critique' status.
      // Finalized/expired/cancelled decisions are already excluded from openDecisions.
      if (d.status !== 'positions' && d.status !== 'critique') continue

      // Skip if already notified this cycle
      if (notifiedThisCycle.has(d.id)) continue

      // Get full detail to check positions
      const detail = dec.getDecision(d.id)
      if (!detail) continue

      // Re-verify the decision is still in an open status (handles TOCTOU race)
      if (TERMINAL_STATUSES_SET.has(detail.status)) continue

      const distinctAgents = new Set(detail.positions.map(p => p.agent))
      if (distinctAgents.size < POSITION_QUORUM) continue

      // Check if we already notified Boss for this decision recently (within last 10 min).
      // Use a high limit to ensure we don't miss prior notify entries in busy systems.
      const recentNotify = this.audit.query({
        agent: 'watchdog',
        action: 'decision_ready_to_finalize',
        since: sqliteDatetime(now - TEN_MINUTES_MS),
        limit: 500,
      }).find(e => {
        try {
          const detail = JSON.parse(e.detail ?? '{}')
          return detail.decision_id === d.id
        } catch { return false }
      })
      if (recentNotify) continue

      // Notify Boss
      const readyMsg = `Decision #${d.id} "${d.title}" has ${distinctAgents.size} position(s) from [${[...distinctAgents].join(', ')}] and is ready to finalize.`
      await dispatchAgentNudge(BOSS_AGENT, readyMsg)
      await postToGroup(`\u2705 Decision \\#${d.id} ready to finalize: "${esc(d.title)}" \\- ${distinctAgents.size} positions in\\.`)

      this.audit.log('watchdog', 'decision_ready_to_finalize', {
        decision_id: d.id,
        title: d.title,
        position_count: distinctAgents.size,
        agents: [...distinctAgents],
      })

      notifiedThisCycle.add(d.id)
      result.decisions_ready++
      log(`Decision #${d.id} is ready to finalize (${distinctAgents.size} positions)`)
    }
  }

  // -------------------------------------------------------------------------
  // 7. IDLE AGENT BOARD CHECK NUDGING
  // -------------------------------------------------------------------------

  /**
   * Idle detection thresholds (in milliseconds).
   */
  static readonly IDLE_THRESHOLD_MS = 15 * 60 * 1000   // 15 minutes
  static readonly NUDGE_COOLDOWN_MS = 30 * 60 * 1000   // 30 minutes

  /**
   * Actions that count as agent "activity" for idle detection.
   */
  private static readonly ACTIVITY_ACTIONS = [
    'task_claimed',
    'status_written',
    'decision_position_submitted',
    'decision_critique_submitted',
    'note_added',
    'task_completed',
  ]

  /**
   * Monitor idle agents and nudge them if there is pending work.
   *
   * For each known agent:
   *   (a) Skip if agent has active in_progress tasks (they are busy)
   *   (b) Check last activity timestamp from audit_log
   *   (c) If idle > 15 min, check for pending tasks or open decisions
   *   (d) If there is pending work AND cooldown has elapsed, nudge agent
   */
  async monitorIdleAgents(result: ReconcileResult): Promise<void> {
    const now = Date.now()

    for (const agent of TEAM_AGENTS) {
      try {
        // (a) Skip agents with active in_progress tasks
        const activeTasks = this.taskDb.run(db =>
          db.prepare(`
            SELECT COUNT(*) as cnt FROM tasks
            WHERE to_agent = ? AND status = 'in_progress'
          `).get(agent) as { cnt: number }
        )
        if (activeTasks.cnt > 0) continue

        // (b) Check last activity timestamp from audit_log
        const lastActivity = this.taskDb.run(db =>
          db.prepare(`
            SELECT MAX(created_at) as last_at FROM audit_log
            WHERE agent = ? AND action IN (${TaskReconciler.ACTIVITY_ACTIONS.map(() => '?').join(',')})
          `).get(agent, ...TaskReconciler.ACTIVITY_ACTIONS) as { last_at: string | null }
        )

        if (!lastActivity.last_at) continue  // No activity recorded at all — skip (agent never used the system)

        const lastAtMs = new Date(lastActivity.last_at + 'Z').getTime()
        const idleMs = now - lastAtMs
        if (idleMs < TaskReconciler.IDLE_THRESHOLD_MS) continue

        // (c) Check for pending work: tasks assigned to this agent + open decisions
        const pendingTasks = this.taskDb.run(db =>
          db.prepare(`
            SELECT COUNT(*) as cnt FROM tasks
            WHERE to_agent = ? AND status = 'pending'
          `).get(agent) as { cnt: number }
        )

        const openDecisions = this.taskDb.run(db =>
          db.prepare(`
            SELECT COUNT(*) as cnt FROM decisions
            WHERE status IN ('open', 'positions', 'critique')
            AND id NOT IN (
              SELECT decision_id FROM decision_positions WHERE agent = ?
            )
          `).get(agent) as { cnt: number }
        )

        if (pendingTasks.cnt === 0 && openDecisions.cnt === 0) continue

        // (d) Check cooldown: was this agent nudged within the last 30 minutes?
        const sqliteDatetime = (ms: number): string => {
          const d = new Date(ms)
          return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
        }

        const recentNudge = this.audit.query({
          agent: 'watchdog',
          action: 'idle_board_nudge',
          since: sqliteDatetime(now - TaskReconciler.NUDGE_COOLDOWN_MS),
          limit: 50,
        }).find(e => {
          try {
            const detail = JSON.parse(e.detail ?? '{}')
            return detail.agent === agent
          } catch { return false }
        })

        if (recentNudge) continue

        // (e) Cross-nudge guard: if the agent has no pending tasks and was
        // already nudged by decision monitoring (decision_position_nudge) within
        // the last 60 seconds, skip the idle nudge to avoid double-nudging.
        // When the agent DOES have pending tasks, the idle nudge covers different
        // work (tasks), so it should still fire.
        if (pendingTasks.cnt === 0) {
          const CROSS_NUDGE_WINDOW_MS = 60 * 1000
          const recentDecisionNudge = this.audit.query({
            agent: 'watchdog',
            action: 'decision_position_nudge',
            since: sqliteDatetime(now - CROSS_NUDGE_WINDOW_MS),
            limit: 50,
          }).find(e => {
            try {
              const detail = JSON.parse(e.detail ?? '{}')
              return Array.isArray(detail.agents_nudged) && detail.agents_nudged.includes(agent)
            } catch { return false }
          })

          if (recentDecisionNudge) continue
        }

        // Build nudge message with board summary
        const parts: string[] = []
        if (pendingTasks.cnt > 0) {
          parts.push(`${pendingTasks.cnt} pending task(s)`)
        }
        if (openDecisions.cnt > 0) {
          parts.push(`${openDecisions.cnt} open decision(s) awaiting input`)
        }
        const summary = parts.join(' and ')
        const nudgeMsg = `Board check: You have ${summary}. Run list_tasks and list_decisions to catch up.`

        await dispatchAgentNudge(agent, nudgeMsg)

        this.audit.log('watchdog', 'idle_board_nudge', {
          agent,
          idle_min: Math.floor(idleMs / 60000),
          pending_tasks: pendingTasks.cnt,
          open_decisions: openDecisions.cnt,
        })

        result.idle_nudges++
        log(`Idle nudge sent to ${agent} (idle ${Math.floor(idleMs / 60000)} min): ${summary}`)
      } catch (err) {
        logError(`Failed to check idle status for ${agent}`, err)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. CIRCUIT BREAKER RECOVERY SWEEP
  // -------------------------------------------------------------------------

  /**
   * Standalone sweep: find all circuits that are OPEN with expired cooldowns
   * and transition them to HALF_OPEN. Runs every cycle, independent of
   * reconcileTask (which only fires for in_progress tasks).
   *
   * Without this, all circuits can stay OPEN with no in_progress tasks to
   * trigger tryHalfOpen — deadlocking delegate_task.
   */
  private _circuitRecoveryNotified = new Set<string>()

  async recoverExpiredCircuits(result: ReconcileResult): Promise<void> {
    const expiredOpen = this.taskDb.run(db =>
      db.prepare(`
        SELECT agent, circuit_state, cooldown_until
        FROM agent_sessions
        WHERE circuit_state = 'open'
          AND cooldown_until IS NOT NULL
          AND cooldown_until < datetime('now')
      `).all() as Array<{ agent: string; circuit_state: string; cooldown_until: string }>
    )

    for (const row of expiredOpen) {
      // Prevent flood: skip if agent is already HALF_OPEN (race with another path)
      const current = this.taskDb.getCircuitState(row.agent)
      if (!current || current.circuit_state !== 'open') continue

      // Enforce one probe per HALF_OPEN agent: check for existing in_progress tasks
      const existingProbe = this.taskDb.run(db =>
        db.prepare(`
          SELECT id FROM tasks
          WHERE to_agent = ? AND status = 'in_progress'
          LIMIT 1
        `).get(row.agent) as { id: number } | null
      )

      const transitioned = this.taskDb.tryHalfOpen(row.agent)
      if (!transitioned) continue

      result.circuits_recovered++
      log(`Circuit recovery: ${row.agent} OPEN→HALF_OPEN (cooldown expired ${row.cooldown_until})`)

      // Debounce audit+telegram: emit once per agent per watchdog lifetime
      if (!this._circuitRecoveryNotified.has(row.agent)) {
        this._circuitRecoveryNotified.add(row.agent)
        this.audit.log('watchdog', 'circuit_recovery', {
          agent: row.agent,
          cooldown_expired: row.cooldown_until,
          had_probe_task: !!existingProbe,
        })
        await postToGroup(`\u26a1 Circuit recovery: ${esc(row.agent)} moved OPEN\\u2192HALF\\_OPEN \\(cooldown expired\\)`)
      }
    }

    // Clear debounce entries for agents no longer in recovery (circuit closed)
    for (const agent of this._circuitRecoveryNotified) {
      const state = this.taskDb.getCircuitState(agent)
      if (!state || state.circuit_state === 'closed') {
        this._circuitRecoveryNotified.delete(agent)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8b. OPERATOR-INTENT FEATURE FLAG WARNING
  // -------------------------------------------------------------------------

  /**
   * Surface required feature flags that the operator has explicitly disabled.
   * The startup auto-enable loop in db.ts no longer flips 0→1 (that would
   * silently override operator intent), so the supervisor must make this
   * visible. Same pattern as recoverExpiredCircuits: log + audit row +
   * telegram, debounced once per flag per watchdog lifetime.
   */
  private _operatorDisabledNotified = new Set<string>()

  async warnOperatorDisabledFlags(): Promise<void> {
    const disabled = this.taskDb.operatorDisabledFlags
    if (!disabled || disabled.length === 0) return

    for (const flag of disabled) {
      // Re-check current DB state — operator may have re-enabled mid-run.
      if (this.taskDb.isFeatureEnabled(flag)) {
        this._operatorDisabledNotified.delete(flag)
        continue
      }
      if (this._operatorDisabledNotified.has(flag)) continue
      this._operatorDisabledNotified.add(flag)

      log(`Operator-disabled required flag detected: ${flag} (enabled=0). Respecting operator intent; not auto-enabling.`)
      this.audit.log('watchdog', 'operator_disabled_flag', {
        flag,
        enabled: 0,
        action: 'respected_operator_intent',
        note: 'startup auto-enable disabled — operator must re-enable explicitly',
      })
      await postToGroup(`⚠️ *Operator\-disabled required flag*: \`${esc(flag)}\` is set to 0\. Watchdog is respecting operator intent and NOT auto\-enabling\. Re\-enable explicitly via \`setFeatureFlag\` if this is unintended\.`)
    }
  }

  // -------------------------------------------------------------------------
  // 9. CONSOLIDATION SCHEDULER
  // -------------------------------------------------------------------------

  private _lastConsolidationAttemptMs = 0

  /**
   * Run memory consolidation if enough time has elapsed since the last attempt.
   * Replaces the snoopy-bot.ts standalone loop — consolidation is maintenance
   * work that belongs in the always-on watchdog, not an interactive agent.
   */
  async runConsolidationIfDue(): Promise<void> {
    const now = Date.now()
    if (now - this._lastConsolidationAttemptMs < CONSOLIDATION_CHECK_INTERVAL_MS) return

    this._lastConsolidationAttemptMs = now

    const mem = new MemoryDB(this.taskDb)
    const consolidator = new MemoryConsolidator(mem, this.taskDb, CONSOLIDATION_DRY_RUN)

    const triggers = consolidator.checkTriggers()
    const reasons: string[] = []
    if (triggers.time) reasons.push('time')
    if (triggers.volume) reasons.push('volume')
    if (triggers.idle) reasons.push('idle')

    if (reasons.length === 0 || !triggers.lock) return

    const triggerReason = `watchdog-auto: ${reasons.join('+')}`
    log(`Consolidation triggered: ${triggerReason}`)

    const result = await consolidator.run(triggerReason)
    log(`Consolidation complete: ${result.summary}`)

    // Update last-run observability in consolidation_runs (already done by consolidator.run)
    this.audit.log('watchdog', 'consolidation_run', {
      run_id: result.runId,
      mutations: result.mutations,
      dry_run: result.dryRun,
      trigger: triggerReason,
      duration_ms: result.durationMs,
    })

    if (result.mutations > 0) {
      await postToGroup(`\ud83e\udde0 Consolidation: ${result.mutations} mutation\\(s\\), ${result.durationMs}ms`)
    }
  }

  // -------------------------------------------------------------------------
  // 10. PERSISTENT LOOP
  // -------------------------------------------------------------------------

  /**
   * Main entry point: run the watchdog as a persistent loop.
   * Acquires or renews lease, reconciles tasks, checks sessions, then sleeps.
   */
  async run(): Promise<never> {
    log(`Starting durable watchdog loop (cadence=${this.config.cadenceSec}s, lease_timeout=${this.config.leaseTimeoutSec}s, session_timeout=${this.config.sessionTimeoutSec}s)`)
    log(`Holder ID: ${this.holderId}, PID: ${this.pid}`)

    while (true) {
      try {
        // Step 1: Acquire or renew lease
        const hasLease = this.acquireOrRenewLease()
        if (!hasLease) {
          log('Could not acquire lease, sleeping...')
          await Bun.sleep(this.config.cadenceSec * 1000)
          continue
        }

        // Step 1a: Recover expired open circuits (independent of in_progress tasks)
        const reconcileResult: ReconcileResult = {
          checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
          dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
          decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0,
        }
        try {
          await this.recoverExpiredCircuits(reconcileResult)
        } catch (err) {
          logError('Circuit recovery sweep failed', err)
        }

        // Step 1b: Warn loudly if operator has explicitly disabled required flags.
        // Counterpart to db.ts startup change that no longer auto-flips 0→1.
        try {
          await this.warnOperatorDisabledFlags()
        } catch (err) {
          logError('Operator-disabled flag warning failed', err)
        }

        // Step 2: Reconcile due tasks
        const taskResult = await this.reconcileDueTasks()
        // Merge task reconciliation counts into the cycle result
        reconcileResult.checked = taskResult.checked
        reconcileResult.nudged = taskResult.nudged
        reconcileResult.escalated = taskResult.escalated
        reconcileResult.blocked_relayed = taskResult.blocked_relayed
        reconcileResult.dead_sessions = taskResult.dead_sessions

        // Step 3: Check agent sessions
        await this.checkAgentSessions()

        // Step 3a: Monitor decision lifecycle
        try {
          await this.monitorDecisions(reconcileResult)
        } catch (err) {
          logError('Decision monitoring failed', err)
        }

        // Step 3b: Monitor idle agents and nudge for board check
        try {
          await this.monitorIdleAgents(reconcileResult)
        } catch (err) {
          logError('Idle agent monitoring failed', err)
        }

        // Step 3c: Check debrief gates
        try {
          const mem = new MemoryDB(this.taskDb)
          const dec = new DecisionDB(this.taskDb, mem)
          const debriefResult = await checkAndRunDebrief(this.taskDb, mem, dec, this.audit)
          if (debriefResult) {
            log(`Debrief completed: run #${debriefResult.runId}, decision #${debriefResult.decisionId}, ${debriefResult.tasksReviewed} tasks reviewed`)
          }
        } catch (err) {
          logError('Debrief check failed', err)
        }

        // Step 3d: Scheduled memory consolidation (replaces snoopy-bot.ts loop)
        try {
          await this.runConsolidationIfDue()
        } catch (err) {
          logError('Consolidation scheduler failed', err)
        }

        // Log cycle summary
        const r = reconcileResult
        const hasActivity = r.checked > 0 || r.nudged > 0 || r.escalated > 0 || r.blocked_relayed > 0 || r.dead_sessions > 0 || r.decisions_expired > 0 || r.decisions_nudged > 0 || r.decisions_ready > 0 || r.idle_nudges > 0 || r.circuits_recovered > 0
        if (hasActivity) {
          log(`Cycle complete: checked=${r.checked} nudged=${r.nudged} escalated=${r.escalated} blocked_relayed=${r.blocked_relayed} dead_sessions=${r.dead_sessions} decisions_expired=${r.decisions_expired} decisions_nudged=${r.decisions_nudged} decisions_ready=${r.decisions_ready} idle_nudges=${r.idle_nudges} circuits_recovered=${r.circuits_recovered}`)
        }
      } catch (err) {
        logError('Cycle error', err)
      }

      // Step 4: Sleep until next cycle
      await Bun.sleep(this.config.cadenceSec * 1000)
    }
  }
}

// ---------------------------------------------------------------------------
// Main: Run as persistent process when invoked directly
// ---------------------------------------------------------------------------

const isMainScript = process.argv[1]?.endsWith('watchdog.ts')
if (isMainScript) {
  const taskDb = new TaskDB(DB_PATH)
  const audit = new AuditLog(taskDb)

  // Wire nudge debounce module so logDelivered() can emit nudge_sent +
  // agent_nudged audit rows. Mirrors server.ts boot. See #921.
  configureNudgeDebounce(taskDb, audit)

  const reconciler = new TaskReconciler(taskDb, audit, {
    cadenceSec: WATCHDOG_CADENCE_SEC,
    sessionTimeoutSec: SESSION_TIMEOUT_SEC,
    leaseTimeoutSec: 120,
  })

  log('Watchdog process starting...')

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down...')
    taskDb.close()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down...')
    taskDb.close()
    process.exit(0)
  })

  reconciler.run().catch(err => {
    logError('Fatal error in watchdog loop', err)
    taskDb.close()
    process.exit(1)
  })
}
