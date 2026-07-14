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
