// tests/fixtures/reward-consumer-fixture.ts — T4 reward-consumer golden-baseline
// seed fixture (PK-T4-2, EPIC-01 / ATM-003 / ATM-028).
//
// `seedConsolidatorFixture()` seeds a DETERMINISTIC, FIXED set of `memories`
// plus pending `ternary_rewards` rows into a freshly-migrated TaskDB. Every
// age-sensitive timestamp is pinned to a SATURATING-OLD absolute value
// (`FIXED_TS`, year 2020) so the decay/stale/archive/prune arithmetic in
// `consolidator.ts` + `consolidate.ts` — all of which compare against
// `Date.now()` — lands in the same saturated bucket on every run, forever.
// That makes `MemoryConsolidator.run('all')`'s DETERMINISTIC PROJECTION (see
// `projectConsolidationBaseline`) reproducible run-to-run and stable across
// wall-clock drift, which is the whole point of the ATM-003 golden baseline.
//
// A fixed-RECENT timestamp would be a time-bomb (a "fresh" row silently
// crosses its decay window as real time advances, changing the projection and
// breaking the committed baseline); a saturating-old timestamp never does.
//
// The pending `ternary_rewards` rows exist so the flag-OFF regression (ATM-003)
// and the swallow-on-throw fault injection (ATM-028) run against a fixture that
// genuinely HAS unconsumed rewards (cursor seed = 0) — proving the flag-OFF /
// dryRun / swallow guards hold even when there is real work the consumer COULD
// have done.

import type { TaskDB } from '../../db'
import { MemoryDB } from '../../memory'
import type { ConsolidationResult } from '../../consolidator'

/** Saturating-old, absolute, fixed timestamp — see module doc-comment. */
export const FIXED_TS = '2020-01-01 00:00:00'

/** Stable trigger-reason string used for both baseline capture and the test. */
export const FIXTURE_TRIGGER_REASON = 'baseline-fixture'

/**
 * Seed the deterministic consolidator fixture into `taskDb` (assumed freshly
 * migrated / empty). Returns a `MemoryDB` bound to the same TaskDB for the
 * caller's convenience. Seeds:
 *   - 5 active, unpinned, operational (`category: 'fact'`) memories, two of
 *     which share identical content (a deterministic `duplicate` signal), the
 *     other three distinct — all stamped `FIXED_TS` (created_at + last_accessed)
 *     so they saturate the stale/decay arithmetic identically every run.
 *   - 4 pending `ternary_rewards` rows (ids 1..4, mixed -1/0/1 rewards),
 *     stamped `FIXED_TS`, all with id > the seeded cursor HWM (0).
 */
export function seedConsolidatorFixture(taskDb: TaskDB): MemoryDB {
  const mem = new MemoryDB(taskDb)

  const rows: { content: string; importance: number }[] = [
    { content: 'duplicate fact alpha', importance: 3 },
    { content: 'duplicate fact alpha', importance: 3 },
    { content: 'distinct fact beta', importance: 3 },
    { content: 'distinct fact gamma', importance: 2 },
    { content: 'distinct fact delta', importance: 4 },
  ]

  for (const r of rows) {
    const saved = mem.saveMemory({ agent: 'boss', content: r.content, category: 'fact', importance: r.importance })
    // Pin every age-sensitive timestamp to FIXED_TS so decay/stale/archive
    // arithmetic saturates deterministically (see module doc-comment).
    taskDb.run(db =>
      db
        .prepare('UPDATE memories SET created_at = ?, last_accessed = ? WHERE id = ?')
        .run(FIXED_TS, FIXED_TS, saved.id),
    )
  }

  // Pending reward backlog (cursor HWM is seeded at 0 by migrate(), so every
  // row here is "pending"). decision_id / task_id left NULL to avoid any FK
  // dependency on seeded decisions/tasks.
  const rewards = [1, -1, 0, 1]
  taskDb.run(db => {
    const stmt = db.prepare(
      `INSERT INTO ternary_rewards
         (policy_version, decision_id, task_id, subject_kind, cross_family_verdict,
          failure_severity, failure_signal_available, reward, created_at)
       VALUES (1, NULL, NULL, 'decision', NULL, NULL, 1, ?, ?)`,
    )
    for (const reward of rewards) stmt.run(reward, FIXED_TS)
  })

  return mem
}

/**
 * The DETERMINISTIC PROJECTION of a `ConsolidationResult` used by the ATM-003
 * golden baseline and the ATM-028 swallow-on-throw check: EXACTLY the six keys
 * `{triggerReason, phasesCompleted, mutations, dryRun, summary, scope}`,
 * EXCLUDING the nondeterministic `runId` (autoincrement) and `durationMs`
 * (wall-clock). Single source of truth so the committed baseline and the tests
 * project identically.
 */
export function projectConsolidationBaseline(result: ConsolidationResult): {
  triggerReason: string
  phasesCompleted: string[]
  mutations: number
  dryRun: boolean
  summary: string
  scope: string
} {
  return {
    triggerReason: result.triggerReason,
    phasesCompleted: result.phasesCompleted,
    mutations: result.mutations,
    dryRun: result.dryRun,
    summary: result.summary,
    scope: result.scope,
  }
}
