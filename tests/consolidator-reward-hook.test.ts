// tests/consolidator-reward-hook.test.ts — T4 PK-T4-2, EPIC-01 hook-site TDD.
//
// Covers the additive `consumePendingRewards()` call site wired into
// `MemoryConsolidator.run()`'s Phase-5 `scope==='all'` block:
//   - ATM-002 / REQ-002: fires exactly once under flag-ON + dryRun=false + scope='all'
//   - ATM-003 / REQ-003: flag-OFF → deterministic 6-key projection deep-equals the
//                        committed golden baseline; zero cursor writes; zero calls
//   - ATM-004 / REQ-004: dryRun=true → zero calls (no speculative fire); the
//                        reward consumer changes NOTHING vs a flag-OFF dryRun control
//   - ATM-028 / REQ-025: injected consumer throw is swallowed → projection still
//                        deep-equals the baseline, exactly one `reward_consumer_error`
//                        audit row, cursor uncorrupted, error never propagates
//
// SPY MECHANISM: `consolidator.ts` imports `consumePendingRewards` BY NAME, and
// these tests `spyOn(rewardConsumerModule, 'consumePendingRewards')` on an
// `import * as` namespace — Bun's spyOn patches the live ESM binding the module
// under test calls through (the exact convention documented in
// tests/memory-ordering.test.ts / tests/cross-family-critique.test.ts). NB
// `mock.module()` is NOT used: it leaks across files in this Bun (bun#12823).

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { TaskDB } from '../db'
import { MemoryConsolidator } from '../consolidator'
import type { RewardConsumptionResult } from '../verification/reward-consumer'
import * as rewardConsumerModule from '../verification/reward-consumer'
import {
  seedConsolidatorFixture,
  projectConsolidationBaseline,
  FIXTURE_TRIGGER_REASON,
} from './fixtures/reward-consumer-fixture'
import committedBaseline from './fixtures/consolidator-baseline.json'

const ZERO_RESULT: RewardConsumptionResult = {
  processed: 0,
  skippedNoLinkage: 0,
  skippedLocked: false,
  cursorMissing: false,
  abortedOnCursorFailure: false,
  leaseLost: false,
}

function wipeDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      unlinkSync(path + suffix)
    } catch {
      /* doesn't exist yet */
    }
  }
}

type CursorRow = {
  consumer: string
  last_consumed_reward_id: number
  claimed_by: string | null
  claimed_at: string | null
  updated_at: string
}

function readCursor(taskDb: TaskDB): CursorRow {
  return taskDb.run(
    (db) =>
      db
        .prepare("SELECT * FROM reward_consumption_cursor WHERE consumer = 'memory_importance'")
        .get() as CursorRow,
  )
}

/** Snapshot of the mutable memory state the reward consumer would touch. */
function readMemorySnapshot(taskDb: TaskDB): { id: number; importance: number; state: string }[] {
  return taskDb.run(
    (db) =>
      db.prepare('SELECT id, importance, state FROM memories ORDER BY id').all() as {
        id: number
        importance: number
        state: string
      }[],
  )
}

