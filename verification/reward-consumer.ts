// verification/reward-consumer.ts — T4 reward-consumer / memory-importance
// learning loop (KO-sweep P8-KO-2, card #10376182).
//
// FOUNDATION PACKET (PK-T4-3 scaffold) ONLY: this file lays down the module
// shape, named constants, the import allowlist, and the pure cursor-read
// accessor. `consumePendingRewards()` below is a minimal, correctly-typed
// STUB — the full lease + cursor + consume logic (EPIC-02
// REQ-008/024/028..035) and the decision->memory linkage / importance-
// mapping logic (EPIC-03/EPIC-04) are LATER packets. See
// T4-reward-consumer-spec.md for the full contract this module will grow
// into.
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- REQ-026: the
// allowlisted value import, wired up by a later packet's full consume logic.
import { getTernaryRewards } from './ternary-reward'
// PersistedTernaryReward: type-only, wired up by a later packet.
import type { PersistedTernaryReward } from './ternary-reward'

// ---------------------------------------------------------------------------
// REQ-015 — named constants. No inlined magic numbers in this module or in
// the full consume/lease/advance logic a later packet adds.
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

// ---------------------------------------------------------------------------
// REQ-001 — batch entrypoint. SCAFFOLD STUB in this packet (see the module
// doc-comment above): performs no lease acquisition, no cursor read/advance,
// no `getTernaryRewards()` call, and no memory mutation. The two `opts`
// callbacks are TEST-ONLY observation seams (invoked, when supplied, (i)
// immediately after each per-row cursor commit and (ii) immediately after
// each row's memory-id resolution completes and before any mutation for
// that row, respectively — REQ-001); this stub never invokes either since it
// processes zero rows. The production call site (a later packet's
// `consolidator.ts` Phase-5 wiring) passes neither.
// ---------------------------------------------------------------------------

export function consumePendingRewards(
  taskDb: TaskDB,
  mem: MemoryDB,
  opts?: {
    limit?: number
    onRowConsumed?: (rewardId: number) => void
    onMemoriesResolved?: (rewardId: number, memoryIds: number[]) => void
  },
): RewardConsumptionResult {
  // TODO(PK-T4-3): full lease+cursor+consume logic
  return {
    processed: 0,
    skippedNoLinkage: 0,
    skippedLocked: false,
    cursorMissing: false,
    abortedOnCursorFailure: false,
    leaseLost: false,
  }
}

// ---------------------------------------------------------------------------
// REQ-007 — pure read cursor accessor.
// ---------------------------------------------------------------------------

/**
 * Returns the durable `last_consumed_reward_id` for `consumer` (default
 * `'memory_importance'`), or `0` if no row exists for it. A PURE READ — it
 * NEVER throws, whether the row is missing, the table is missing, or the
 * lookup otherwise errors (all such cases default to `0`). The `0`-on-
 * missing-row default is NOT a processing authorization by itself — a later
 * packet's REQ-032 governs what `consumePendingRewards()` may do when the
 * row is missing at batch start (fail-closed, not a silent `0` proceed).
 */
export function getRewardConsumptionCursor(db: Database, consumer: string = 'memory_importance'): number {
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
