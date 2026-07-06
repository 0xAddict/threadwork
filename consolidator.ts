import type { TaskDB } from './db'
import type { MemoryDB, Memory, Classification } from './memory'
import { runDecay, runArchive, runPrune, getDecayWindowDays } from './consolidate'
import { guardClassificationElevation } from './memory-integrity'

export interface ConsolidationResult {
  runId: number
  triggerReason: string
  phasesCompleted: string[]
  mutations: number
  dryRun: boolean
  summary: string
  durationMs: number
  scope: string
}

export interface HealthReport {
  totalActive: number
  byClassification: Record<string, number>
  byState: Record<string, number>
  disputeRate: number
  avgQuality: number
  lastRunAt: string | null
  lastRunMutations: number | null
}

export interface TriggerGates {
  time: boolean
  volume: boolean
  idle: boolean
  lock: boolean
}

interface Signal {
  type: 'stale' | 'duplicate' | 'disputed' | 'cluster'
  memoryIds: number[]
  reason: string
}

interface ValidatedAction {
  type: 'challenge' | 'supersede' | 'merge'
  targetId: number
  confidence: number
  reason: string
  newContent?: string
  survivorId?: number
}

interface Mutation {
  type: string
  memoryId: number
  before: Partial<Memory>
  after: Partial<Memory>
  reason: string
}

const HARD_TIME_LIMIT_MS = 15 * 60 * 1000 // 15 minutes
const TRIGGER_INTERVAL_HOURS = 6
const VOLUME_THRESHOLD = 25
const DISPUTE_RATE_THRESHOLD = 0.15
const IDLE_MINUTES = 45
const LOCK_LEASE_MINUTES = 10
const CONFIDENCE_THRESHOLD = 0.6

/**
 * Scope of a consolidation run.
 *   "all"         — every memory in the system (original default behavior)
 *   "operational" — limit to classification='operational'
 *   "agent:NAME"  — limit to memories where agent=NAME
 */
export type ConsolidationScope = string

interface ScopeClause {
  /** SQL fragment to append to a WHERE — always begins with " AND " or is empty. */
  sql: string
  /** Params for the placeholders in `sql`, in order. */
  params: unknown[]
}

/**
 * Returns a SQL AND-clause fragment that restricts a query to the given scope.
 * The caller is responsible for injecting both the SQL and params into the
 * prepared statement. Supports table-alias prefixes (e.g. "m1.").
 */
export function buildScopeClause(scope: ConsolidationScope | undefined, alias = ''): ScopeClause {
  const s = (scope ?? 'all').trim()
  const col = alias ? `${alias}.agent` : 'agent'
  const classCol = alias ? `${alias}.classification` : 'classification'

  if (!s || s === 'all') {
    return { sql: '', params: [] }
  }
  if (s === 'operational') {
    return { sql: ` AND ${classCol} = ?`, params: ['operational'] }
  }
  if (s.startsWith('agent:')) {
    const name = s.slice('agent:'.length).trim()
    if (!name) return { sql: '', params: [] }
    return { sql: ` AND ${col} = ?`, params: [name] }
  }
  // Unknown scope — fall back to "all" rather than silently mis-filtering.
  return { sql: '', params: [] }
}

/**
 * Returns the consolidation_locks row key used by a given scope. Per-agent
 * scopes get their own lock key so parallel agent-scoped runs don't block
 * each other. Everything else shares the global consolidator lock.
 */
export function lockKeyForScope(scope: ConsolidationScope | undefined): string {
  const s = (scope ?? 'all').trim()
  if (s.startsWith('agent:')) {
    const name = s.slice('agent:'.length).trim()
    if (name) return `memory_consolidation:agent:${name}`
  }
  return 'consolidator'
}

export class MemoryConsolidator {
  private lockId: number | null = null
  private readonly scope: ConsolidationScope
  private readonly lockKey: string

  constructor(
    private mem: MemoryDB,
    private taskDb: TaskDB,
    private dryRun: boolean = true,
    private maxMutationsPerRun: number = 50,
    scope: ConsolidationScope = 'all',
  ) {
    this.scope = scope
    this.lockKey = lockKeyForScope(scope)
  }

