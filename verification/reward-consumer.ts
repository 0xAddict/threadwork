// verification/reward-consumer.ts — T4 reward-consumer / memory-importance
// learning loop (KO-sweep P8-KO-2, card #10376182).
//
// PK-T4-3 (EPIC-02, exactly-once core) implements the durable lease + HWM
// cursor + per-row monotonic-upsert advance that make `consumePendingRewards()`
// exactly-once under concurrent/resumed-holder operation, plus the primary
// `source_task_id` linkage resolution and the bounded, clamped ±1 importance
// map needed to observe per-row effects. The SUPPLEMENTARY decision-summary
// linkage path (EPIC-04 REQ-019 `decisions.memory_id`) and the dedicated
// EPIC-03/04/05 verifier ATMs are LATER packets (PK-T4-4/PK-T4-5/PK-T4-6). See
// T4-reward-consumer-spec.md for the full contract.
//
// ---------------------------------------------------------------------------
// CROSS-SPEC T1 PRUNE CONTRACT (REQ-010, ATM-010).
//
// The `reward_consumption_cursor` table (created in `db.ts`'s `migrate()`)
// and `getRewardConsumptionCursor()` below are the STABLE, DURABLE,
// cross-spec READ contract a future retention/pruning consumer (T1,
// P8-KO-1) MUST honor, stated as follows (T1's spec adopts this contract
// verbatim; multi-consumer-safe by construction):
//
// (a) T1's prune bound for `ternary_rewards` =
//     `SELECT MIN(last_consumed_reward_id) FROM reward_consumption_cursor`
//     over ALL rows, computed INSIDE T1's own `BEGIN IMMEDIATE` prune
//     transaction, and T1's `DELETE` MUST be bounded to rows with
//     `id <=` that MIN.
//
// (b) FAIL-SAFE: IF `reward_consumer_enabled` is OFF, OR the
//     `reward_consumption_cursor` table is missing, OR it contains zero
//     rows, OR the MIN is not a valid non-negative integer, OR the HWM
//     lookup throws for any reason, THEN T1 MUST prune ZERO
//     `ternary_rewards` rows (T1's own `retention_prune_enabled` flag being
//     OFF independently disables ALL pruning upstream of this guard).
//
// (c) SECOND-CONSUMER RULE: a new consumer MUST register its cursor row
//     (starting `0`) BEFORE activation — the `0` row automatically freezes
//     `ternary_rewards` pruning until that consumer catches up; no contract
//     amendment is needed to add a consumer.
//
// (d) SAFETY ARGUMENT: every consumer advances durably post-consumption and
//     monotonically, so any `ternary_rewards` row with `id <=` MIN-HWM has
//     been consumed by every registered consumer; the in-txn read excludes
//     interleaved advances mid-prune.
// ---------------------------------------------------------------------------
//
// IMPORT ALLOWLIST (REQ-026/REQ-027, statically enforced by ATM-001): the
// ONLY value import from a sibling verification/db/memory module is
// `getTernaryRewards` (verification/ternary-reward.ts). `TaskDB` (db.ts),
// `MemoryDB` (memory.ts), `Database` (bun:sqlite), and
// `PersistedTernaryReward` (verification/ternary-reward.ts) are TYPE-ONLY
// imports. This module value-imports ZERO symbols from decision.ts,
// failure-classification.ts, or cross-family-critique.ts.

import type { TaskDB } from '../db'
import type { MemoryDB } from '../memory'
import type { Database } from 'bun:sqlite'
import { getTernaryRewards } from './ternary-reward'
import type { PersistedTernaryReward } from './ternary-reward'

// ---------------------------------------------------------------------------
// REQ-015 — named constants. No inlined magic numbers in this module or in
// the full consume/lease/advance logic.
// ---------------------------------------------------------------------------

/** Max pending `ternary_rewards` rows processed per `consumePendingRewards()` invocation (REQ-005). */
export const REWARD_CONSUMER_BATCH_LIMIT = 200

/** Consumer-level claim-lease duration — strictly > MemoryConsolidator's `HARD_TIME_LIMIT_MS` (15 min) (REQ-024/REQ-034). */
export const CLAIM_LEASE_MS = 30 * 60 * 1000

/** The additive/subtractive nudge applied to a linked memory's `importance` per rewarded row (REQ-011/REQ-012). */
export const REWARD_IMPORTANCE_DELTA = 1

/** Lower clamp bound for `memories.importance` (REQ-013/REQ-014). */
export const IMPORTANCE_MIN = 0

/** Upper clamp bound for `memories.importance` (REQ-013/REQ-014). */
export const IMPORTANCE_MAX = 5

