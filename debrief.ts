// debrief.ts — Session Debrief Daemon with 3-gate triggering
//
// Inspired by AutoDream's consolidation gates pattern.
// Gates: Idle, Volume, Lock — all must pass before a debrief triggers.
// Phases: Gather, Solicit, Synthesize, Persist.

import type { TaskDB, Task } from './db'
import type { MemoryDB, Memory } from './memory'
import { DecisionDB } from './decision'
import { AuditLog } from './audit'
import { postToGroup } from './notify'
import { DEBRIEF_DEFAULTS, TEAM_AGENTS } from './config'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebriefContext {
  /** Tasks completed since last debrief */
  completedTasks: Array<{
    id: number
    description: string
    result: string | null
    agent: string
    completed_at: string
  }>
  /** Blockers encountered (write_status with blocked status) */
  blockers: Array<{
    agent: string
    task_id: number
    detail: string
    created_at: string
  }>
  /** New memories saved since last debrief */
  newMemories: Array<{
    id: number
    agent: string
    content: string
    category: string
    created_at: string
  }>
  /** Escalations that fired */
  escalations: Array<{
    agent: string
    action: string
    detail: string
    task_id: number | null
    created_at: string
  }>
  /** Time range covered */
  since: string
  until: string
  /** Agents that had activity */
  activeAgents: string[]
}

export interface DebriefResult {
  runId: number
  decisionId: number | null
  tasksReviewed: number
  memoriesReviewed: number
  synthesis: string
  error: string | null
  durationMs: number
}