function countAuditRows(taskDb: TaskDB, action: string): number {
  return taskDb.run(
    (db) =>
      (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n,
  )
}

/** The current `importance` of a single memory row (the value the consumer would move). */
function readImportance(taskDb: TaskDB, id: number): number {
  return taskDb.run(
    (db) => (db.prepare('SELECT importance FROM memories WHERE id = ?').get(id) as { importance: number }).importance,
  )
}

// ---------------------------------------------------------------------------
// ATM-002 / REQ-002 [P1] — additive Phase-5 call site fires exactly once
// ---------------------------------------------------------------------------
describe('ATM-002: consumePendingRewards fires once under flag-ON + dryRun=false + scope=all (REQ-002)', () => {
  const TEST_DB = '/tmp/t4-hook-atm002.db'
  let taskDb: TaskDB
  let spy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    seedConsolidatorFixture(taskDb)
    taskDb.setFeatureFlag('reward_consumer_enabled', true)
  })
  afterEach(() => {
    spy?.mockRestore()
    spy = undefined
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-002: exactly one invocation per run() (flag ON, dryRun=false, scope=all)', async () => {
    spy = spyOn(rewardConsumerModule, 'consumePendingRewards').mockImplementation(() => ZERO_RESULT)
    const mem = new (require('../memory').MemoryDB)(taskDb)
    const c = new MemoryConsolidator(mem, taskDb, false, 50, 'all')
    await c.run(FIXTURE_TRIGGER_REASON)
    expect(spy).toHaveBeenCalledTimes(1)
    // Called with the production arg shape: (taskDb, mem), no test-seam opts.
    expect(spy.mock.calls[0].length).toBe(2)
  })

  test('ATM-002: a scoped (non-all) run never reaches the hook even with flag ON', async () => {
    spy = spyOn(rewardConsumerModule, 'consumePendingRewards').mockImplementation(() => ZERO_RESULT)
    const mem = new (require('../memory').MemoryDB)(taskDb)
    const c = new MemoryConsolidator(mem, taskDb, false, 50, 'agent:boss')
    await c.run(FIXTURE_TRIGGER_REASON)
    expect(spy).toHaveBeenCalledTimes(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-003 / REQ-003 [P1] — flag-OFF golden-baseline byte parity
// ---------------------------------------------------------------------------
describe('ATM-003: flag-OFF deterministic projection deep-equals committed baseline (REQ-003)', () => {
  const TEST_DB = '/tmp/t4-hook-atm003.db'
  let taskDb: TaskDB
  let spy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    seedConsolidatorFixture(taskDb)
    // Flag left at its default (OFF) — no setFeatureFlag call.
  })
  afterEach(() => {
    spy?.mockRestore()
    spy = undefined
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-003: projection deep-equals baseline; zero calls; zero cursor writes', async () => {
    const cursorBefore = readCursor(taskDb)
    spy = spyOn(rewardConsumerModule, 'consumePendingRewards').mockImplementation(() => ZERO_RESULT)

    const mem = new (require('../memory').MemoryDB)(taskDb)
    const c = new MemoryConsolidator(mem, taskDb, false, 50, 'all')
    const result = await c.run(FIXTURE_TRIGGER_REASON)

    // Byte-parity with the committed pre-T4 golden baseline.
    expect(projectConsolidationBaseline(result)).toEqual(committedBaseline)
    // The flag-OFF guard short-circuits before the call.
    expect(spy).toHaveBeenCalledTimes(0)
    // Zero cursor writes — the row is byte-identical to before the run.
    expect(readCursor(taskDb)).toEqual(cursorBefore)
    expect(readCursor(taskDb).last_consumed_reward_id).toBe(0)
  })

  test('ATM-003: the committed baseline is the expected 6-key shape (no runId/durationMs)', () => {
    expect(Object.keys(committedBaseline as object).sort()).toEqual(
      ['triggerReason', 'phasesCompleted', 'mutations', 'dryRun', 'summary', 'scope'].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// ATM-004 / REQ-004 [P2] — dryRun never speculatively fires the consumer
// ---------------------------------------------------------------------------
describe('ATM-004: dryRun=true → zero consumer invocations, zero consumer-driven change (REQ-004)', () => {
  const TEST_DB = '/tmp/t4-hook-atm004.db'
  const CTRL_DB = '/tmp/t4-hook-atm004-ctrl.db'
  let taskDb: TaskDB
  let spy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    seedConsolidatorFixture(taskDb)
    taskDb.setFeatureFlag('reward_consumer_enabled', true) // flag ON, but dryRun must still suppress it
  })
  afterEach(() => {
    spy?.mockRestore()
    spy = undefined
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
    wipeDbFile(CTRL_DB)
  })

  test('ATM-004: flag-ON + dryRun=true → zero calls, cursor untouched, state identical to a flag-OFF dryRun control', async () => {
    const cursorBefore = readCursor(taskDb)
    spy = spyOn(rewardConsumerModule, 'consumePendingRewards').mockImplementation(() => ZERO_RESULT)

    const mem = new (require('../memory').MemoryDB)(taskDb)
    const c = new MemoryConsolidator(mem, taskDb, true, 50, 'all') // dryRun=true
    await c.run(FIXTURE_TRIGGER_REASON)

    // REQ-004: the one-way cursor-advancing consumer must NOT fire speculatively.
    expect(spy).toHaveBeenCalledTimes(0)
    // The consumer never advanced/leased the cursor.
    expect(readCursor(taskDb)).toEqual(cursorBefore)

    // "memories.importance unchanged" (by the CONSUMER): Phase-5 decay/archive
    // still run under scope='all' regardless of dryRun (the documented
    // Ground-truth quirk T4 does NOT copy), so importance is NOT unchanged vs
    // seed. The faithful assertion is that enabling the flag under dryRun
    // changes NOTHING vs a flag-OFF dryRun control on an identical fixture.
    const testState = readMemorySnapshot(taskDb)

    wipeDbFile(CTRL_DB)
    const ctrlDb = new TaskDB(CTRL_DB)
    try {
      const ctrlMem = seedConsolidatorFixture(ctrlDb) // flag left OFF
      const ctrl = new MemoryConsolidator(ctrlMem, ctrlDb, true, 50, 'all')
      await ctrl.run(FIXTURE_TRIGGER_REASON)
      const ctrlState = readMemorySnapshot(ctrlDb)
      expect(testState).toEqual(ctrlState)
    } finally {
      ctrlDb.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-028 / REQ-025 [P1] — swallow-on-throw fault injection
// ---------------------------------------------------------------------------
describe('ATM-028: injected consumer throw is swallowed, run() unaffected (REQ-025)', () => {
  const TEST_DB = '/tmp/t4-hook-atm028.db'
  let taskDb: TaskDB
  let consumerSpy: ReturnType<typeof spyOn> | undefined
  let errSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    seedConsolidatorFixture(taskDb)
    taskDb.setFeatureFlag('reward_consumer_enabled', true)
  })
  afterEach(() => {
    consumerSpy?.mockRestore()
    consumerSpy = undefined
    errSpy?.mockRestore()
    errSpy = undefined
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-028: consumer throw → run() projection deep-equals baseline, one audit row, cursor uncorrupted, no propagation', async () => {
    const cursorBefore = readCursor(taskDb)
    // Silence the deliberate one-line console.error the swallow path emits.
    errSpy = spyOn(console, 'error').mockImplementation(() => {})
    consumerSpy = spyOn(rewardConsumerModule, 'consumePendingRewards').mockImplementation(() => {
      throw new Error('injected consumer fault')
    })

    const mem = new (require('../memory').MemoryDB)(taskDb)
    const c = new MemoryConsolidator(mem, taskDb, false, 50, 'all')

    let result: Awaited<ReturnType<MemoryConsolidator['run']>> | undefined
    await expect(
      (async () => {
        result = await c.run(FIXTURE_TRIGGER_REASON)
      })(),
    ).resolves.toBeUndefined() // run() itself never rejects

    // The consumer DID fire (and threw).
    expect(consumerSpy).toHaveBeenCalledTimes(1)
    // Swallow guarantee: run()'s deterministic projection is byte-identical to
    // the pre-T4 baseline despite the fault.
    expect(projectConsolidationBaseline(result!)).toEqual(committedBaseline)
    // Error recorded exactly once (one audit row + the one console.error line).
    expect(countAuditRows(taskDb, 'reward_consumer_error')).toBe(1)
    expect(errSpy).toHaveBeenCalledTimes(1)
    // No partial cursor corruption — the spy threw before touching the cursor.
    expect(readCursor(taskDb)).toEqual(cursorBefore)
    expect(readCursor(taskDb).last_consumed_reward_id).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-023 / REQ-022 [P1] — flag-OFF END-TO-END data-layer byte-parity.
//
// DISTINCT from ATM-003 (which deep-equals run()'s deterministic 6-key
// PROJECTION to the committed golden baseline at the call-site layer). ATM-023
// proves the underlying DATA LAYER the reward consumer would mutate — the
// reward_consumption_cursor row, the linked memory's importance, and the
// reward_consumed/reward_consumer_error audit rows — is byte-identical after a
// full flag-OFF end-to-end run, seeded so it WOULD move if the consumer fired.
//
// NO spy: unlike ATM-003, this drives the REAL (unmocked) flag-OFF guard — the
// real consumer must be short-circuited and the real data left pristine.
// ---------------------------------------------------------------------------
describe('ATM-023: flag-OFF full-pipeline end-to-end data-layer parity (REQ-022)', () => {
  const TEST_DB = '/tmp/t4-hook-atm023.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    // Flag left at its default (OFF) — no setFeatureFlag call.
  })
  afterEach(() => {
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-023: a would-change-if-on reward+memory pair is byte-untouched after a full flag-OFF run() (cursor + importance + audit)', async () => {
    // (1) Seed the deterministic consolidator workload (ATM-003 idiom) …
    const seededMem = seedConsolidatorFixture(taskDb)
    // … PLUS a "would-change-if-on" pair the consumer WOULD move if it fired:
    //   a FRESH, active, importance=2, UNIQUE-content memory tagged with a
    //   source_task_id, and a pending +1 reward carrying that same task_id.
    //   Recent (default last_accessed=now) + unique + active means the
    //   consolidator's OWN gather/decay/archive/prune all skip it (decay needs
    //   last_accessed < now-1d; archive needs importance<=0 or superseded;
    //   gather needs stale/duplicate/disputed) — so the ONLY thing that would
    //   move its importance is the reward consumer, which is OFF. That is what
    //   makes this flag-OFF parity assertion meaningful.
    const LINKED_TASK = 92300
    const linked = seededMem.saveMemory({
      agent: 'boss',
      content: 'ATM-023 reward-linked memory (unique, recent, active)',
      category: 'fact',
      importance: 2,
      source_task_id: LINKED_TASK,
    })
    taskDb.run((db) =>
      db
        .prepare(
          `INSERT INTO ternary_rewards
             (policy_version, decision_id, task_id, subject_kind, cross_family_verdict,
              failure_severity, failure_signal_available, reward, created_at)
           VALUES (1, NULL, ?, 'decision', NULL, NULL, 1, 1, datetime('now'))`,
        )
        .run(LINKED_TASK),
    )

    // Sanity: the flag really is OFF (default), so the consumer must be skipped.
    expect(taskDb.isFeatureEnabled('reward_consumer_enabled')).toBe(false)

    // (2) Capture BEFORE: the linked memory's importance + the full cursor row.
    const importanceBefore = readImportance(taskDb, linked.id)
    expect(importanceBefore).toBe(2) // seeded value; +1 reward WOULD raise it to 3 if consumed
    const cursorBefore = readCursor(taskDb)
    expect(cursorBefore.last_consumed_reward_id).toBe(0)
    expect(cursorBefore.claimed_by).toBeNull()
    expect(cursorBefore.claimed_at).toBeNull()

    // (3) Run the full consolidator END-TO-END, flag OFF, dryRun=false,
    //     scope='all' (the ATM-003 instantiation idiom). NO spy — the real
    //     flag-OFF guard must skip the real consumer.
    const mem = new (require('../memory').MemoryDB)(taskDb)
    const c = new MemoryConsolidator(mem, taskDb, false, 50, 'all')
    await c.run(FIXTURE_TRIGGER_REASON)

    // (4a) CURSOR: ZERO writes beyond the migrate() seed — last_consumed_reward_id
    //      still 0, claimed_by NULL, claimed_at NULL; byte-identical row overall.
    const cursorAfter = readCursor(taskDb)
    expect(cursorAfter.last_consumed_reward_id).toBe(0)
    expect(cursorAfter.claimed_by).toBeNull()
    expect(cursorAfter.claimed_at).toBeNull()
    expect(cursorAfter).toEqual(cursorBefore) // includes updated_at — no upsert touched it

    // (4b) IMPORTANCE: ZERO change on the reward-linked memory.
    expect(readImportance(taskDb, linked.id)).toBe(importanceBefore)
    expect(readImportance(taskDb, linked.id)).toBe(2)

    // (4c) AUDIT: ZERO consumer rows of either action.
    expect(countAuditRows(taskDb, 'reward_consumed')).toBe(0)
    expect(countAuditRows(taskDb, 'reward_consumer_error')).toBe(0)
  })
})