/** The single consumer this module owns/serializes over (cursor + lease key). */
const CONSUMER = 'memory_importance'

/**
 * SQLite `datetime()` modifier for the lease-expiry cutoff, derived from the
 * named `CLAIM_LEASE_MS` constant so the takeover window is a single-constant
 * edit and never an inlined literal. Computed against `datetime('now')` INSIDE
 * SQL (not JS) so the string comparison always matches the stored
 * `datetime('now')` format exactly (REQ-024/REQ-034).
 */
const LEASE_EXPIRY_MODIFIER = `-${CLAIM_LEASE_MS / 1000} seconds`

// ---------------------------------------------------------------------------
// REQ-001 — batch entrypoint result shape.
// ---------------------------------------------------------------------------

export type RewardConsumptionResult = {
  processed: number
  skippedNoLinkage: number
  skippedLocked: boolean
  cursorMissing: boolean
  abortedOnCursorFailure: boolean
  leaseLost: boolean
}

type RewardConsumptionOpts = {
  limit?: number
  onRowConsumed?: (rewardId: number) => void
  onMemoriesResolved?: (rewardId: number, memoryIds: number[]) => void
}

/** Monotonic per-process counter so two invocations in the same millisecond still get distinct run ids. */
let __runCounter = 0

/** A per-invocation unique lease-owner id ("run id"), bound to `claimed_by`. */
function newRunId(): string {
  __runCounter += 1
  return `rc-${Date.now()}-${__runCounter}-${Math.random().toString(36).slice(2, 10)}`
}

// ---------------------------------------------------------------------------
// REQ-001 — batch entrypoint. Acquires the consumer LEASE (REQ-024), then
// drains up to `limit` pending reward rows in strict `id` order, advancing the
// durable HWM cursor ONE row per commit (REQ-008/REQ-028) behind a renewal-
// first own-lease verification, with a per-row pre-mutation own-lease gate
// (REQ-035) and cursor re-check (REQ-030). Releases the lease on every exit
// path via a guarded try/finally (REQ-033).
//
// The two `opts` callbacks are TEST-ONLY observation seams (REQ-001): invoked,
// when supplied, (i) `onRowConsumed` immediately AFTER each per-row cursor
// commit, and (ii) `onMemoriesResolved` immediately AFTER each row's memory-id
// resolution completes and BEFORE any mutation for that row. The production
// call site (`consolidator.ts` Phase-5) passes neither.
// ---------------------------------------------------------------------------

export function consumePendingRewards(
  taskDb: TaskDB,
  mem: MemoryDB,
  opts?: RewardConsumptionOpts,
): RewardConsumptionResult {
  const limit = opts?.limit ?? REWARD_CONSUMER_BATCH_LIMIT
  const runId = newRunId()
  const db = taskDb.getHandle()

  const result: RewardConsumptionResult = {
    processed: 0,
    skippedNoLinkage: 0,
    skippedLocked: false,
    cursorMissing: false,
    abortedOnCursorFailure: false,
    leaseLost: false,
  }

  // REQ-024 — acquire the batch lease inside a short BEGIN IMMEDIATE txn, with
  // the changes===0 branch decided from the SAME-TXN existence snapshot.
  const claim = acquireLease(db, runId)
  if (claim === 'locked') {
    // REQ-031 — another invocation holds a live lease; do nothing.
    result.skippedLocked = true
    return result
  }
  if (claim === 'missing') {
    // REQ-032 — integrity anomaly: the seed row is gone. FAIL CLOSED. Do NOT
    // recreate it; record exactly one error audit row and process nothing.
    insertConsumerErrorAudit(
      db,
      `reward_consumption_cursor row '${CONSUMER}' missing at batch start — fail-closed, zero rows processed (operator recovery required)`,
    )
    result.cursorMissing = true
    return result
  }

  // claim === 'acquired' — we now hold the lease; release it on every exit.
  try {
    const cursorAtStart = getRewardConsumptionCursor(db, CONSUMER)
    const pending = getTernaryRewards(db)
      .filter((r) => r.id > cursorAtStart)
      .slice(0, limit)

    for (const reward of pending) {
      const outcome = processRewardRow(db, mem, runId, reward, opts, result)
      if (outcome === 'leaseLost') {
        result.leaseLost = true
        return result
      }
      if (outcome === 'abortedOnCursorFailure') {
        result.abortedOnCursorFailure = true
        return result
      }
      if (outcome === 'ok') {
        result.processed += 1
      }
      // 'skipped' (REQ-030 re-check) → neither processed nor aborted; continue.
    }
    return result
  } finally {
    releaseLease(db, runId)
  }
}