export interface GateStatus {
  idle: boolean
  volume: { pass: boolean; completedTasks: number; newMemories: number; hoursSinceLastDebrief: number }
  lock: boolean
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [debrief] ${msg}`)
}

function logError(msg: string, err?: unknown): void {
  console.error(`[${new Date().toISOString()}] [debrief] ERROR: ${msg}`, err ?? '')
}

// ---------------------------------------------------------------------------
// DebriefDaemon
// ---------------------------------------------------------------------------

export class DebriefDaemon {
  private taskDb: TaskDB
  private mem: MemoryDB
  private dec: DecisionDB
  private audit: AuditLog

  constructor(taskDb: TaskDB, mem: MemoryDB, dec: DecisionDB, audit: AuditLog) {
    this.taskDb = taskDb
    this.mem = mem
    this.dec = dec
    this.audit = audit
  }

  // -------------------------------------------------------------------------
  // GATE 1 — IDLE GATE (time-based)
  // -------------------------------------------------------------------------

  /**
   * All agents must have been idle for >= idle_threshold_min minutes.
   * No task_status_events with status='working' in the threshold window.
   * No tasks currently in 'in_progress' status.
   */
  checkIdleGate(): boolean {
    return this.taskDb.run(db => {
      const thresholdMin = DEBRIEF_DEFAULTS.idle_threshold_min

      // Check for recent working status events
      const recentWorking = db.prepare(`
        SELECT COUNT(*) as cnt FROM task_status_events
        WHERE status = 'working'
        AND created_at > datetime('now', '-' || ? || ' minutes')
      `).get(thresholdMin) as { cnt: number }

      if (recentWorking.cnt > 0) {
        return false
      }

      // Check for in_progress tasks
      const inProgress = db.prepare(`
        SELECT COUNT(*) as cnt FROM tasks
        WHERE status = 'in_progress'
      `).get() as { cnt: number }

      return inProgress.cnt === 0
    })
  }

  // -------------------------------------------------------------------------
  // GATE 2 — VOLUME GATE (content-based)
  // -------------------------------------------------------------------------

  /**
   * Checks if enough activity has occurred to warrant a debrief:
   * - At least 3 tasks completed since last debrief, OR
   * - At least 5 new memories saved since last debrief, OR
   * - At least 2 hours since last debrief AND at least 1 task completed
   */
  checkVolumeGate(): { pass: boolean; completedTasks: number; newMemories: number; hoursSinceLastDebrief: number } {
    return this.taskDb.run(db => {
      // Find the last debrief run
      const lastRun = db.prepare(`
        SELECT completed_at FROM debrief_runs
        WHERE completed_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1
      `).get() as { completed_at: string } | null

      const since = lastRun?.completed_at ?? '2000-01-01 00:00:00'

      // Count completed tasks since last debrief
      const completedResult = db.prepare(`
        SELECT COUNT(*) as cnt FROM tasks
        WHERE status = 'completed'
        AND completed_at > ?
      `).get(since) as { cnt: number }
      const completedTasks = completedResult.cnt

      // Count new memories since last debrief
      const memoriesResult = db.prepare(`
        SELECT COUNT(*) as cnt FROM memories
        WHERE created_at > ?
      `).get(since) as { cnt: number }
      const newMemories = memoriesResult.cnt

      // Calculate hours since last debrief
      let hoursSinceLastDebrief = Infinity
      if (lastRun?.completed_at) {
        const lastTime = new Date(lastRun.completed_at + 'Z').getTime()
        hoursSinceLastDebrief = (Date.now() - lastTime) / (1000 * 60 * 60)
      }

      // Evaluate the gate conditions
      const pass =
        completedTasks >= DEBRIEF_DEFAULTS.min_completed_tasks ||
        newMemories >= DEBRIEF_DEFAULTS.min_new_memories ||
        (hoursSinceLastDebrief >= DEBRIEF_DEFAULTS.min_hours_since_last && completedTasks >= 1)

      return { pass, completedTasks, newMemories, hoursSinceLastDebrief }
    })
  }

  // -------------------------------------------------------------------------
  // GATE 3 — LOCK GATE (singleton)
  // -------------------------------------------------------------------------

  /**
   * No other debrief currently running. Uses debrief_locks table.
   */
  checkLockGate(): boolean {
    return this.taskDb.run(db => {
      // Clean expired locks
      db.prepare("DELETE FROM debrief_locks WHERE expires_at < datetime('now')").run()

      // Check for existing lock
      const existing = db.prepare('SELECT id FROM debrief_locks WHERE id = 1').get()
      return !existing
    })
  }

  /**
   * Acquire the singleton debrief lock.
   * Returns true if lock was acquired successfully.
   */
  acquireLock(): boolean {
    return this.taskDb.run(db => {
      // Clean expired locks first
      db.prepare("DELETE FROM debrief_locks WHERE expires_at < datetime('now')").run()

      try {
        db.prepare(`
          INSERT INTO debrief_locks (id, holder, acquired_at, expires_at)
          VALUES (1, ?, datetime('now'), datetime('now', '+' || ? || ' minutes'))
        `).run(`debrief-${process.pid}`, DEBRIEF_DEFAULTS.lock_ttl_min)
        return true
      } catch {
        // Row with id=1 already exists (lock held)
        return false
      }
    })
  }

  /**
   * Release the debrief lock.
   */
  releaseLock(): void {
    this.taskDb.run(db => {
      db.prepare('DELETE FROM debrief_locks WHERE id = 1').run()
    })
  }

  // -------------------------------------------------------------------------
  // CHECK ALL GATES
  // -------------------------------------------------------------------------

  /**
   * Check all 3 gates. Returns the status of each gate.
   */
  checkGates(): GateStatus {
    const idle = this.checkIdleGate()
    const volume = this.checkVolumeGate()
    const lock = this.checkLockGate()
    return { idle, volume, lock }
  }

  /**
   * Check if all 3 gates pass.
   */
  allGatesPass(): boolean {
    const gates = this.checkGates()
    return gates.idle && gates.volume.pass && gates.lock
  }

  // -------------------------------------------------------------------------
  // PHASE 1 — GATHER
  // -------------------------------------------------------------------------

  /**
   * Gather all context since the last debrief.
   */
  gatherContext(): DebriefContext {
    return this.taskDb.run(db => {
      // Find the last debrief run
      const lastRun = db.prepare(`
        SELECT completed_at FROM debrief_runs
        WHERE completed_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1
      `).get() as { completed_at: string } | null

      const since = lastRun?.completed_at ?? '2000-01-01 00:00:00'
      const until = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

      // Completed tasks
      const completedTasks = db.prepare(`
        SELECT id, description, result, to_agent as agent, completed_at
        FROM tasks
        WHERE status = 'completed'
        AND completed_at > ?
        ORDER BY completed_at ASC
      `).all(since) as DebriefContext['completedTasks']

      // Blockers (status events with status='blocked')
      const blockers = db.prepare(`
        SELECT agent, task_id, detail, created_at
        FROM task_status_events
        WHERE status = 'blocked'
        AND created_at > ?
        ORDER BY created_at ASC
      `).all(since) as DebriefContext['blockers']

      // New memories
      const newMemories = db.prepare(`
        SELECT id, agent, content, category, created_at
        FROM memories
        WHERE created_at > ?
        ORDER BY created_at ASC
      `).all(since) as DebriefContext['newMemories']

      // Escalations from audit log
      const escalations = db.prepare(`
        SELECT agent, action, detail, task_id, created_at
        FROM audit_log
        WHERE action LIKE '%escalat%'
        AND created_at > ?
        ORDER BY created_at ASC
      `).all(since) as DebriefContext['escalations']

      // Determine active agents
      const activeAgentSet = new Set<string>()
      for (const t of completedTasks) activeAgentSet.add(t.agent)
      for (const b of blockers) activeAgentSet.add(b.agent)
      const activeAgents = Array.from(activeAgentSet)

      return {
        completedTasks,
        blockers,
        newMemories,
        escalations,
        since,
        until,
        activeAgents,
      }
    })
  }

  // -------------------------------------------------------------------------
  // PHASE 2 — SOLICIT (via decision system)
  // -------------------------------------------------------------------------

  /**
   * Open a decision record and auto-submit positions from active agents.
   */
  solicit(context: DebriefContext): number {
    const dateStr = new Date().toISOString().slice(0, 10)
    const timeRange = `${context.since} to ${context.until}`

    // Build context summary
    const contextLines: string[] = [
      `Period: ${timeRange}`,
      `Tasks completed: ${context.completedTasks.length}`,
      `New memories: ${context.newMemories.length}`,
      `Blockers encountered: ${context.blockers.length}`,
      `Escalations: ${context.escalations.length}`,
    ]

    const decision = this.dec.openDecision(
      `Session Debrief — ${dateStr} ${timeRange}`,
      contextLines.join('\n'),
      'debrief-daemon',
    )

    // Auto-submit a position from each agent that had activity
    for (const agent of context.activeAgents) {
      const agentTasks = context.completedTasks.filter(t => t.agent === agent)
      const agentMemories = context.newMemories.filter(m => m.agent === agent)
      const agentBlockers = context.blockers.filter(b => b.agent === agent)

      const positionLines: string[] = []

      if (agentTasks.length > 0) {
        positionLines.push(`Completed ${agentTasks.length} tasks:`)
        for (const t of agentTasks) {
          positionLines.push(`  #${t.id}: ${t.description} -> ${t.result ?? 'no result'}`)
        }
      }

      if (agentBlockers.length > 0) {
        positionLines.push(`Encountered ${agentBlockers.length} blockers:`)
        for (const b of agentBlockers) {
          positionLines.push(`  Task #${b.task_id}: ${b.detail}`)
        }
      }

      if (agentMemories.length > 0) {
        positionLines.push(`Saved ${agentMemories.length} memories`)
      }

      if (positionLines.length === 0) {
        positionLines.push('No significant activity recorded.')
      }

      try {
        this.dec.addPosition(
          decision.id,
          agent,
          positionLines.join('\n'),
          `Auto-submitted by debrief daemon for session review`,
        )
      } catch (err) {
        logError(`Failed to add position for agent ${agent}`, err)
      }
    }

    return decision.id
  }

  // -------------------------------------------------------------------------
  // PHASE 3 — SYNTHESIZE
  // -------------------------------------------------------------------------

  /**
   * Generate a synthesis and finalize the decision.
   */
  synthesize(context: DebriefContext, decisionId: number): string {
    const sections: string[] = []

    // Work summary
    sections.push('== WORK SUMMARY ==')
    if (context.completedTasks.length > 0) {
      const byAgent = new Map<string, typeof context.completedTasks>()
      for (const t of context.completedTasks) {
        if (!byAgent.has(t.agent)) byAgent.set(t.agent, [])
        byAgent.get(t.agent)!.push(t)
      }
      for (const [agent, tasks] of byAgent) {
        sections.push(`${agent}: ${tasks.length} tasks completed`)
        for (const t of tasks) {
          sections.push(`  #${t.id}: ${t.description}`)
        }
      }
    } else {
      sections.push('No tasks completed in this period.')
    }

    // Blockers analysis
    if (context.blockers.length > 0) {
      sections.push('')
      sections.push('== BLOCKERS ==')
      const uniqueBlockers = new Map<string, string[]>()
      for (const b of context.blockers) {
        const key = `${b.agent}:${b.task_id}`
        if (!uniqueBlockers.has(key)) uniqueBlockers.set(key, [])
        uniqueBlockers.get(key)!.push(b.detail)
      }
      for (const [key, details] of uniqueBlockers) {
        sections.push(`${key}: ${details[0]}`)
      }
    }

    // Escalations
    if (context.escalations.length > 0) {
      sections.push('')
      sections.push('== ESCALATIONS ==')
      for (const e of context.escalations) {
        const taskRef = e.task_id ? ` (task #${e.task_id})` : ''
        sections.push(`${e.agent}: ${e.action}${taskRef}`)
      }
    }

    // Memory growth
    if (context.newMemories.length > 0) {
      sections.push('')
      sections.push('== KNOWLEDGE GROWTH ==')
      const byCategory = new Map<string, number>()
      for (const m of context.newMemories) {
        byCategory.set(m.category, (byCategory.get(m.category) ?? 0) + 1)
      }
      for (const [cat, count] of byCategory) {
        sections.push(`${cat}: ${count} new memories`)
      }
    }

    // Cross-agent observations
    sections.push('')
    sections.push('== OBSERVATIONS ==')
    if (context.activeAgents.length === 0) {
      sections.push('No agent activity detected.')
    } else if (context.activeAgents.length === 1) {
      sections.push(`Only ${context.activeAgents[0]} was active this session.`)
    } else {
      sections.push(`Active agents: ${context.activeAgents.join(', ')}`)
    }

    if (context.blockers.length > 0 && context.completedTasks.length > 0) {
      const blockerRatio = context.blockers.length / context.completedTasks.length
      if (blockerRatio > 0.5) {
        sections.push('High blocker-to-completion ratio — workflow friction detected.')
      }
    }

    if (context.escalations.length > 2) {
      sections.push('Multiple escalations detected — supervision thresholds may need tuning.')
    }

    const synthesis = sections.join('\n')

    // Finalize the decision with the synthesis
    try {
      this.dec.finalizeDecision(
        decisionId,
        'debrief-daemon',
        synthesis,
        'Automated session debrief synthesis',
      )
    } catch (err) {
      logError(`Failed to finalize debrief decision #${decisionId}`, err)
    }

    return synthesis
  }

  // -------------------------------------------------------------------------
  // PHASE 4 — PERSIST
  // -------------------------------------------------------------------------

  /**
   * Save individual learnings and post to Telegram.
   */
  async persist(
    context: DebriefContext,
    synthesis: string,
    decisionId: number,
    runId: number,
  ): Promise<void> {
    // Save distinct learnings as separate memories
    // Only if there's something meaningful to save
    if (context.completedTasks.length > 0) {
      const summaryContent = `Session debrief (${context.since} to ${context.until}): ` +
        `${context.completedTasks.length} tasks completed by ${context.activeAgents.join(', ')}. ` +
        `${context.blockers.length} blockers, ${context.escalations.length} escalations.`

      this.mem.saveMemory({
        agent: 'shared',
        content: summaryContent,
        category: 'learning',
        importance: 3,
        classification: 'observational',
        quality: 0.7,
        source_type: 'system',
      })
    }

    // Save blocker patterns as learning if multiple blockers from same source
    const blockerAgents = new Set(context.blockers.map(b => b.agent))
    for (const agent of blockerAgents) {
      const agentBlockers = context.blockers.filter(b => b.agent === agent)
      if (agentBlockers.length >= 2) {
        this.mem.saveMemory({
          agent: 'shared',
          content: `Agent ${agent} encountered ${agentBlockers.length} blockers in session (${context.since} to ${context.until}): ${agentBlockers.map(b => b.detail).join('; ')}`,
          category: 'learning',
          importance: 3,
          classification: 'operational',
          quality: 0.6,
          source_type: 'system',
        })
      }
    }

    // Post synthesis to Telegram (plain text, no MarkdownV2)
    // Build per-agent task summary
    const agentSummaries: string[] = []
    const byAgent = new Map<string, typeof context.completedTasks>()
    for (const t of context.completedTasks) {
      if (!byAgent.has(t.agent)) byAgent.set(t.agent, [])
      byAgent.get(t.agent)!.push(t)
    }
    for (const [agent, tasks] of byAgent) {
      const taskList = tasks.map(t => `  #${t.id}: ${t.description.slice(0, 80)}`).join('\n')
      agentSummaries.push(`${agent}: ${tasks.length} tasks\n${taskList}`)
    }

    const telegramMsg = [
      `Session Debrief — ${context.since.slice(0, 10)}`,
      `Period: ${context.since} to ${context.until}`,
      '',
      `== TEAM ACTIVITY ==`,
      agentSummaries.length > 0 ? agentSummaries.join('\n\n') : 'No tasks completed.',
      '',
      `== STATS ==`,
      `Tasks: ${context.completedTasks.length} | Blockers: ${context.blockers.length} | Escalations: ${context.escalations.length}`,
      `Memories: ${context.newMemories.length} new | Agents: ${context.activeAgents.join(', ') || 'none'}`,
      `Decision: #${decisionId}`,
    ].join('\n')

    await postToGroup(telegramMsg)

    // Audit log
    this.audit.log('debrief-daemon', 'debrief_completed', {
      run_id: runId,
      decision_id: decisionId,
      tasks_reviewed: context.completedTasks.length,
      memories_reviewed: context.newMemories.length,
      active_agents: context.activeAgents,
    })
  }

  // -------------------------------------------------------------------------
  // MAIN ENTRY POINT — runDebrief
  // -------------------------------------------------------------------------

  /**
   * Execute the full debrief pipeline (4 phases).
   * Assumes gates have been checked or bypassed (for force_debrief).
   */
  async runDebrief(force: boolean = false): Promise<DebriefResult> {
    const startTime = Date.now()

    // Acquire lock (always required, even for force)
    if (!this.acquireLock()) {
      return {
        runId: 0,
        decisionId: null,
        tasksReviewed: 0,
        memoriesReviewed: 0,
        synthesis: '',
        error: 'Could not acquire debrief lock — another debrief is running.',
        durationMs: 0,
      }
    }

    // Create run record
    const runId = this.taskDb.run(db => {
      const r = db.prepare(`
        INSERT INTO debrief_runs (started_at)
        VALUES (datetime('now'))
        RETURNING id
      `).get() as { id: number }
      return r.id
    })

    log(`Debrief run #${runId} started (force=${force})`)

    try {
      // Phase 1: Gather
      log('Phase 1: GATHER')
      const context = this.gatherContext()
      log(`Gathered: ${context.completedTasks.length} tasks, ${context.newMemories.length} memories, ${context.blockers.length} blockers, ${context.escalations.length} escalations`)

      // Phase 2: Solicit
      log('Phase 2: SOLICIT')
      const decisionId = this.solicit(context)
      log(`Decision #${decisionId} opened with ${context.activeAgents.length} agent positions`)

      // Phase 3: Synthesize
      log('Phase 3: SYNTHESIZE')
      const synthesis = this.synthesize(context, decisionId)
      log('Synthesis complete')

      // Phase 4: Persist
      log('Phase 4: PERSIST')
      await this.persist(context, synthesis, decisionId, runId)
      log('Persist complete')

      // Update run record
      this.taskDb.run(db => {
        db.prepare(`
          UPDATE debrief_runs SET
            completed_at = datetime('now'),
            tasks_reviewed = ?,
            memories_reviewed = ?,
            decision_id = ?,
            synthesis = ?
          WHERE id = ?
        `).run(
          context.completedTasks.length,
          context.newMemories.length,
          decisionId,
          synthesis,
          runId,
        )
      })

      const durationMs = Date.now() - startTime
      log(`Debrief run #${runId} completed in ${durationMs}ms`)

      return {
        runId,
        decisionId,
        tasksReviewed: context.completedTasks.length,
        memoriesReviewed: context.newMemories.length,
        synthesis,
        error: null,
        durationMs,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logError(`Debrief run #${runId} failed`, err)

      // Record error
      this.taskDb.run(db => {
        db.prepare(`
          UPDATE debrief_runs SET
            completed_at = datetime('now'),
            error = ?
          WHERE id = ?
        `).run(errorMsg, runId)
      })

      return {
        runId,
        decisionId: null,
        tasksReviewed: 0,
        memoriesReviewed: 0,
        synthesis: '',
        error: errorMsg,
        durationMs: Date.now() - startTime,
      }
    } finally {
      this.releaseLock()
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone check function (called from watchdog)
// ---------------------------------------------------------------------------

/**
 * Check all debrief gates and run a debrief if they all pass.
 * Returns the result if a debrief ran, or null if gates didn't pass.
 */
export async function checkAndRunDebrief(
  taskDb: TaskDB,
  mem: MemoryDB,
  dec: DecisionDB,
  audit: AuditLog,
): Promise<DebriefResult | null> {
  const daemon = new DebriefDaemon(taskDb, mem, dec, audit)
  const gates = daemon.checkGates()

  if (!gates.idle) {
    return null
  }
  if (!gates.volume.pass) {
    return null
  }
  if (!gates.lock) {
    return null
  }

  log('All 3 gates passed — triggering debrief')
  return daemon.runDebrief(false)
}

/**
 * Force a debrief, bypassing idle and volume gates (lock gate still respected).
 */
export async function forceDebrief(
  taskDb: TaskDB,
  mem: MemoryDB,
  dec: DecisionDB,
  audit: AuditLog,
): Promise<DebriefResult> {
  const daemon = new DebriefDaemon(taskDb, mem, dec, audit)
  return daemon.runDebrief(true)
}
