import type { Database } from 'bun:sqlite'
import type { TaskDB, Task } from './db'
import {
  isDenseEnabled, denseMode, embedOne, putVector, getVectors,
  cosineNormalized, rrfFuse, vectorTableExists,
  denseRrfK, denseBm25K, denseDenseK,
} from './dense'
import { sanitizeMemoryContent } from './memory-integrity'
// P5 (EPIC-01/EPIC-05): shared write-ordering envelope + monotonic sequence.
import { withMemoryWriteTxn, nextWriteSeq } from './memory-ordering'
// P5 (ATM-033/REQ-027): test-only read->write interleave barrier. A complete
// no-op unless P5_TEST_BARRIER is set, so this import adds zero cost/behavior
// on any production or non-fault-injection test path.
import { waitForBarrier } from './tests/fixtures/concurrency-barrier'

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
  // P5 (REQ-010): nullable latest-write marker, stamped by nextWriteSeq() only
  // on the memory_write_ordering_enabled=1 path (saveMemory/challengeMemory/
  // supersedeMemory). NULL on every row written while the flag is OFF, and on
  // decision.ts-originated rows (out of scope for this stamp — see spec).
  write_seq: number | null
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

  /** ATM-026: exposes the P4 sanitization flag so extracted handlers (memory-handlers.ts)
   * can gate their own behavior without importing TaskDB directly. */
  isSanitizationEnabled(): boolean {
    return this.taskDb.isFeatureEnabled('memory_sanitization_enabled')
  }

  saveMemory(input: SaveMemoryInput): Memory {
    // P5 (ATM-002/REQ-002): CLOSES finding #9 — the feature flag lives on
    // `this.taskDb` (a TaskDB method), NEVER on the raw `db` handle passed
    // into a run()/withMemoryWriteTxn() callback, which has no such method.
    const orderingOn = this.taskDb.isFeatureEnabled('memory_write_ordering_enabled')
    if (orderingOn) {
      // P5 (REQ-026/ATM-031): invoked DIRECTLY against taskDb.getHandle() —
      // never nested inside taskDb.run(db => ...) — so TaskDB.run()'s
      // reconnect-and-replay can never wrap an open write transaction.
      return withMemoryWriteTxn(this.taskDb.getHandle(), db => this.saveMemoryCritical(db, input, true))
    }
    return this.taskDb.run(db => this.saveMemoryCritical(db, input, false))
  }

  /**
   * P5 Stage 2 (EPIC-02): the extracted saveMemory critical section. Preserves
   * ALL pre-existing P4 behavior byte-for-byte on the `orderingOn === false`
   * path (same sanitize call site, same dedup SELECT, same UPDATE-or-INSERT
   * SQL, same classification/state/clamp logic, same P4 audit rows). When
   * `orderingOn` is true, every mutating statement is ADDITIONALLY stamped
   * with a `write_seq` drawn from `nextWriteSeq()` (REQ-010) — the ON/OFF SQL
   * text is intentionally NOT shared so the OFF path never mentions
   * `write_seq` at all (REQ-022 additive-schema parity).
   */
  private saveMemoryCritical(db: Database, input: SaveMemoryInput, orderingOn: boolean): Memory {
    // P4 (#10376048): flag-gated anti-laundering hardening. When OFF, every
    // branch below is a strict no-op and this function is byte-for-byte the
    // pre-P4 implementation (same INSERT values, same state, no sanitize, no
    // clamp, no audit rows). See build brief Stage 2a for the full contract.
    const sanitizeOn = this.taskDb.isFeatureEnabled('memory_sanitization_enabled')

    // ATM-002: resolve source_type FIRST — caller-identity-only trust
    // resolution must be decided before any content is touched, and BEFORE
    // the dedup-normalize step (moved ahead of where it used to sit).
    const sourceType = input.source_type ?? this.inferSourceType(input.agent)

    // ATM-002: sanitize (flag ON) before dedup-normalize, so both the dedup
    // check and the persisted row see the neutralized text. Flag OFF ->
    // effectiveContent is the raw input, unchanged (byte parity). This call
    // executes on the SAME `db` handle/transaction instance passed into this
    // method — when orderingOn, that is the withMemoryWriteTxn() transaction
    // handle, so P5 wraps this whole (P4-augmented) critical section as one
    // atomic unit (REQ-003; composition-boundary verified via
    // isWriteTxnActive(), never by asserting on this call's own signature).
    let sanitizeResult: { text: string; neutralized: boolean; tripped?: string[] } | undefined
    let effectiveContent = input.content
    if (sanitizeOn) {
      sanitizeResult = sanitizeMemoryContent(input.content, { sourceType })
      effectiveContent = sanitizeResult.text
    }

    // Dedup check: normalize content and look for existing active memory
    const normalized = this.normalizeContent(effectiveContent)
    const existing = db.prepare(`
      SELECT * FROM memories
      WHERE agent = ? AND state = 'active'
      AND LOWER(TRIM(REPLACE(content, '  ', ' '))) = ?
    `).get(input.agent, normalized) as Memory | null

    // P5 (ATM-033/REQ-027b): read->write interleave barrier — flag-OFF branch
    // ONLY, at the exact boundary between the dedup SELECT above and the
    // UPDATE-or-INSERT below. No-op unless P5_TEST_BARRIER is set. Lives here
    // in saveMemoryCritical (a separate method from saveMemory's
    // withMemoryWriteTxn(...) call expression), so it is never lexically
    // inside that call — keeping the ATM-033(c) source-level regression check
    // green. NEVER wired into the orderingOn branch (REQ-027 forbids placing
    // this seam inside a withMemoryWriteTxn()-wrapped path).
    if (!orderingOn) {
      waitForBarrier(db, process.env.P5_TEST_BARRIER ?? 'savemem', Number(process.env.P5_BARRIER_COUNT ?? 0))
    }

    if (existing) {
      // No new INSERT happens on this path -> no P4 audit rows (flag OFF or ON).
      if (orderingOn) {
        // P5 (ATM-013/REQ-010): stamp write_seq on the dedup UPDATE. The ON/OFF
        // SQL text is branched (not shared) so the OFF path below never
        // mentions write_seq at all.
        const seq = nextWriteSeq(db)
        return db.prepare(`
          UPDATE memories SET support_count = support_count + 1, last_accessed = datetime('now'), write_seq = ?
          WHERE id = ?
          RETURNING *
        `).get(seq, existing.id) as Memory
      }
      return db.prepare(`
        UPDATE memories SET support_count = support_count + 1, last_accessed = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(existing.id) as Memory
    }

    // === ATM-006 classification/state block start ===
    const classification = input.classification ?? this.inferClassification(input.content, input.category)
    const quality = input.quality ?? 0.5
    const evidence = input.evidence ?? null
    const supersedes = input.supersedes_memory_id ?? null

    // Spec AC #5: agent + foundational -> proposed state
    let state: MemoryState = 'active'
    if (sourceType === 'agent' && classification === 'foundational') {
      state = 'proposed'
    }

    // ATM-003: a neutralized (laundered) memory can never look active,
    // regardless of source_type/classification — applies even to
    // source_type:'human'. Flag-gated only.
    if (sanitizeOn && sanitizeResult?.neutralized) {
      state = 'proposed'
    }
    // === ATM-006 classification/state block end ===

    // ATM-009: agent-tier durability clamp. A sanitized agent-authored write
    // cannot self-grant durability (high importance / pinned survival).
    // Flag OFF -> no clamp, values pass through exactly as before.
    let importance = input.importance ?? 3
    let pinned = input.pinned ? 1 : 0
    let durabilityClampDetail: string | null = null
    if (sanitizeOn && sourceType === 'agent') {
      const clampedImportance = Math.min(importance, 3)
      const clampedPinned = 0
      const parts: string[] = []
      if (clampedImportance !== importance) {
        parts.push(`importance ${importance}->${clampedImportance}`)
      }
      if (pinned !== clampedPinned) {
        parts.push(`pinned ${pinned ? 'true' : 'false'}->${clampedPinned ? 'true' : 'false'}`)
      }
      importance = clampedImportance
      pinned = clampedPinned
      if (parts.length > 0) durabilityClampDetail = parts.join(', ')
    }

    let saved: Memory
    if (orderingOn) {
      // P5 (ATM-013/REQ-010): stamp write_seq on the INSERT. The ON/OFF SQL
      // text is branched (not shared) so the OFF path never mentions
      // write_seq at all (REQ-022 additive-schema parity).
      const seq = nextWriteSeq(db)
      const stmt = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, source_task_id,
          classification, quality, state, source_type, evidence, supersedes_memory_id, write_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `)
      saved = stmt.get(
        input.agent,
        effectiveContent,
        input.category,
        importance,
        pinned,
        input.source_task_id ?? null,
        classification,
        quality,
        state,
        sourceType,
        evidence,
        supersedes,
        seq,
      ) as Memory
    } else {
      const stmt = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, source_task_id,
          classification, quality, state, source_type, evidence, supersedes_memory_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `)
      saved = stmt.get(
        input.agent,
        effectiveContent,
        input.category,
        importance,
        pinned,
        input.source_task_id ?? null,
        classification,
        quality,
        state,
        sourceType,
        evidence,
        supersedes,
      ) as Memory
    }

    // P4 audit trail (flag ON only; only reached on a genuine new INSERT —
    // the dedup early-return above never runs this).
    if (sanitizeOn) {
      if (sanitizeResult?.neutralized) {
        // ATM-018
        db.prepare(`
          INSERT INTO audit_log (agent, action, detail, memory_id)
          VALUES ('system', 'memory_content_neutralized', ?, ?)
        `).run(`tripped=${(sanitizeResult.tripped ?? []).join(',')}`, saved.id)

        // ATM-019
        if (sanitizeResult.tripped?.includes('forged-trust-marker')) {
          db.prepare(`
            INSERT INTO audit_log (agent, action, detail, memory_id)
            VALUES ('system', 'memory_marker_neutralized', ?, ?)
          `).run(`tripped=${(sanitizeResult.tripped ?? []).join(',')}`, saved.id)
        }
      }

      // ATM-020
      if (durabilityClampDetail) {
        db.prepare(`
          INSERT INTO audit_log (agent, action, detail, memory_id)
          VALUES ('system', 'memory_durability_clamped', ?, ?)
        `).run(durabilityClampDetail, saved.id)
      }
    }

    return saved
  }

  getMemory(id: number): Memory | null {
    return this.taskDb.run(db => db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null)
  }

  challengeMemory(id: number, reason: string): Memory | null {
    // P5 (ATM-005/REQ-004): CLOSES finding #9 — the feature flag lives on
    // `this.taskDb` (a TaskDB method), NEVER on the raw `db` handle passed
    // into a run()/withMemoryWriteTxn() callback, which has no such method.
    const orderingOn = this.taskDb.isFeatureEnabled('memory_write_ordering_enabled')
    if (orderingOn) {
      // P5 (REQ-026/ATM-031): invoked DIRECTLY against taskDb.getHandle() —
      // never nested inside taskDb.run(db => ...) — so TaskDB.run()'s
      // reconnect-and-replay can never wrap an open write transaction.
      return withMemoryWriteTxn(this.taskDb.getHandle(), db => this.challengeMemoryCritical(db, id, reason, true))
    }
    return this.taskDb.run(db => this.challengeMemoryCritical(db, id, reason, false))
  }

  /**
   * P5 Stage 3 (EPIC-03): the extracted challengeMemory critical section.
   * Preserves ALL pre-existing behavior byte-for-byte on the
   * `orderingOn === false` path (same SELECT, same compute, same UPDATE SQL
   * text, same audit_log INSERT). When `orderingOn` is true, the UPDATE is
   * ADDITIONALLY stamped with a `write_seq` drawn from `nextWriteSeq()`
   * (REQ-010) — the ON/OFF SQL text is intentionally NOT shared so the OFF
   * path never mentions `write_seq` at all (REQ-022 additive-schema parity).
   * The audit_log INSERT (REQ-005/ATM-007) stays in the SAME critical section
   * as the UPDATE — on the ON path that means the SAME withMemoryWriteTxn()
   * transaction, so an UPDATE failure means no audit row, and (since the
   * audit INSERT is the last statement before the transaction commits) an
   * audit-INSERT failure would also roll back the UPDATE — all-or-nothing.
   */
  private challengeMemoryCritical(db: Database, id: number, reason: string, orderingOn: boolean): Memory | null {
    const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null
    if (!existing) return null

    // P5 (ATM-033/REQ-027b): read->write interleave barrier — flag-OFF branch
    // ONLY, at the exact boundary between the SELECT above and the
    // compute+UPDATE below. No-op unless P5_TEST_BARRIER is set. Lives here
    // in challengeMemoryCritical (a separate method from challengeMemory's
    // withMemoryWriteTxn(...) call expression), so it is never lexically
    // inside that call — keeping the ATM-033(c) source-level regression check
    // green. NEVER wired into the orderingOn branch (REQ-027 forbids placing
    // this seam inside a withMemoryWriteTxn()-wrapped path).
    if (!orderingOn) {
      waitForBarrier(db, process.env.P5_TEST_BARRIER ?? 'challenge', Number(process.env.P5_BARRIER_COUNT ?? 0))
    }

    const newChallengeCount = existing.challenge_count + 1
    const shouldDispute = newChallengeCount > existing.support_count
    const newQuality = shouldDispute ? Math.max(existing.quality - 0.2, 0) : existing.quality
    const newState = shouldDispute ? 'disputed' : existing.state

    let updated: Memory
    if (orderingOn) {
      // P5 (ATM-013/REQ-010): stamp write_seq on the UPDATE. The ON/OFF SQL
      // text is branched (not shared) so the OFF path never mentions
      // write_seq at all (REQ-022 additive-schema parity).
      const seq = nextWriteSeq(db)
      updated = db.prepare(`
        UPDATE memories
        SET challenge_count = ?, quality = ?, state = ?, last_validated = datetime('now'), write_seq = ?
        WHERE id = ?
        RETURNING *
      `).get(newChallengeCount, newQuality, newState, seq, id) as Memory
    } else {
      updated = db.prepare(`
        UPDATE memories
        SET challenge_count = ?, quality = ?, state = ?, last_validated = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(newChallengeCount, newQuality, newState, id) as Memory
    }

    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, memory_id)
      VALUES ('system', 'memory_challenged', ?, ?)
    `).run(reason, id)

    return updated
  }

  supersedeMemory(oldId: number, newContent: string, reason: string): { old: Memory, new: Memory } | null {
    // P5 (ATM-008/REQ-006): CLOSES finding #9 — the feature flag lives on
    // `this.taskDb` (a TaskDB method), NEVER on the raw `db` handle passed
    // into a run()/withMemoryWriteTxn() callback, which has no such method.
    const orderingOn = this.taskDb.isFeatureEnabled('memory_write_ordering_enabled')
    if (orderingOn) {
      // P5 (REQ-026/ATM-031): invoked DIRECTLY against taskDb.getHandle() —
      // never nested inside taskDb.run(db => ...) — so TaskDB.run()'s
      // reconnect-and-replay can never wrap an open write transaction.
      return withMemoryWriteTxn(this.taskDb.getHandle(), db => this.supersedeMemoryCritical(db, oldId, newContent, reason, true))
    }
    return this.taskDb.run(db => this.supersedeMemoryCritical(db, oldId, newContent, reason, false))
  }

  /**
   * P5 Stage 4 (EPIC-04): the extracted supersedeMemory critical section.
   * Preserves ALL pre-existing behavior byte-for-byte on the
   * `orderingOn === false` path (same SELECT, same UNCONDITIONAL old-row
   * UPDATE with no state guard and no write_seq, same replacement INSERT SQL
   * text, same P4 sanitize/audit rows, same final memory_superseded audit
   * row). When `orderingOn` is true:
   *   - the old-row UPDATE gains `AND state != 'superseded'` (REQ-007) and is
   *     stamped with a write_seq drawn from nextWriteSeq() (REQ-010/ATM-013);
   *     if it affects zero rows (already superseded by a prior/concurrent
   *     call), supersedeMemory returns null WITHOUT running the replacement
   *     INSERT, after recording a memory_supersede_blocked_duplicate audit
   *     row (REQ-024/ATM-027);
   *   - the replacement INSERT is ALSO stamped with its OWN write_seq drawn
   *     from a SECOND nextWriteSeq() call (REQ-010) — two stamps per
   *     successful supersede, mirroring saveMemory's INSERT+dedup-UPDATE
   *     pair (ATM-013's "5 stamps across the 4-operation sequence" count).
   * The ON/OFF SQL text is intentionally NOT shared so the OFF path never
   * mentions write_seq or the state guard at all (REQ-022 additive-schema
   * parity).
   */
  private supersedeMemoryCritical(db: Database, oldId: number, newContent: string, reason: string, orderingOn: boolean): { old: Memory, new: Memory } | null {
    const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(oldId) as Memory | null
    if (!existing) return null

    // P5 (ATM-033/REQ-027b): read->write interleave barrier — flag-OFF branch
    // ONLY, at the exact boundary between the existing-row SELECT above and
    // the old-row UPDATE below. No-op unless P5_TEST_BARRIER is set. Lives
    // here in supersedeMemoryCritical (a separate method from
    // supersedeMemory's withMemoryWriteTxn(...) call expression), so it is
    // never lexically inside that call — keeping the ATM-033(c) source-level
    // regression check green. NEVER wired into the orderingOn branch (REQ-027
    // forbids placing this seam inside a withMemoryWriteTxn()-wrapped path).
    if (!orderingOn) {
      waitForBarrier(db, process.env.P5_TEST_BARRIER ?? 'supersede', Number(process.env.P5_BARRIER_COUNT ?? 0))
    }

    let old: Memory
    if (orderingOn) {
      // P5 (ATM-009/REQ-007): state-guarded UPDATE — if the target was
      // already superseded by a prior or concurrent call, this affects zero
      // rows. P5 (ATM-013/REQ-010): stamp write_seq on the old-row UPDATE.
      const seq = nextWriteSeq(db)
      const guarded = db.prepare(`
        UPDATE memories SET state = 'superseded', last_validated = datetime('now'), write_seq = ?
        WHERE id = ? AND state != 'superseded'
        RETURNING *
      `).get(seq, oldId) as Memory | undefined

      if (!guarded) {
        // P5 (ATM-027/REQ-024): duplicate-supersede rejected — audit the
        // decision, do NOT run the replacement INSERT, return null.
        db.prepare(`
          INSERT INTO audit_log (agent, action, detail, memory_id)
          VALUES ('system', 'memory_supersede_blocked_duplicate', ?, ?)
        `).run(`target=${oldId} reason=${reason}`, oldId)
        return null
      }
      old = guarded
    } else {
      // Unconditional — byte-identical to pre-P5 (REQ-022).
      old = db.prepare(`
        UPDATE memories SET state = 'superseded', last_validated = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(oldId) as Memory
    }

    // P4 (#10376048/ATM-025): flag-gated write-through sanitize for the supersede
    // path. Flag OFF -> byte-parity with pre-P4 behavior (raw content, hardcoded
    // state='active', no audit rows beyond the pre-existing memory_superseded one).
    // This call executes on the SAME db handle/transaction instance passed into
    // this method — when orderingOn, that is the withMemoryWriteTxn() transaction
    // handle, so P5 wraps this whole (P4-augmented) critical section as one
    // atomic unit (REQ-008; composition-boundary verified via isWriteTxnActive(),
    // never by asserting on this call's own signature).
    const sanitizeOn = this.taskDb.isFeatureEnabled('memory_sanitization_enabled')

    let sr: { text: string; neutralized: boolean; tripped?: string[] } | undefined
    let effectiveContent = newContent
    if (sanitizeOn) {
      sr = sanitizeMemoryContent(newContent, { sourceType: 'agent' })
      effectiveContent = sr.text
    }

    // Mirrors saveMemory's agent+foundational->proposed guard, which this path
    // otherwise bypasses since it hardcodes source_type='agent' and copies
    // existing.classification straight through.
    const foundationalDowngrade = sanitizeOn && existing.classification === 'foundational'
    const state: MemoryState = sanitizeOn && (sr!.neutralized || foundationalDowngrade) ? 'proposed' : 'active'

    let replacement: Memory
    if (orderingOn) {
      // P5 (ATM-013/REQ-010): SECOND nextWriteSeq() call — the old-row
      // UPDATE and the replacement INSERT each get their OWN stamp.
      const newSeq = nextWriteSeq(db)
      replacement = db.prepare(`
        INSERT INTO memories (agent, content, category, classification, quality, state, source_type, support_count, supersedes_memory_id, write_seq)
        VALUES (?, ?, ?, ?, 0.5, ?, 'agent', 0, ?, ?)
        RETURNING *
      `).get(existing.agent, effectiveContent, existing.category, existing.classification, state, oldId, newSeq) as Memory
    } else {
      replacement = db.prepare(`
        INSERT INTO memories (agent, content, category, classification, quality, state, source_type, support_count, supersedes_memory_id)
        VALUES (?, ?, ?, ?, 0.5, ?, 'agent', 0, ?)
        RETURNING *
      `).get(existing.agent, effectiveContent, existing.category, existing.classification, state, oldId) as Memory
    }

    if (sanitizeOn) {
      if (sr!.neutralized) {
        db.prepare(`
          INSERT INTO audit_log (agent, action, detail, memory_id)
          VALUES ('system', 'memory_content_neutralized', ?, ?)
        `).run(`tripped=${(sr!.tripped ?? []).join(',')}`, replacement.id)

        // REQ-016 (call-site-agnostic): whenever a forged trust marker is
        // among the tripped patterns, ALSO emit memory_marker_neutralized —
        // mirrors saveMemory's ATM-019 audit row for this same signal.
        if (sr!.tripped?.includes('forged-trust-marker')) {
          db.prepare(`
            INSERT INTO audit_log (agent, action, detail, memory_id)
            VALUES ('system', 'memory_marker_neutralized', ?, ?)
          `).run(`tripped=${(sr!.tripped ?? []).join(',')}`, replacement.id)
        }
      }
      if (foundationalDowngrade) {
        db.prepare(`
          INSERT INTO audit_log (agent, action, detail, memory_id)
          VALUES ('system', 'memory_durability_clamped', ?, ?)
        `).run('superseded foundational -> state proposed', replacement.id)
      }
    }

    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, memory_id)
      VALUES ('system', 'memory_superseded', ?, ?)
    `).run(`${reason} | old=${oldId} new=${replacement.id}`, replacement.id)

    return { old, new: replacement }
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

        // ---- dense channel: cosine over candidate vectors, top-K_d ----
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
        const denseTopK = scored.slice(0, denseDenseK()).map(s => s.id)

        // ---- fuse, OR pure dense ----
        let orderedIds: number[]
        if (denseMode() === 'dense') {
          orderedIds = denseTopK
        } else {
          // TRUE UNION-FUSION HYBRID (#10060816). The PRE-fix bug double-counted:
          // it fused `base` (BM25 sliced to the OUTPUT limit) against denseOrder=ALL,
          // so a semantic-only gold (dense-found, BM25 rank > limit) only ever got a
          // single (dense) RRF contribution and was buried just past the slice.
          // Fix: fuse the UNION of a DECOUPLED BM25 top-K_bm window ∪ a dense top-K_d
          // window — both independent of `limit` — so the gold participates in BOTH
          // channels. recallBm25Ids is side-effect-free (no touchRecalled). When FTS
          // is unavailable / the query has no usable MATCH expr, fall back to the LIKE
          // base order as the BM25 channel (preserves the degrade discipline).
          const matchExpr = filter.query ? this.sanitizeFtsQuery(filter.query) : ''
          const bm25TopK = (matchExpr.length > 0 && this.ftsAvailable(db))
            ? this.recallBm25Ids(db, agent, filter, matchExpr, denseBm25K())
            : base.map(m => m.id)
          orderedIds = rrfFuse([bm25TopK, denseTopK], denseRrfK())
        }

        // ---- Phase-1 re-assert (#10060804) on the FUSED ordering, THEN slice ----
        // The dense channel bypasses recallBm25/recallLike's debrief demote; without
        // this, a Session-Debrief aggregate surfaced via dense would silently regress
        // Phase-1. Demote aggregates to the bottom of the fused order, then slice to
        // limit — so Phase-1 holds regardless of which channel surfaced a row.
        const finalIds = this.demoteDebriefAndSlice(db, orderedIds, limit)

        // Materialize ONLY the final `limit` rows: reuse base rows, fetch the rest.
        const byId = new Map(base.map(m => [m.id, m]))
        const missing = finalIds.filter(id => !byId.has(id))
        if (missing.length > 0) {
          const rows = db.prepare(
            `SELECT * FROM memories WHERE id IN (${missing.map(() => '?').join(',')})`,
          ).all(...missing) as Memory[]
          for (const r of rows) byId.set(r.id, r)
        }
        const result = finalIds.map(id => byId.get(id)).filter((m): m is Memory => !!m)

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
   * Re-assert Phase-1 (#10060804) on a FUSED/dense id ordering (#10060816), then
   * slice to limit. Stable-demotes shared Session-Debrief aggregates to the BOTTOM
   * of the ordering (mirroring the BM25/LIKE demote) so the dense channel can't let
   * them crowd out the gold. Metadata is fetched via substr(content,1,80) so the
   * ~500KB debrief blobs never enter memory; isDebriefAggregate only inspects the
   * first ~30 chars. Side-effect-free.
   */
  private demoteDebriefAndSlice(db: any, orderedIds: number[], limit: number): number[] {
    if (orderedIds.length === 0) return orderedIds
    const meta = new Map<number, Pick<Memory, 'agent' | 'category' | 'content'>>()
    const rows = db.prepare(
      `SELECT id, agent, category, substr(content,1,80) AS content
       FROM memories WHERE id IN (${orderedIds.map(() => '?').join(',')})`,
    ).all(...orderedIds) as Array<{ id: number; agent: string; category: string; content: string }>
    for (const r of rows) meta.set(r.id, { agent: r.agent, category: r.category, content: r.content })
    const isAgg = (id: number): boolean => {
      const m = meta.get(id)
      return m ? this.isDebriefAggregate(m) : false
    }
    const keep = orderedIds.filter(id => !isAgg(id))
    const demoted = orderedIds.filter(id => isAgg(id))
    return [...keep, ...demoted].slice(0, limit)
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
   * Side-effect-free BM25 ranking CORE (#10060816). Joins memories_fts on
   * rowid=memories.id, pulls a candidate window ranked by raw bm25, applies the
   * quality/importance/recency blend + Phase-1 debrief demote, and returns the
   * blended-scored rows in rank order (best first). Does NOT touchRecalled and does
   * NOT slice to the output limit — callers slice to their own window. Shared by
   * recallBm25 (output path) and recallBm25Ids (the RRF BM25 top-K window) so both
   * rank identically.
   *
   * bm25() returns a score where MORE-NEGATIVE = MORE-relevant. We negate it so
   * larger = better, then min-max normalize across the candidate window to
   * [0,1]. quality is already ~[0,1]; importance is mapped from its [0,5] range;
   * recency is exp-style decay on age in days computed in SQL via julianday.
   */
  private rankBm25(db: any, agent: string, filter: RecallFilter, matchExpr: string, windowLimit: number): Array<{ row: Memory; score: number }> {
    const conditions = ['(m.agent = ? OR m.agent = ?)', "m.state != 'superseded'"]
    const params: unknown[] = [agent, 'shared']

    if (filter.category) {
      conditions.push('m.category = ?')
      params.push(filter.category)
    }

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
    const rows = db.prepare(sql).all(matchExpr, ...params, windowLimit) as Array<
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
    return blended
  }

  /**
   * BM25 relevance path (OUTPUT). Ranks via the shared rankBm25 core over the
   * generous candidate window (limit*5, min 50), slices to the output limit, applies
   * the recall side-effects, and returns rows. Byte-identical to the pre-#10060816
   * inline implementation (same window, blend, sort, slice, touchRecalled).
   */
  private recallBm25(db: any, agent: string, filter: RecallFilter, matchExpr: string, limit: number): Memory[] {
    const candidateWindow = Math.max(limit * 5, 50)
    const ranked = this.rankBm25(db, agent, filter, matchExpr, candidateWindow)
    if (ranked.length === 0) return []
    const top = ranked.slice(0, limit).map(b => b.row)
    this.touchRecalled(db, top.map(r => r.id))
    return top
  }

  /**
   * SIDE-EFFECT-FREE BM25 id window for RRF fusion (#10060816). Returns up to K top
   * BM25 ids in rank order WITHOUT touchRecalled — the fused output path applies the
   * recall side-effects to the final `limit` ids only. Pulls a candidate window of at
   * least K so the top-K is meaningful, and is DECOUPLED from the output limit (the
   * whole point of the union-fusion fix).
   */
  private recallBm25Ids(db: any, agent: string, filter: RecallFilter, matchExpr: string, K: number): number[] {
    const ranked = this.rankBm25(db, agent, filter, matchExpr, Math.max(K, 50))
    return ranked.slice(0, K).map(b => b.row.id)
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

  /**
   * ATM-029 (REQ-023): authority guard, flag-gated. An agent-authored memory
   * still sitting in 'proposed' state (i.e. not yet reviewed/accepted) cannot
   * be self- or peer-promoted to 'shared' by another agent — only a 'system'
   * or 'human' caller may do so. Flag OFF -> guard is skipped entirely and
   * behavior is byte-identical to pre-P4 (unconditional UPDATE).
   */
  promoteMemory(id: number, callerSourceType: SourceType): Memory | null {
    return this.taskDb.run(db => {
      if (this.isSanitizationEnabled()) {
        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null
        if (
          row && row.source_type === 'agent' && row.state === 'proposed' &&
          callerSourceType !== 'system' && callerSourceType !== 'human'
        ) {
          db.prepare(`
            INSERT INTO audit_log (agent, action, detail, memory_id)
            VALUES ('system', 'pin_promote_authority_denied', ?, ?)
          `).run(`promote denied: memory #${id} is agent-authored/proposed; caller source_type=${callerSourceType}`, id)
          return null
        }
      }
      return db.prepare(`
        UPDATE memories SET agent = 'shared' WHERE id = ? RETURNING *
      `).get(id) as Memory | null
    })
  }

  /**
   * Stage 7 KO-3 quarantine (P4 defense-in-depth, #10376063): force a
   * memory's state to 'proposed', regardless of its current state.
   *
   * Used by handleWriteHandoff (memory-handlers.ts) so a DETECTOR MISS in
   * an agent-tier-sanitized handoff body cannot reach active-filtered
   * trusted recall (topMemories/sharedMemories/getBootBriefing all filter
   * state='active') — the one path where a miss would otherwise elevate
   * trust+durability, since write_handoff itself asserts source_type:
   * 'system'/importance:5. session-boot.sh (the sole legitimate handoff
   * consumer) is widened to match state IN ('active','proposed') so a
   * quarantined handoff is still found for rehydration.
   */
  markMemoryProposed(id: number): Memory {
    return this.taskDb.run(db => db.prepare(`
      UPDATE memories SET state = 'proposed' WHERE id = ? RETURNING *
    `).get(id) as Memory)
  }

  /** ATM-029 (REQ-023): same authority guard as promoteMemory, for pin. */
  pinMemory(id: number, callerSourceType: SourceType): Memory | null {
    return this.taskDb.run(db => {
      if (this.isSanitizationEnabled()) {
        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null
        if (
          row && row.source_type === 'agent' && row.state === 'proposed' &&
          callerSourceType !== 'system' && callerSourceType !== 'human'
        ) {
          db.prepare(`
            INSERT INTO audit_log (agent, action, detail, memory_id)
            VALUES ('system', 'pin_promote_authority_denied', ?, ?)
          `).run(`pin denied: memory #${id} is agent-authored/proposed; caller source_type=${callerSourceType}`, id)
          return null
        }
      }
      return db.prepare(`
        UPDATE memories SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ? RETURNING *
      `).get(id) as Memory | null
    })
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

        // P4 gate #5 (flag-OFF byte-parity): the active-only filter on this
        // TRUSTED boot-briefing section is FLAG-GATED, read the same way P4
        // reads it in saveMemory/supersedeMemory (this.taskDb.isFeatureEnabled).
        //  - Flag OFF -> EXACT 921328b baseline: relevance-led admits ANY ranked
        //    row (recall()'s candidate pool is state != 'superseded'), and the
        //    pinned backfill uses state != 'superseded'. Byte parity restored.
        //  - Flag ON  -> active-only, matching role/topMemories/sharedMemories,
        //    so the P4 Stage-7 KO-3 write_handoff quarantine (state='proposed',
        //    #10376063) cannot ride a query-overlapping quarantined handoff into
        //    this trusted section — preserving "a detector miss can't reach
        //    active/trusted recall".
        const activeOnly = this.taskDb.isFeatureEnabled('memory_sanitization_enabled')

        const seen = new Set<number>()
        const merged: Memory[] = []
        // 1. Relevance-led: BM25 hits first (pinned-or-not). Flag ON additionally
        //    enforces active-only here (see activeOnly note above); flag OFF is
        //    the 921328b baseline that admits non-active ranked rows.
        for (const m of ranked) {
          if (merged.length >= RELEVANT_LIMIT) break
          if (activeOnly && m.state !== 'active') continue
          if (!seen.has(m.id)) { seen.add(m.id); merged.push(m) }
        }
        // 2. Backfill any leftover slots with top pinned/role rows so a slow day
        //    (few/no relevant hits) still yields a useful section. Ordered by
        //    quality/importance; capped by the leftover slot count. The state
        //    clause is flag-gated to match (1): flag ON -> state = 'active' (no
        //    proposed/disputed backfill into trusted recall); flag OFF ->
        //    state != 'superseded' (921328b baseline).
        if (merged.length < RELEVANT_LIMIT) {
          const pinnedStateClause = activeOnly ? "state = 'active'" : "state != 'superseded'"
          const pinned = db.prepare(
            `SELECT * FROM memories
             WHERE (agent = ? OR agent = 'shared') AND pinned = 1 AND ${pinnedStateClause}
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
