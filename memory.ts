import type { TaskDB, Task } from './db'
import {
  isDenseEnabled, denseMode, embedOne, putVector, getVectors,
  cosineNormalized, rrfFuse, vectorTableExists, DENSE_RRF_K,
} from './dense'

export type Classification = 'foundational' | 'strategic' | 'operational' | 'observational' | 'ephemeral'
export type MemoryState = 'proposed' | 'active' | 'disputed' | 'superseded' | 'archived'
export type SourceType = 'human' | 'agent' | 'consolidation' | 'system'

export interface Memory {
  id: number
  agent: string
  content: string
  category: string
  importance: number
  pinned: number
  source_task_id: number | null
  created_at: string
  last_accessed: string
  access_count: number
  classification: Classification
  quality: number
  state: MemoryState
  source_type: SourceType
  evidence: string | null
  support_count: number
  challenge_count: number
  supersedes_memory_id: number | null
  last_validated: string
}

export interface SaveMemoryInput {
  agent: string
  content: string
  category: string
  importance?: number
  pinned?: boolean
  source_task_id?: number
  classification?: Classification
  quality?: number
  source_type?: SourceType
  evidence?: string
  supersedes_memory_id?: number
}

export interface RecallFilter {
  query?: string
  category?: string
  limit?: number
}

export interface BootBriefing {
  role: Memory[]
  topMemories: Memory[]
  sharedMemories: Memory[]
  recentTasks: Task[]
  // Query/task-aware section (#10060784). When the boot briefing is derived
  // from an active task (or an explicit query), these are the BM25-relevant
  // memories. Empty when there is no query/results — in which case the briefing
  // is byte-for-byte identical to the pre-0014 output for backward-compat.
  relevantMemories: Memory[]
  // The query actually used for relevance (explicit arg or auto-derived from the
  // agent's active task). null when neither was available.
  relevantQuery: string | null
}

// Weights for the BM25 relevance blend used by recall(). Tuned so a strong
// lexical (BM25) match dominates, but quality / importance / recency act as
// tie-breakers and gentle boosts. All four normalized to [0,1] before blending.
export const RECALL_BLEND_WEIGHTS = {
  bm25: 0.6,
  quality: 0.2,
  importance: 0.15,
  recency: 0.05,
} as const

// GAP-4b (#10060804): down-weight factor for the shared "Session-Debrief"
// aggregate class in recall() ranking. There are ~23 of these shared `decision`
// blobs; they average ~143k chars (~13x the corpus mean) and carry
// importance=5/quality=0.8. They are a measured BM25 false-positive magnet —
// they outrank the specific gold memory in 31/36 low-overlap paraphrase queries
// (GAP-4b Stage-2). Two mechanisms drive it, neither fixable by BM25 params:
//   (1) SQLite FTS5 bm25() length-normalization (k1=1.2, b=0.75) is fixed and
//       NOT tunable from SQL, and b<1 only PARTIALLY discounts length — a 13x
//       blob still matches many of the OR-joined query tokens, so its raw bm25
//       stays competitive.
//   (2) The blend adds a query-INDEPENDENT quality(0.2*0.8=0.16) +
//       importance(0.15*1.0=0.15) ≈ 0.31 boost, and recall()'s touchRecalled
//       side-effect keeps these constantly-recalled blobs pinned at max
//       importance + freshest recency.
// We DEMOTE (not exclude) their final blended score: a focused memory on the
// queried topic ranks above them, while a debrief can still surface when it is
// genuinely the only/best match. Factor chosen a priori from the blend algebra
// (a strong debrief match ~0.96 -> ~0.29, below a typical focused match ~0.68),
// per the GAP-4b judge verdict #10060803 — NOT grid-searched against the eval.
export const DEBRIEF_DEMOTE_FACTOR = 0.3

export class MemoryDB {
  private taskDb: TaskDB

  constructor(taskDb: TaskDB) {
    this.taskDb = taskDb
  }

  normalizeContent(text: string): string {
    // NFC normalization folds composed vs decomposed accented characters
    // (e.g. 'café' as c+é vs c+e+combining-acute) into a canonical form,
    // so recall on Unicode-heavy content doesn't silently miss.
    return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
  }