  /** Exposed for tests and server introspection. */
  getScope(): ConsolidationScope {
    return this.scope
  }

  private scopeClause(alias = ''): ScopeClause {
    return buildScopeClause(this.scope, alias)
  }

  acquireLock(): boolean {
    return this.taskDb.run(db => {
      // Clean expired locks
      db.prepare("DELETE FROM consolidation_locks WHERE expires_at < datetime('now')").run()

      // Check for existing lock with THIS scope's key. Per-agent scopes have
      // their own key so they don't collide with other agents' runs, while
      // all/operational continue to share the global 'consolidator' key.
      const existing = db.prepare('SELECT id FROM consolidation_locks WHERE agent = ? LIMIT 1').get(this.lockKey)
      if (existing) return false

      const result = db.prepare(`
        INSERT INTO consolidation_locks (agent, expires_at, pid)
        VALUES (?, datetime('now', '+${LOCK_LEASE_MINUTES} minutes'), ?)
        RETURNING id
      `).get(this.lockKey, process.pid) as { id: number } | null

      if (result) {
        this.lockId = result.id
        return true
      }
      return false
    })
  }

  releaseLock(): void {
    if (this.lockId == null) return
    this.taskDb.run(db => {
      db.prepare('DELETE FROM consolidation_locks WHERE id = ?').run(this.lockId)
    })
    this.lockId = null
  }

  getHealthReport(): HealthReport {
    const clause = this.scopeClause()
    return this.taskDb.run(db => {
      const byClass = db.prepare(`
        SELECT classification, COUNT(*) as cnt FROM memories WHERE state = 'active'${clause.sql} GROUP BY classification
      `).all(...clause.params) as { classification: string, cnt: number }[]

      const byState = db.prepare(`
        SELECT state, COUNT(*) as cnt FROM memories WHERE 1=1${clause.sql} GROUP BY state
      `).all(...clause.params) as { state: string, cnt: number }[]

      const stats = db.prepare(`
        SELECT COUNT(*) as total, AVG(quality) as avg_q,
               SUM(CASE WHEN state = 'disputed' THEN 1 ELSE 0 END) as disputed_count
        FROM memories WHERE state != 'superseded'${clause.sql}
      `).get(...clause.params) as { total: number, avg_q: number | null, disputed_count: number }

      // consolidation_runs is not scoped by agent — it's a global audit trail.
      const lastRun = db.prepare(`
        SELECT completed_at, mutations FROM consolidation_runs
        WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1
      `).get() as { completed_at: string, mutations: number } | null

      const classMap: Record<string, number> = {}
      for (const r of byClass) classMap[r.classification] = r.cnt

      const stateMap: Record<string, number> = {}
      for (const r of byState) stateMap[r.state] = r.cnt

      return {
        totalActive: stats.total,
        byClassification: classMap,
        byState: stateMap,
        disputeRate: stats.total > 0 ? stats.disputed_count / stats.total : 0,
        avgQuality: stats.avg_q ?? 0,
        lastRunAt: lastRun?.completed_at ?? null,
        lastRunMutations: lastRun?.mutations ?? null,
      }
    })
  }