type RowOutcome = 'ok' | 'skipped' | 'leaseLost' | 'abortedOnCursorFailure'

/**
 * Process ONE pending reward row (id = reward.id), fully, then advance the
 * cursor to it. Ordering (spec-normative):
 *   1. resolve target memories (linkage)                → `onMemoriesResolved` seam
 *   2. REQ-030 cursor re-check (skip if id <= stored)
 *   3. plan the bounded ±1 clamped mutations (reads only)
 *   4. IF there is a first mutation: REQ-035 pre-mutation own-lease gate,
 *      then apply every `decayMemory`, then one `reward_consumed` audit row
 *   5. REQ-008 advance: renewal-FIRST own-lease verify, THEN monotonic upsert
 *                                                       → `onRowConsumed` seam
 */
function processRewardRow(
  db: Database,
  mem: MemoryDB,
  runId: string,
  reward: PersistedTernaryReward,
  opts: RewardConsumptionOpts | undefined,
  result: RewardConsumptionResult,
): RowOutcome {
  // (1) Resolve the linked-memory set (EPIC-04 primary + supplementary paths).
  const memoryIds = resolveTargetMemories(db, mem, reward)
  // Test-only seam: fires after resolution, before any mutation for this row.
  opts?.onMemoriesResolved?.(reward.id, memoryIds.slice())

  // (2) REQ-030 — belt-and-suspenders cursor re-check before the first mutation.
  const cursorNow = getRewardConsumptionCursor(db, CONSUMER)
  if (reward.id <= cursorNow) {
    // Already consumed (lease-expiry overlap); skip the row entirely — no
    // mutation, no audit, no advance. Not counted as processed.
    return 'skipped'
  }

  // (3) Plan the mutations that would actually change a value (reads only).
  const planned: { id: number; newImportance: number }[] = []
  for (const id of memoryIds) {
    const m = mem.getMemory(id)
    if (!m) continue // REQ-020 defensive: resolved id vanished before getMemory
    const newImportance = computeNewImportance(m.importance, reward.reward)
    if (newImportance !== m.importance) planned.push({ id, newImportance })
  }

  // (4) Apply mutations behind the REQ-035 pre-mutation own-lease gate.
  if (planned.length > 0) {
    if (!renewOwnLease(db, runId)) {
      // REQ-035 — the lease was lost to a successor; abort BEFORE any mutation.
      return 'leaseLost'
    }
    for (const p of planned) {
      mem.decayMemory(p.id, p.newImportance)
    }
    // REQ-023 — one observability row per reward row that produced ≥1 real mutation.
    insertRewardConsumedAudit(db, reward, planned.length)
  }

  if (memoryIds.length === 0) {
    // REQ-018 — a fully graceful no-op (still advances the cursor below).
    result.skippedNoLinkage += 1
  }

  // (5) REQ-008/REQ-028/REQ-029 — advance the cursor to this row's id.
  const advance = advanceCursor(db, runId, reward.id)
  if (advance === 'leaseLost') return 'leaseLost'
  if (advance === 'changesNotOne') return 'abortedOnCursorFailure'

  // Test-only seam: fires immediately after the per-row cursor commit.
  opts?.onRowConsumed?.(reward.id)
  return 'ok'
}

// ---------------------------------------------------------------------------
// REQ-016/REQ-017/REQ-019 — target-memory resolution (read-only). Unions two
// deterministic linkage paths into one DEDUPLICATED Set:
//
//   PRIMARY (REQ-016/REQ-017): memories tagged with this reward row's
//   `source_task_id == reward.task_id` (active only). Skipped when
//   `reward.task_id` is null.
//
//   SUPPLEMENTARY (REQ-019): the finalize-summary memory a `finalizeDecision()`
//   auto-created for `reward.decision_id`, resolved via the `decisions.memory_id`
//   back-link. finalizeDecision()'s auto-memory INSERT never sets
//   `source_task_id`, so the PRIMARY path is structurally blind to it — this
//   back-link is the ONLY deterministic route. Read via a raw scalar SQL query
//   on the shared db handle (NOT a value-import from decision.ts, preserving the
//   REQ-026/REQ-027 import allowlist), then gated on an active-state check
//   through the already-passed `MemoryDB` handle. Skipped when
//   `reward.decision_id` is null, when `decisions.memory_id` is null, or when
//   the linked memory is absent/superseded. Deduplicated against the primary
//   result by the shared Set.
// ---------------------------------------------------------------------------
function resolveTargetMemories(db: Database, mem: MemoryDB, reward: PersistedTernaryReward): number[] {
  const ids = new Set<number>()

  // PRIMARY path (REQ-016/REQ-017).
  if (reward.task_id !== null && reward.task_id !== undefined) {
    const rows = db
      .prepare("SELECT id FROM memories WHERE source_task_id = ? AND state != 'superseded'")
      .all(reward.task_id) as { id: number }[]
    for (const r of rows) ids.add(r.id)
  }

  // SUPPLEMENTARY path (REQ-019) — the decision's own finalize-summary memory.
  if (reward.decision_id !== null && reward.decision_id !== undefined) {
    const decRow = db
      .prepare('SELECT memory_id FROM decisions WHERE id = ?')
      .get(reward.decision_id) as { memory_id: number | null } | undefined
    const summaryId = decRow?.memory_id
    if (summaryId !== null && summaryId !== undefined) {
      const m = mem.getMemory(summaryId)
      // Only union an ACTIVE (non-superseded) linked memory.
      if (m && m.state !== 'superseded') ids.add(summaryId)
    }
  }

  return [...ids]
}