  inferClassification(content: string, category: string): Classification {
    const CATEGORY_MAP: Record<string, Classification> = {
      role: 'foundational',
      preference: 'strategic',
      fact: 'operational',
      task_summary: 'observational',
      learning: 'operational',
    }
    return CATEGORY_MAP[category] ?? 'operational'
  }

  inferSourceType(agent: string): SourceType {
    if (agent === 'shared') return 'system'
    return 'agent'
  }

  saveMemory(input: SaveMemoryInput): Memory {
    return this.taskDb.run(db => {
      // Dedup check: normalize content and look for existing active memory
      const normalized = this.normalizeContent(input.content)
      const existing = db.prepare(`
        SELECT * FROM memories
        WHERE agent = ? AND state = 'active'
        AND LOWER(TRIM(REPLACE(content, '  ', ' '))) = ?
      `).get(input.agent, normalized) as Memory | null

      if (existing) {
        return db.prepare(`
          UPDATE memories SET support_count = support_count + 1, last_accessed = datetime('now')
          WHERE id = ?
          RETURNING *
        `).get(existing.id) as Memory
      }

      const classification = input.classification ?? this.inferClassification(input.content, input.category)
      const sourceType = input.source_type ?? this.inferSourceType(input.agent)
      const quality = input.quality ?? 0.5
      const evidence = input.evidence ?? null
      const supersedes = input.supersedes_memory_id ?? null

      // Spec AC #5: agent + foundational -> proposed state
      let state: MemoryState = 'active'
      if (sourceType === 'agent' && classification === 'foundational') {
        state = 'proposed'
      }

      const stmt = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, source_task_id,
          classification, quality, state, source_type, evidence, supersedes_memory_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `)
      return stmt.get(
        input.agent,
        input.content,
        input.category,
        input.importance ?? 3,
        input.pinned ? 1 : 0,
        input.source_task_id ?? null,
        classification,
        quality,
        state,
        sourceType,
        evidence,
        supersedes,
      ) as Memory
    })
  }

  getMemory(id: number): Memory | null {
    return this.taskDb.run(db => db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null)
  }

  challengeMemory(id: number, reason: string): Memory | null {
    return this.taskDb.run(db => {
      const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null
      if (!existing) return null

      const newChallengeCount = existing.challenge_count + 1
      const shouldDispute = newChallengeCount > existing.support_count
      const newQuality = shouldDispute ? Math.max(existing.quality - 0.2, 0) : existing.quality
      const newState = shouldDispute ? 'disputed' : existing.state

      const updated = db.prepare(`
        UPDATE memories
        SET challenge_count = ?, quality = ?, state = ?, last_validated = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(newChallengeCount, newQuality, newState, id) as Memory

      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, memory_id)
        VALUES ('system', 'memory_challenged', ?, ?)
      `).run(reason, id)

      return updated
    })
  }

  supersedeMemory(oldId: number, newContent: string, reason: string): { old: Memory, new: Memory } | null {
    return this.taskDb.run(db => {
      const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(oldId) as Memory | null
      if (!existing) return null

      const old = db.prepare(`
        UPDATE memories SET state = 'superseded', last_validated = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(oldId) as Memory

      const replacement = db.prepare(`
        INSERT INTO memories (agent, content, category, classification, quality, state, source_type, support_count, supersedes_memory_id)
        VALUES (?, ?, ?, ?, 0.5, 'active', 'agent', 0, ?)
        RETURNING *
      `).get(existing.agent, newContent, existing.category, existing.classification, oldId) as Memory

      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, memory_id)
        VALUES ('system', 'memory_superseded', ?, ?)
      `).run(`${reason} | old=${oldId} new=${replacement.id}`, replacement.id)

      return { old, new: replacement }
    })
  }

  /**
   * Sanitize a free-text query into a SAFE FTS5 MATCH expression (#10060784).
   *
   * Our memory content is tag/ID-heavy ([session-handoff:...], #10060xxx,
   * [snoopy-sop], dotted hostnames, etc). Passed raw to FTS5 MATCH, characters
   * like ':', '#', '-', '[', '.', '*', '"', '(', ')', 'AND'/'OR'/'NOT' are
   * operators or syntax — they throw "fts5: syntax error" and break recall.
   *
   * Strategy: lowercase -> split on every non-alphanumeric -> drop empties ->
   * double-quote each token (a quoted FTS5 string is a literal phrase, so all
   * operator meaning is neutralized) -> OR-join. Returns '' when nothing usable
   * remains, signalling the caller to use the LIKE fallback.
   *
   * Example: 'session-handoff:boss #10060' -> '"session" OR "handoff" OR "boss" OR "10060"'
   */
  sanitizeFtsQuery(query: string): string {
    const normalized = query.normalize('NFC').toLowerCase()
    // Split on anything that is not a letter or digit (Unicode-aware). This
    // turns ':', '-', '#', '.', '[', ']', whitespace, etc. into delimiters.
    const tokens = normalized
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 0)
    if (tokens.length === 0) return ''
    // Double-quote escapes any embedded quote by doubling it (FTS5 phrase
    // literal syntax). After the split above a token can't contain a quote, but
    // we double-defend in case the tokenizer is changed later.
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  }

  /** Apply the recall side-effects (access tracking + importance boost) to a set of rows. */
  private touchRecalled(db: any, ids: number[]): void {
    if (ids.length === 0) return
    db.prepare(`
      UPDATE memories
      SET last_accessed = datetime('now'),
          access_count = access_count + 1,
          importance = MIN(importance + 1, 5)
      WHERE id IN (${ids.map(() => '?').join(',')})
    `).run(...ids)
  }

  /**
   * GAP-4b (#10060804): classify the shared "Session-Debrief" aggregate magnet.
   *
   * Matches exactly the set the eval harness flags (agent='shared',
   * category='decision', content beginning "Decision #<n>: Session Debrief"). The
   * bounded slice(0,80) keeps the regex O(1) even on the ~500KB blobs. Used by
   * recall() to demote these query-independent aggregates so a focused memory on
   * the queried topic is not crowded out. See DEBRIEF_DEMOTE_FACTOR.
   */
  isDebriefAggregate(m: Pick<Memory, 'agent' | 'category' | 'content'>): boolean {
    if (m.agent !== 'shared' || m.category !== 'decision') return false
    return /^Decision\s+#\d+:\s*Session Debrief/.test((m.content ?? '').slice(0, 80))
  }

  /**
   * recall() — swappable retrieval interface (#10060784).
   *
   * Primary backend: FTS5 BM25 blend. Falls back to the LIKE path when the
   * sanitized MATCH expression is empty/invalid, or for category-only /
   * no-query queries (where there is no text to rank). Both paths apply the
   * same access-tracking + importance side-effects and the same
   * agent/shared/state filters, so behavior is identical except for ordering.
   */
  recall(agent: string, filter: RecallFilter): Memory[] {
    return this.taskDb.run(db => {
      const limit = filter.limit ?? 10

      // Decide whether the BM25 path is viable: we need a non-empty query that
      // sanitizes to a usable MATCH expr, and the memories_fts table must exist.
      let matchExpr = ''
      if (filter.query) {
        matchExpr = this.sanitizeFtsQuery(filter.query)
      }

      if (matchExpr.length > 0 && this.ftsAvailable(db)) {
        try {
          return this.recallBm25(db, agent, filter, matchExpr, limit)
        } catch (err) {
          // Any FTS error (e.g. an edge-case MATCH syntax issue) degrades to the
          // proven LIKE path rather than failing the recall.
          console.warn('[task-board] recall BM25 path failed, falling back to LIKE:', (err as Error)?.message)
        }
      }

      return this.recallLike(db, agent, filter, limit)
    })
  }

  /** Backward-compatible alias. server.ts calls recallMemories(); now routed through recall(). */
  recallMemories(agent: string, filter: RecallFilter): Memory[] {
    return this.recall(agent, filter)
  }

  /**
   * Dense-AUGMENTED recall (#10060808, GAP-4b Phase-2). ASYNC because embedding
   * the query is an ONNX forward pass. The FIRST ML dependency on the recall path.
   *
   * Contract (guardrails for the first ML dep):
   *   - dense flag OFF or empty query → returns the sync BM25/LIKE recall() EXACTLY
   *     (byte-identical to today; zero ML cost — fastembed is never even imported).
   *   - flag ON → blends dense (semantic) ranking with the BM25 base. Default mode
   *     'rrf' fuses BM25 ∪ dense via Reciprocal Rank Fusion (AUGMENT: every BM25 hit
   *     participates, dense never replaces it). Mode 'dense' = pure dense ranking
   *     (the arm validated to reproduce +0.250 / recall@10=1.0).
   *   - ANY dense failure (model load, embed, missing index) → silently returns the
   *     BM25 base. Recall can never break because of dense (mirrors the existing
   *     ftsAvailable()/try-catch-degrade discipline).
   *
   * Scope + ranking mirror arms_dense.py: candidates = (agent==self OR shared) AND
   * non-superseded (+ optional category), cosine over L2-normalized vectors,
   * deterministic (-score, id) tiebreak.
   */
  async recallAugmented(agent: string, filter: RecallFilter): Promise<Memory[]> {
    const limit = filter.limit ?? 10
    const base = this.recall(agent, filter) // sync BM25/LIKE — current behavior AND the fallback
    if (!isDenseEnabled() || !filter.query || filter.query.trim().length === 0) return base

    let queryVec: Float32Array
    try {
      queryVec = await embedOne(filter.query)
    } catch (err) {
      console.warn('[task-board] dense query-embed failed; BM25 base only:', (err as Error)?.message)
      return base
    }

    try {
      return this.taskDb.run(db => {
        if (!vectorTableExists(db)) return base

        // Candidate scope identical to recallBm25/recallLike.
        const conditions = ["(m.agent = ? OR m.agent = 'shared')", "m.state != 'superseded'"]
        const params: unknown[] = [agent]
        if (filter.category) { conditions.push('m.category = ?'); params.push(filter.category) }
        const candIds = (db.prepare(
          `SELECT m.id AS id FROM memories m WHERE ${conditions.join(' AND ')}`,
        ).all(...params) as Array<{ id: number }>).map(r => r.id)

        const vmap = getVectors(db, candIds)
        if (vmap.size === 0) return base // index not built/empty → safe BM25 fallback

        const scored = candIds
          .filter(id => vmap.has(id))
          .map(id => ({ id, score: cosineNormalized(vmap.get(id)!, queryVec) }))
        scored.sort((a, b) => b.score - a.score || a.id - b.id) // deterministic (-score, id)
        const denseOrder = scored.map(s => s.id)

        let orderedIds: number[]
        if (denseMode() === 'dense') {
          orderedIds = denseOrder.slice(0, limit)
        } else {
          // RRF AUGMENT: fuse BM25 base order ∪ dense order — every BM25 hit survives the fuse.
          orderedIds = rrfFuse([base.map(m => m.id), denseOrder], DENSE_RRF_K).slice(0, limit)
        }

        // Materialize Memory rows in fused order: reuse the base rows, fetch dense-only ids.
        const byId = new Map(base.map(m => [m.id, m]))
        const missing = orderedIds.filter(id => !byId.has(id))
        if (missing.length > 0) {
          const rows = db.prepare(
            `SELECT * FROM memories WHERE id IN (${missing.map(() => '?').join(',')})`,
          ).all(...missing) as Memory[]
          for (const r of rows) byId.set(r.id, r)
        }
        const result = orderedIds.map(id => byId.get(id)).filter((m): m is Memory => !!m)

        // touchRecalled side-effects: base rows were already touched by this.recall();
        // only touch the dense-only rows newly surfaced here so nothing is double-counted.
        const baseIds = new Set(base.map(m => m.id))
        this.touchRecalled(db, result.map(r => r.id).filter(id => !baseIds.has(id)))
        return result
      })
    } catch (err) {
      console.warn('[task-board] dense augmentation failed; BM25 base only:', (err as Error)?.message)
      return base
    }
  }

  /**
   * Embed + persist one memory's vector into memory_vectors (#10060808). ASYNC
   * (ONNX forward pass). Called by the save_memory write path when dense is enabled,
   * and by the one-time backfill script. Caller wraps in try/catch — a dense index
   * failure must NEVER fail the underlying memory write.
   */
  async indexMemoryVector(id: number, content: string): Promise<void> {
    const vec = await embedOne(content)
    this.taskDb.run(db => putVector(db, id, vec, content))
  }

  /** Cheap check that the FTS index exists in this DB (false on pre-0014 DBs). */
  private ftsAvailable(db: any): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'memories_fts'"
    ).get() as { name: string } | undefined
    return !!row
  }

  /**
   * BM25 relevance path. Joins memories_fts on rowid=memories.id, orders by a
   * blend of normalized bm25 + quality + importance + recency.
   *
   * bm25() returns a score where MORE-NEGATIVE = MORE-relevant. We negate it so
   * larger = better, then min-max normalize across the candidate window to
   * [0,1]. quality is already ~[0,1]; importance is mapped from its [0,5] range;
   * recency is exp-style decay on age in days computed in SQL via julianday.
   */
  private recallBm25(db: any, agent: string, filter: RecallFilter, matchExpr: string, limit: number): Memory[] {
    const conditions = ['(m.agent = ? OR m.agent = ?)', "m.state != 'superseded'"]
    const params: unknown[] = [agent, 'shared']

    if (filter.category) {
      conditions.push('m.category = ?')
      params.push(filter.category)
    }

    // Pull a generous candidate window (limit*5, min 50) ranked by raw bm25, so
    // the quality/importance/recency blend can re-rank within a relevant set
    // rather than the whole table. Then blend + re-sort + slice in JS.
    const candidateWindow = Math.max(limit * 5, 50)
    const W = RECALL_BLEND_WEIGHTS

    const sql = `
      SELECT m.*,
             bm25(memories_fts) AS bm25_raw,
             (julianday('now') - julianday(m.last_accessed)) AS age_days
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND ${conditions.join(' AND ')}
      ORDER BY bm25(memories_fts)
      LIMIT ?
    `
    const rows = db.prepare(sql).all(matchExpr, ...params, candidateWindow) as Array<
      Memory & { bm25_raw: number; age_days: number }
    >

    if (rows.length === 0) return []

    // Normalize bm25 (negate so larger=better), then min-max across candidates.
    const scoresNeg = rows.map(r => -r.bm25_raw)
    const minS = Math.min(...scoresNeg)
    const maxS = Math.max(...scoresNeg)
    const span = maxS - minS

    const blended = rows.map((r, i) => {
      const normBm25 = span > 0 ? (scoresNeg[i] - minS) / span : 1
      const normQuality = Math.max(0, Math.min(1, r.quality ?? 0))
      const normImportance = Math.max(0, Math.min(1, (r.importance ?? 0) / 5))
      // Recency: 1.0 at age 0, halving ~ every 30 days (gentle).
      const ageDays = Number.isFinite(r.age_days) ? Math.max(0, r.age_days) : 0
      const normRecency = Math.pow(0.5, ageDays / 30)
      const rawScore =
        W.bm25 * normBm25 +
        W.quality * normQuality +
        W.importance * normImportance +
        W.recency * normRecency
      // GAP-4b (#10060804): demote shared Session-Debrief aggregates so they stop
      // crowding out the specific gold memory (magnet in 31/36 paraphrase queries).
      const score = this.isDebriefAggregate(r) ? rawScore * DEBRIEF_DEMOTE_FACTOR : rawScore
      return { row: r as Memory, score }
    })

    blended.sort((a, b) => b.score - a.score)
    const top = blended.slice(0, limit).map(b => b.row)

    this.touchRecalled(db, top.map(r => r.id))
    return top
  }

  /**
   * LIKE fallback path — the pre-0014 behavior, preserved verbatim for
   * category-only / substring / empty-MATCH queries and for pre-0014 DBs.
   */
  private recallLike(db: any, agent: string, filter: RecallFilter, limit: number): Memory[] {
    const conditions = ['(agent = ? OR agent = ?)', "state != 'superseded'"]
    const params: unknown[] = [agent, 'shared']

    if (filter.query) {
      const normalized = this.normalizeContent(filter.query)
      if (normalized.length > 0) {
        const tokens = normalized.split(' ').filter(t => t.length > 0)
        for (const token of tokens) {
          const escaped = token.replace(/%/g, '\\%').replace(/_/g, '\\_')
          conditions.push("LOWER(content) LIKE ? ESCAPE '\\'")
          params.push(`%${escaped}%`)
        }
      }
    }
    if (filter.category) {
      conditions.push('category = ?')
      params.push(filter.category)
    }

    // GAP-4b (#10060804): demote shared Session-Debrief aggregates to the bottom
    // of the LIKE-path ordering too (parity with the BM25 path), so category-only
    // / no-query recalls aren't dominated by the high-importance debrief blobs.
    const debriefDemote =
      "(CASE WHEN agent = 'shared' AND category = 'decision' AND content LIKE 'Decision%Session Debrief%' THEN 1 ELSE 0 END) ASC"
    const sql = `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY ${debriefDemote}, quality DESC, importance DESC, last_accessed DESC LIMIT ?`
    params.push(limit)

    const results = db.prepare(sql).all(...params) as Memory[]
    this.touchRecalled(db, results.map(r => r.id))
    return results
  }

  promoteMemory(id: number): Memory | null {
    return this.taskDb.run(db => db.prepare(`
      UPDATE memories SET agent = 'shared' WHERE id = ? RETURNING *
    `).get(id) as Memory | null)
  }

  pinMemory(id: number): Memory | null {
    return this.taskDb.run(db => db.prepare(`
      UPDATE memories SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ? RETURNING *
    `).get(id) as Memory | null)
  }

  /**
   * Boot briefing (#10060784: query/task-aware).
   *
   * @param query  Optional explicit query. When omitted, auto-derived from the
   *               agent's active task (in_progress/claimed, most recent claim,
   *               falling back to agent_sessions.current_task_id).
   *
   * BACKWARD-COMPAT: when there is no query AND no active task, relevantMemories
   * is [] and relevantQuery is null — the server renders exactly the pre-0014
   * sections (ROLE / TOP MEMORIES / SHARED / RECENT TASKS), byte-for-byte.
   *
   * When a query IS available, relevantMemories is a BLEND: pinned/role rows are
   * ALWAYS kept; remaining slots are filled by BM25 relevance via recall(). This
   * never drops the existing guarantees — role/top/shared/recent are still
   * computed and returned unchanged.
   */
  getBootBriefing(agent: string, taskDb: TaskDB, query?: string): BootBriefing {
    return this.taskDb.run(db => {
      const role = db.prepare(
        `SELECT * FROM memories WHERE agent = ? AND category = 'role' AND pinned = 1 AND state = 'active' ORDER BY quality DESC, importance DESC`
      ).all(agent) as Memory[]

      const topMemories = db.prepare(
        `SELECT * FROM memories WHERE agent = ? AND category != 'role' AND state = 'active' AND quality >= 0.3 ORDER BY quality DESC, importance DESC LIMIT 5`
      ).all(agent) as Memory[]

      const sharedMemories = db.prepare(
        `SELECT * FROM memories WHERE agent = 'shared' AND state = 'active' AND quality >= 0.3 ORDER BY quality DESC, importance DESC LIMIT 5`
      ).all() as Memory[]

      const recentTasks = db.prepare(
        `SELECT * FROM tasks WHERE to_agent = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 5`
      ).all(agent) as Task[]

      // Resolve the relevance query: explicit arg wins; else auto-derive from
      // the agent's active task.
      let relevantQuery: string | null = (query && query.trim().length > 0) ? query.trim() : null
      if (!relevantQuery) {
        const activeTask = db.prepare(
          `SELECT description FROM tasks
           WHERE to_agent = ? AND status IN ('in_progress','claimed')
           ORDER BY claimed_at DESC LIMIT 1`
        ).get(agent) as { description: string } | undefined
        if (activeTask?.description) {
          relevantQuery = activeTask.description
        } else {
          // Fallback: agent_sessions.current_task_id (set by write_status).
          const sess = db.prepare(
            `SELECT current_task_id FROM agent_sessions WHERE agent = ?`
          ).get(agent) as { current_task_id: number | null } | undefined
          if (sess?.current_task_id) {
            const t = db.prepare(`SELECT description FROM tasks WHERE id = ?`).get(sess.current_task_id) as
              { description: string } | undefined
            if (t?.description) relevantQuery = t.description
          }
        }
      }

      // Build relevantMemories: BM25-relevance-LED, with pinned/role rows that
      // ALSO match the query guaranteed to surface. No query (or no results)
      // -> [] (backward-compat).
      //
      // Why relevance-led rather than pinned-first: there can be many (100+)
      // pinned rows (pin is used liberally to prevent decay). A naive
      // "all-pinned-first" fill would crowd the relevant hits out of the small
      // RELEVANT_LIMIT window entirely. Instead we lead with BM25 hits, then
      // guarantee any *relevant* pinned/role row is not dropped, and only use
      // leftover slots for top pinned rows. recall()'s candidate pool already
      // includes pinned rows, so a pinned row relevant to the task ranks
      // naturally; the separate `role` section independently guarantees role
      // rows are always shown.
      let relevantMemories: Memory[] = []
      if (relevantQuery) {
        const RELEVANT_LIMIT = 5
        // recall() applies access-tracking side-effects; that is desirable here
        // since these memories ARE being surfaced to the agent on boot.
        const ranked = this.recall(agent, { query: relevantQuery, limit: RELEVANT_LIMIT })

        const seen = new Set<number>()
        const merged: Memory[] = []
        // 1. Relevance-led: BM25 hits first (pinned-or-not).
        for (const m of ranked) {
          if (merged.length >= RELEVANT_LIMIT) break
          if (!seen.has(m.id)) { seen.add(m.id); merged.push(m) }
        }
        // 2. Backfill any leftover slots with top pinned/role rows so a slow day
        //    (few/no relevant hits) still yields a useful section. Ordered by
        //    quality/importance; capped by the leftover slot count.
        if (merged.length < RELEVANT_LIMIT) {
          const pinned = db.prepare(
            `SELECT * FROM memories
             WHERE (agent = ? OR agent = 'shared') AND pinned = 1 AND state != 'superseded'
             ORDER BY quality DESC, importance DESC
             LIMIT ?`
          ).all(agent, RELEVANT_LIMIT) as Memory[]
          for (const m of pinned) {
            if (merged.length >= RELEVANT_LIMIT) break
            if (!seen.has(m.id)) { seen.add(m.id); merged.push(m) }
          }
        }
        relevantMemories = merged.slice(0, RELEVANT_LIMIT)
      }

      return { role, topMemories, sharedMemories, recentTasks, relevantMemories, relevantQuery }
    })
  }

  getZeroImportanceIds(): number[] {
    return this.taskDb.run(db =>
      (db.prepare('SELECT id FROM memories WHERE importance <= 0 AND pinned = 0').all() as { id: number }[]).map(r => r.id)
    )
  }

  getDecayCandidate(): Memory[] {
    // Durability is governed by `pinned`, not by `classification`. Foundational
    // rows are no longer hardcoded-exempt — they decay normally subject to the
    // foundational-window in getDecayWindowDays. Pin to make a row survive.
    // See task #823 (revert of #804): the saveMemory coercion gate was the
    // wrong layer; removing this exemption is the simpler fix.
    return this.taskDb.run(db => db.prepare(`
      SELECT * FROM memories
      WHERE pinned = 0
        AND last_accessed < datetime('now', '-1 days')
        AND importance > 0
        AND state != 'superseded'
    `).all() as Memory[])
  }

  decayMemory(id: number, newImportance: number): void {
    this.taskDb.run(db => db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(newImportance, id))
  }

  archiveMemory(id: number): void {
    this.taskDb.run(db => {
      db.prepare(`
        INSERT INTO memory_archive (id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count, classification, quality, state, source_type, evidence, support_count, challenge_count, supersedes_memory_id, last_validated)
        SELECT id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count, classification, quality, state, source_type, evidence, support_count, challenge_count, supersedes_memory_id, last_validated FROM memories WHERE id = ?
      `).run(id)
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    })
  }

  getSupersededOlderThan(days: number): number[] {
    return this.taskDb.run(db =>
      (db.prepare(`
        SELECT id FROM memories
        WHERE state = 'superseded'
        AND last_accessed < datetime('now', '-' || ? || ' days')
      `).all(days) as { id: number }[]).map(r => r.id)
    )
  }

  pruneArchive(daysOld: number): number {
    return this.taskDb.run(db => {
      const result = db.prepare(`
        DELETE FROM memory_archive WHERE archived_at < datetime('now', '-' || ? || ' days')
      `).run(daysOld)
      return result.changes
    })
  }

  listAgents(): string[] {
    return this.taskDb.run(db => {
      const rows = db.prepare(
        `SELECT DISTINCT agent FROM memories WHERE agent != 'shared' ORDER BY agent`
      ).all() as { agent: string }[]
      return rows.map(r => r.agent)
    })
  }
}