  checkTriggers(): TriggerGates {
    const clause = this.scopeClause()
    return this.taskDb.run(db => {
      // Time gate: 6h since last successful run
      const lastRun = db.prepare(`
        SELECT completed_at FROM consolidation_runs
        WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1
      `).get() as { completed_at: string } | null

      let timeTrigger = true
      if (lastRun) {
        const lastRunTime = new Date(lastRun.completed_at + 'Z')
        const hoursSince = (Date.now() - lastRunTime.getTime()) / (1000 * 60 * 60)
        timeTrigger = hoursSince >= TRIGGER_INTERVAL_HOURS
      }

      // Volume gate: >25 new or >15% disputed (within scope)
      const stats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN state = 'disputed' THEN 1 ELSE 0 END) as disputed
        FROM memories WHERE state != 'superseded'${clause.sql}
      `).get(...clause.params) as { total: number, disputed: number }

      const recentCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM memories
        WHERE created_at > datetime('now', '-6 hours') AND state = 'active'${clause.sql}
      `).get(...clause.params) as { cnt: number }

      const volumeTrigger = recentCount.cnt > VOLUME_THRESHOLD ||
        (stats.total > 0 && stats.disputed / stats.total > DISPUTE_RATE_THRESHOLD)

      // Idle gate: no task_status_events in 45min (not scoped to memories)
      const recentStatus = db.prepare(`
        SELECT COUNT(*) as cnt FROM task_status_events
        WHERE created_at > datetime('now', '-${IDLE_MINUTES} minutes')
      `).get() as { cnt: number }
      const idleTrigger = recentStatus.cnt === 0

      // Lock gate: no unexpired lock for THIS scope's lock key
      db.prepare("DELETE FROM consolidation_locks WHERE expires_at < datetime('now')").run()
      const lockExists = db.prepare('SELECT id FROM consolidation_locks WHERE agent = ? LIMIT 1').get(this.lockKey)
      const lockTrigger = !lockExists

      return { time: timeTrigger, volume: volumeTrigger, idle: idleTrigger, lock: lockTrigger }
    })
  }

  async run(triggerReason: string): Promise<ConsolidationResult> {
    const startTime = Date.now()
    const phasesCompleted: string[] = []
    let mutations = 0

    if (!this.acquireLock()) {
      return { runId: 0, triggerReason, phasesCompleted: [], mutations: 0, dryRun: this.dryRun, summary: `Could not acquire lock (scope=${this.scope})`, durationMs: 0, scope: this.scope }
    }

    // Create run record
    const runId = this.taskDb.run(db => {
      const r = db.prepare(`
        INSERT INTO consolidation_runs (trigger_reason, dry_run) VALUES (?, ?)
        RETURNING id
      `).get(`${triggerReason} [scope=${this.scope}]`, this.dryRun ? 1 : 0) as { id: number }
      return r.id
    })

    try {
      // Phase 1: Orient
      const health = this.getHealthReport()
      phasesCompleted.push('orient')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 2: Gather
      const signals = this.gather(health)
      phasesCompleted.push('gather')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 3: Validate
      const actions = this.validate(signals)
      phasesCompleted.push('validate')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 4: Consolidate
      const muts = this.consolidate(actions, runId)
      mutations = muts.length
      phasesCompleted.push('consolidate')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 5: Prune/Index
      // NOTE: decay/archive/prune currently operate globally across all memories.
      // For scoped runs we skip them to avoid touching memories outside the
      // requested scope. A global 'all' run still performs them.
      let decayed = 0, archived = 0, pruned = 0
      if (this.scope === 'all') {
        decayed = runDecay(this.mem)
        archived = runArchive(this.mem)
        pruned = runPrune(this.mem)
      }
      phasesCompleted.push('prune')

      const summary = `[scope=${this.scope}] Orient: ${health.totalActive} active, ${health.disputeRate.toFixed(2)} dispute rate. Gathered ${signals.length} signals, validated ${actions.length} actions, executed ${mutations} mutations (dry_run=${this.dryRun}). Decay: ${decayed}, Archive: ${archived}, Prune: ${pruned}.`

      // Record completion
      this.taskDb.run(db => {
        db.prepare(`
          UPDATE consolidation_runs
          SET completed_at = datetime('now'), phases_completed = ?, mutations = ?, summary = ?
          WHERE id = ?
        `).run(JSON.stringify(phasesCompleted), mutations, summary, runId)
      })

      return {
        runId,
        triggerReason,
        phasesCompleted,
        mutations,
        dryRun: this.dryRun,
        summary,
        durationMs: Date.now() - startTime,
        scope: this.scope,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.taskDb.run(db => {
        db.prepare(`
          UPDATE consolidation_runs
          SET completed_at = datetime('now'), phases_completed = ?, mutations = ?, error = ?
          WHERE id = ?
        `).run(JSON.stringify(phasesCompleted), mutations, errorMsg, runId)
      })
      return {
        runId,
        triggerReason,
        phasesCompleted,
        mutations,
        dryRun: this.dryRun,
        summary: `Error: ${errorMsg}`,
        durationMs: Date.now() - startTime,
        scope: this.scope,
      }
    } finally {
      this.releaseLock()
    }
  }

  private gather(health: HealthReport): Signal[] {
    const clause = this.scopeClause()
    const clauseM1 = this.scopeClause('m1')
    const clauseM2 = this.scopeClause('m2')
    return this.taskDb.run(db => {
      const signals: Signal[] = []

      // Find stale memories past their decay window (within scope)
      const allActive = db.prepare(`
        SELECT * FROM memories WHERE state = 'active' AND pinned = 0${clause.sql}
      `).all(...clause.params) as Memory[]

      for (const m of allActive) {
        const window = getDecayWindowDays(m)
        if (window === Infinity) continue
        const lastAccessed = new Date(m.last_accessed + 'Z')
        const daysSince = (Date.now() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince > window * 2) {
          signals.push({ type: 'stale', memoryIds: [m.id], reason: `${daysSince.toFixed(0)}d since access, window=${window}d` })
        }
      }

      // Find duplicate content (same normalized content, different IDs).
      // Both sides of the self-join must respect the scope so we never
      // pull in memories outside it.
      const dupes = db.prepare(`
        SELECT m1.id as id1, m2.id as id2
        FROM memories m1
        JOIN memories m2 ON m1.id < m2.id
          AND m1.agent = m2.agent
          AND m1.state = 'active'
          AND m2.state = 'active'
          AND LOWER(TRIM(m1.content)) = LOWER(TRIM(m2.content))
        WHERE 1=1${clauseM1.sql}${clauseM2.sql}
        LIMIT 50
      `).all(...clauseM1.params, ...clauseM2.params) as { id1: number, id2: number }[]

      for (const d of dupes) {
        signals.push({ type: 'duplicate', memoryIds: [d.id1, d.id2], reason: 'identical normalized content' })
      }

      // Find heavily disputed memories (within scope)
      const disputed = db.prepare(`
        SELECT id FROM memories
        WHERE state = 'disputed' AND challenge_count > support_count + 2${clause.sql}
        LIMIT 20
      `).all(...clause.params) as { id: number }[]

      for (const d of disputed) {
        signals.push({ type: 'disputed', memoryIds: [d.id], reason: 'heavily disputed, challenge_count >> support_count' })
      }

      return signals
    })
  }

  private validate(signals: Signal[]): ValidatedAction[] {
    const clause = this.scopeClause()
    return this.taskDb.run(db => {
      const actions: ValidatedAction[] = []
      const eligible = db.prepare(
        `SELECT COUNT(*) as cnt FROM memories WHERE state = 'active'${clause.sql}`
      ).get(...clause.params) as { cnt: number }
      const maxActions = Math.ceil(eligible.cnt * 0.15)

      for (const signal of signals) {
        if (actions.length >= maxActions || actions.length >= this.maxMutationsPerRun) break

        if (signal.type === 'stale') {
          // Re-check scope when fetching the candidate memory so we never
          // operate on rows that somehow slipped past the gather filter.
          const m = db.prepare(
            `SELECT * FROM memories WHERE id = ?${clause.sql}`
          ).get(signal.memoryIds[0], ...clause.params) as Memory | null
          if (!m) continue
          // Block foundational and strategic
          if (m.classification === 'foundational' || m.classification === 'strategic') {
            db.prepare(`INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('consolidator', 'consolidation_blocked', ?, ?)`).run(
              `Blocked: ${m.classification} memory, reason: ${signal.reason}`, m.id
            )
            continue
          }
          const confidence = this.calcConfidence(m)
          if (confidence < CONFIDENCE_THRESHOLD) continue
          actions.push({ type: 'challenge', targetId: m.id, confidence, reason: signal.reason })
        }

        if (signal.type === 'duplicate') {
          const m1 = db.prepare(
            `SELECT * FROM memories WHERE id = ?${clause.sql}`
          ).get(signal.memoryIds[0], ...clause.params) as Memory | null
          const m2 = db.prepare(
            `SELECT * FROM memories WHERE id = ?${clause.sql}`
          ).get(signal.memoryIds[1], ...clause.params) as Memory | null
          if (!m1 || !m2) continue
          if (m1.classification === 'foundational' || m1.classification === 'strategic') continue
          const survivor = m1.quality >= m2.quality ? m1 : m2
          const victim = survivor.id === m1.id ? m2 : m1
          actions.push({ type: 'merge', targetId: victim.id, survivorId: survivor.id, confidence: 1.0, reason: signal.reason })
        }

        if (signal.type === 'disputed') {
          const m = db.prepare(
            `SELECT * FROM memories WHERE id = ?${clause.sql}`
          ).get(signal.memoryIds[0], ...clause.params) as Memory | null
          if (!m) continue
          if (m.classification === 'foundational' || m.classification === 'strategic') continue
          actions.push({ type: 'challenge', targetId: m.id, confidence: 0.9, reason: signal.reason })
        }
      }

      return actions
    })
  }

  private calcConfidence(m: Memory): number {
    const accessScore = Math.min(m.access_count / 10, 1) * 0.3
    const supportRatio = m.support_count + m.challenge_count > 0
      ? m.support_count / (m.support_count + m.challenge_count)
      : 0.5
    const supportScore = supportRatio * 0.4
    const qualityScore = m.quality * 0.3
    return Math.max(0, Math.min(1, accessScore + supportScore + qualityScore))
  }

  private consolidate(actions: ValidatedAction[], runId: number): Mutation[] {
    const mutations: Mutation[] = []

    for (const action of actions) {
      if (this.dryRun) {
        // Log proposed action but don't execute
        this.taskDb.run(db => {
          db.prepare(`INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('consolidator', 'consolidation_dry_run', ?, ?)`).run(
            `Would ${action.type} memory ${action.targetId}: ${action.reason} (confidence=${action.confidence.toFixed(2)}) [scope=${this.scope}]`, action.targetId
          )
        })
        mutations.push({ type: action.type, memoryId: action.targetId, before: {}, after: {}, reason: `[DRY RUN] ${action.reason}` })
        continue
      }

      if (action.type === 'challenge') {
        const before = this.mem.getMemory(action.targetId)
        const after = this.mem.challengeMemory(action.targetId, `[consolidator run=${runId} scope=${this.scope}] ${action.reason}`)
        if (before && after) {
          mutations.push({
            type: 'challenge',
            memoryId: action.targetId,
            before: { state: before.state, quality: before.quality, challenge_count: before.challenge_count },
            after: { state: after.state, quality: after.quality, challenge_count: after.challenge_count },
            reason: action.reason,
          })
        }
      }

      if (action.type === 'merge' && action.survivorId != null) {
        const victim = this.mem.getMemory(action.targetId)
        const survivorId = action.survivorId
        if (victim) {
          // P4 (#10376048/ATM-014, ATM-033): flag-gated. Flag OFF -> the merge
          // is byte-identical to pre-P4 (same two UPDATEs, same audit row,
          // no guard call, no extra SELECT). Flag ON -> a live, reachable
          // seam for the trust-tier ceiling: load the survivor's own
          // pre-merge classification and self-check it (before === attempted)
          // via guardClassificationElevation. Merge never proposes a
          // different classification for the survivor (confirmed: no write
          // to memories.classification anywhere in this block), so this
          // self-check always returns true (no-op, no audit row) in
          // production. Control flow does NOT branch on its return value —
          // the call exists to make the seam real, not to gate this path.
          const sanitizeOn = this.taskDb.isFeatureEnabled('memory_sanitization_enabled')
          this.taskDb.run(db => {
            if (sanitizeOn) {
              const survivorRow = db.prepare('SELECT classification FROM memories WHERE id = ?').get(survivorId) as { classification: Classification } | null
              if (survivorRow) {
                guardClassificationElevation(survivorRow.classification, survivorRow.classification, survivorId, { db })
              }
            }
            db.prepare('UPDATE memories SET support_count = support_count + 1 WHERE id = ?').run(action.survivorId)
            db.prepare("UPDATE memories SET state = 'superseded' WHERE id = ?").run(action.targetId)
            db.prepare(`INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('consolidator', 'consolidation_merge', ?, ?)`).run(
              `Merged into ${action.survivorId}, run=${runId}, scope=${this.scope}`, action.targetId
            )
          })
          mutations.push({
            type: 'merge',
            memoryId: action.targetId,
            before: { state: 'active' },
            after: { state: 'superseded' },
            reason: `Merged into #${action.survivorId}`,
          })
        }
      }
    }

    return mutations
  }
}
