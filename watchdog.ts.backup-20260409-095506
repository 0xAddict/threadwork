#!/usr/bin/env bun
// watchdog.ts — Durable controller loop with session-aware escalation
//
// Sprint 3: Rewritten from one-shot cron to persistent singleton loop.
// Acquires a watchdog lease, reconciles due tasks every WATCHDOG_CADENCE_SEC,
// checks agent sessions for liveness, and handles escalation idempotently.

import { TaskDB, type Task } from './db'
import { MemoryDB } from './memory'
import { DecisionDB } from './decision'
import { AuditLog } from './audit'
import { nudgeAgent } from './nudge'
import { postToGroup } from './notify'
import { checkAndRunDebrief } from './debrief'
import {
  DB_PATH,
  AGENT_SESSIONS,
  TMUX_PATH,
  WATCHDOG_CADENCE_SEC,
  UNCLAIMED_CHECK_SEC,
  SESSION_TIMEOUT_SEC,
  SUPERVISION_DEFAULTS,
} from './config'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  checked: number
  nudged: number
  escalated: number
  blocked_relayed: number
  dead_sessions: number
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
    // (a) BLOCKED: relay to supervisor immediately
    if (task.blocked_at) {
      await this.handleBlocked(task, result)
      return
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

    log(`Relaying blocked status for task #${task.id} to ${supervisor}`)

    // Nudge supervisor
    await nudgeAgent(supervisor, msg)

    // Post to Telegram for visibility
    await postToGroup(`\u26a0\ufe0f ${msg}`)

    this.audit.log('watchdog', 'blocked_relay', {
      task_id: task.id,
      supervisor,
      reason,
    }, task.id)

    // Re-check in 60 seconds (keep relaying until unblocked — level-triggered)
    this.setNextCheck(task.id, 60)

    result.blocked_relayed++
  }

  // -------------------------------------------------------------------------
  // 3b. DEAD SESSION HANDLER
  // -------------------------------------------------------------------------

  private async handleDeadSession(task: Task, result: ReconcileResult): Promise<void> {
    const supervisor = task.supervisor_agent ?? 'boss'
    const level = (task.escalation_level ?? 0)

    log(`Dead session detected for task #${task.id} (worker: ${task.to_agent})`)

    // Sprint 4: Record crash fault
    this.taskDb.recordFault(task.to_agent, 'crash')

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
    await nudgeAgent('boss', `DEAD SESSION: Task #${task.id} (${task.to_agent}) \u2014 worker session is dead. Escalation task created.`)
    await postToGroup(`\ud83d\udea8 DEAD SESSION: Task #${task.id} (${task.to_agent}) \u2014 worker session dead. Escalated to Boss.`)

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
    const level = (task.escalation_level ?? 0)
    const newLevel = level + 1

    log(`Heartbeat overdue for task #${task.id} (worker: ${task.to_agent}, level ${level} -> ${newLevel})`)

    // Sprint 4: Record fault and check circuit breaker
    const faultResult = this.taskDb.recordFault(task.to_agent, 'timeout')
    if (faultResult.circuit_state === 'open') {
      log(`Circuit OPEN for ${task.to_agent} (${faultResult.fault_count} faults). Alerting boss.`)
      await this.taskDb.run(async () => {}) // no-op, just for type
      await nudgeAgent('boss', `Circuit OPEN for ${task.to_agent}: ${faultResult.fault_count} consecutive faults. Agent degraded.`)
      await postToGroup(`\u26a0\ufe0f Circuit breaker OPEN for ${task.to_agent} — ${faultResult.fault_count} faults`)
    }

    if (newLevel >= 3) {
      // Escalate to boss
      await this.escalateToBoss(task, newLevel, `heartbeat overdue (${timeoutSec}s timeout, level ${newLevel})`)
      result.escalated++
    } else {
      // Nudge the worker
      const msg = `Heartbeat overdue: Task #${task.id} has not sent a heartbeat in ${timeoutSec}s. Send a write_status update. (escalation level ${newLevel}/3)`
      await nudgeAgent(task.to_agent, msg)
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
    await nudgeAgent(supervisor, msg)

    // Also nudge the worker
    await nudgeAgent(task.to_agent, `Progress check: Task #${task.id} \u2014 no progress update in ${timeoutSec}s. Send write_status with progress=true.`)

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
    const level = (task.escalation_level ?? 0)
    const newLevel = level + 1

    log(`Unclaimed task #${task.id} assigned to ${task.to_agent} (level ${newLevel})`)

    const msg = `Reminder: Task #${task.id} is pending and assigned to you: ${task.description}`
    await nudgeAgent(task.to_agent, msg)

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

    await nudgeAgent('boss', `Escalation L${level}: Task #${task.id} (${task.to_agent}) \u2014 ${reason}`)
    await postToGroup(`\ud83d\udea8 Escalation L${level}: Task #${task.id} (${task.to_agent}) \u2014 ${reason}`)

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

        await postToGroup(`\u26a0\ufe0f Agent ${session.agent} session (${tmuxSessionName}) is dead.`)
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
  // 7. PERSISTENT LOOP
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

        // Step 2: Reconcile due tasks
        const reconcileResult = await this.reconcileDueTasks()

        // Step 3: Check agent sessions
        await this.checkAgentSessions()

        // Step 3b: Check debrief gates
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

        // Log cycle summary
        if (reconcileResult.checked > 0 || reconcileResult.nudged > 0 || reconcileResult.escalated > 0 || reconcileResult.blocked_relayed > 0 || reconcileResult.dead_sessions > 0) {
          log(`Cycle complete: checked=${reconcileResult.checked} nudged=${reconcileResult.nudged} escalated=${reconcileResult.escalated} blocked_relayed=${reconcileResult.blocked_relayed} dead_sessions=${reconcileResult.dead_sessions}`)
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