// ---------------------------------------------------------------------------
// REQ-011/REQ-012/REQ-013/REQ-014 — bounded, symmetric, code-side-clamped ±1
// importance map. `+` reward raises by DELTA (clamped to IMPORTANCE_MAX), `-`
// lowers by DELTA (clamped to IMPORTANCE_MIN), neutral leaves it unchanged.
// Returns the current value unchanged when already at the clamp boundary so
// the caller skips the redundant same-value write (REQ-014).
// ---------------------------------------------------------------------------
function computeNewImportance(current: number, reward: PersistedTernaryReward['reward']): number {
  if (reward > 0) return Math.min(current + REWARD_IMPORTANCE_DELTA, IMPORTANCE_MAX)
  if (reward < 0) return Math.max(current - REWARD_IMPORTANCE_DELTA, IMPORTANCE_MIN)
  return current
}

// ---------------------------------------------------------------------------
// REQ-024 — acquire the batch lease. Returns:
//   'acquired' — this run now holds the lease (UPDATE changed 1 row)
//   'locked'   — a live lease is held by another run (changes 0, row exists)
//   'missing'  — the seed cursor row is absent (changes 0, row missing)
// The changes===0 branch is decided from the SAME-TRANSACTION existence
// snapshot (REQ-024, codex iter3 finding #2) — read between the UPDATE and the
// COMMIT, never in a later, separate read.
// ---------------------------------------------------------------------------
function acquireLease(db: Database, runId: string): 'acquired' | 'locked' | 'missing' {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const upd = db
      .prepare(
        `UPDATE reward_consumption_cursor
           SET claimed_by = ?, claimed_at = datetime('now')
         WHERE consumer = ?
           AND (claimed_by IS NULL OR claimed_at < datetime('now', ?))`,
      )
      .run(runId, CONSUMER, LEASE_EXPIRY_MODIFIER)

    if (upd.changes === 1) {
      db.prepare('COMMIT').run()
      return 'acquired'
    }

    // changes === 0 — decide the branch from the in-transaction existence read.
    const exists = db
      .prepare('SELECT 1 AS present FROM reward_consumption_cursor WHERE consumer = ?')
      .get(CONSUMER) as { present: number } | undefined
    db.prepare('COMMIT').run()
    return exists ? 'locked' : 'missing'
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    } catch {
      /* rollback best-effort */
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// REQ-035 — pre-mutation own-lease gate: a SHORT local BEGIN IMMEDIATE txn that
// renews `claimed_at` guarded on `claimed_by = <me>`. Returns false (→ abort
// with leaseLost) if the lease has been lost to a successor (changes === 0).
// ---------------------------------------------------------------------------
function renewOwnLease(db: Database, runId: string): boolean {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const r = db
      .prepare(
        `UPDATE reward_consumption_cursor
           SET claimed_at = datetime('now')
         WHERE consumer = ? AND claimed_by = ?`,
      )
      .run(CONSUMER, runId)
    db.prepare('COMMIT').run()
    return r.changes === 1
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    } catch {
      /* rollback best-effort */
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// REQ-008/REQ-028/REQ-029 — advance the cursor to `rewardId` in a LOCAL
// BEGIN IMMEDIATE txn. Sequences the GUARDED own-lease renewal FIRST; if the
// renewal reports changes===0 the lease was lost mid-batch → ROLLBACK + abort
// ('leaseLost'), and the monotonic upsert never runs (its INSERT arm is an
// unreachable structural backstop while renewal-first ordering holds). The
// upsert is a MONOTONIC `MAX()` UPSERT so the stored cursor can never regress.
// If the upsert reports changes!==1 (injected/anomalous) → ROLLBACK + abort
// ('changesNotOne' → abortedOnCursorFailure) per REQ-029.
// ---------------------------------------------------------------------------
function advanceCursor(db: Database, runId: string, rewardId: number): 'ok' | 'leaseLost' | 'changesNotOne' {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    // Renewal FIRST (REQ-008) — own-lease verification gates the advance.
    const renew = db
      .prepare(
        `UPDATE reward_consumption_cursor
           SET claimed_at = datetime('now')
         WHERE consumer = ? AND claimed_by = ?`,
      )
      .run(CONSUMER, runId)
    if (renew.changes === 0) {
      db.prepare('ROLLBACK').run()
      return 'leaseLost'
    }

    // Monotonic upsert (REQ-028) — MAX() guarantees the cursor never regresses.
    const up = db
      .prepare(
        `INSERT INTO reward_consumption_cursor (consumer, last_consumed_reward_id)
           VALUES (?, ?)
         ON CONFLICT(consumer) DO UPDATE SET
           last_consumed_reward_id = MAX(last_consumed_reward_id, excluded.last_consumed_reward_id),
           updated_at = datetime('now')`,
      )
      .run(CONSUMER, rewardId)
    if (up.changes !== 1) {
      db.prepare('ROLLBACK').run()
      return 'changesNotOne'
    }

    db.prepare('COMMIT').run()
    return 'ok'
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    } catch {
      /* rollback best-effort */
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// REQ-033 — guarded lease release, run in the batch's `finally`. The
// `claimed_by = <me>` guard makes a stale former holder's release a no-op that
// can never clobber a successor's live lease. Best-effort: a release failure
// self-heals via lease expiry and must never surface to the caller from a
// `finally`.
// ---------------------------------------------------------------------------
function releaseLease(db: Database, runId: string): void {
  try {
    db.prepare('BEGIN IMMEDIATE').run()
    try {
      db.prepare(
        `UPDATE reward_consumption_cursor
           SET claimed_by = NULL, claimed_at = NULL
         WHERE consumer = ? AND claimed_by = ?`,
      ).run(CONSUMER, runId)
      db.prepare('COMMIT').run()
    } catch (err) {
      try {
        db.prepare('ROLLBACK').run()
      } catch {
        /* rollback best-effort */
      }
      throw err
    }
  } catch {
    /* release is best-effort; a stuck lease self-heals via CLAIM_LEASE_MS expiry */
  }
}

// ---------------------------------------------------------------------------
// REQ-023 — one `reward_consumed` observability row per reward row that
// produced ≥1 real `decayMemory` call.
// ---------------------------------------------------------------------------
function insertRewardConsumedAudit(db: Database, reward: PersistedTernaryReward, memoriesUpdated: number): void {
  db.prepare(
    `INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('system', 'reward_consumed', ?, NULL)`,
  ).run(
    `decision_id=${reward.decision_id} task_id=${reward.task_id} reward=${reward.reward} memories_updated=${memoriesUpdated}`,
  )
}

// ---------------------------------------------------------------------------
// REQ-032 — the fail-closed error audit row emitted when the seed cursor row
// is missing at batch start.
// ---------------------------------------------------------------------------
function insertConsumerErrorAudit(db: Database, detail: string): void {
  db.prepare(
    `INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('system', 'reward_consumer_error', ?, NULL)`,
  ).run(detail)
}

// ---------------------------------------------------------------------------
// REQ-007 — pure read cursor accessor.
// ---------------------------------------------------------------------------

/**
 * Returns the durable `last_consumed_reward_id` for `consumer` (default
 * `'memory_importance'`), or `0` if no row exists for it. A PURE READ — it
 * NEVER throws, whether the row is missing, the table is missing, or the
 * lookup otherwise errors (all such cases default to `0`). The `0`-on-
 * missing-row default is NOT a processing authorization by itself — REQ-032
 * governs what `consumePendingRewards()` may do when the row is missing at
 * batch start (fail-closed, not a silent `0` proceed).
 */
export function getRewardConsumptionCursor(db: Database, consumer: string = CONSUMER): number {
  try {
    const row = db
      .prepare('SELECT last_consumed_reward_id FROM reward_consumption_cursor WHERE consumer = ?')
      .get(consumer) as { last_consumed_reward_id: number } | null
    if (!row || typeof row.last_consumed_reward_id !== 'number') return 0
    return row.last_consumed_reward_id
  } catch {
    return 0
  }
}
