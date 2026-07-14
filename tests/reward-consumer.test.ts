// tests/reward-consumer.test.ts — T4 reward-consumer TDD tests.
//
// FOUNDATION PACKET (PK-T4-3) ONLY — per T4-reward-consumer-spec.md, this
// packet covers:
//   - EPIC-04 flag seed:      ATM-022 (REQ-021) — reward_consumer_enabled
//   - EPIC-02 cursor table:   ATM-006 (REQ-006) — reward_consumption_cursor
//                              table + seed (db.ts migrate())
//   - EPIC-02 cursor read:    ATM-007 (REQ-007) — getRewardConsumptionCursor()
//   - EPIC-02 cursor doc:     ATM-010 (REQ-010) — module doc-comment contract
//   - EPIC-01 module scaffold: ATM-001 (REQ-001/REQ-026/REQ-027) —
//                              consumePendingRewards() signature + stub +
//                              import allowlist
//
// Later packets (EPIC-01 REQ-002..005/025, EPIC-02 REQ-008/009/024/
// 028..035, EPIC-03, EPIC-04 wiring) add their own ATMs to this file or a
// sibling `tests/consolidator-reward-hook.test.ts` — do NOT add assertions
// for consume/lease/advance/linkage logic here yet.

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import {
  REWARD_CONSUMER_BATCH_LIMIT,
  CLAIM_LEASE_MS,
  REWARD_IMPORTANCE_DELTA,
  IMPORTANCE_MIN,
  IMPORTANCE_MAX,
  consumePendingRewards,
  getRewardConsumptionCursor,
  type RewardConsumptionResult,
} from '../verification/reward-consumer'

/** Removes a sqlite db file plus its -shm/-wal sidecars, tolerating "doesn't exist". */
function wipeDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      unlinkSync(path + suffix)
    } catch {
      /* doesn't exist yet */
    }
  }
}

const MODULE_SOURCE = readFileSync(join(import.meta.dir, '..', 'verification', 'reward-consumer.ts'), 'utf8')

// ---------------------------------------------------------------------------
// ATM-006 / REQ-006 [P1] — reward_consumption_cursor table + seed
// ---------------------------------------------------------------------------
describe('ATM-006: reward_consumption_cursor table + seed (REQ-006)', () => {
  const TEST_DB = '/tmp/t4-rc-atm006.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => {
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-006: reward_consumption_cursor has exactly the documented columns', () => {
    const columns = taskDb.run((db) => db.prepare("PRAGMA table_info('reward_consumption_cursor')").all()) as {
      name: string
    }[]
    const columnNames = columns.map((c) => c.name).sort()
    expect(columnNames).toEqual(
      ['consumer', 'last_consumed_reward_id', 'claimed_by', 'claimed_at', 'updated_at'].sort(),
    )
  })

  test('ATM-006: consumer is TEXT PRIMARY KEY, last_consumed_reward_id is INTEGER NOT NULL DEFAULT 0', () => {
    const columns = taskDb.run((db) => db.prepare("PRAGMA table_info('reward_consumption_cursor')").all()) as {
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }[]
    const consumerCol = columns.find((c) => c.name === 'consumer')
    expect(consumerCol).toBeDefined()
    expect(consumerCol!.pk).toBe(1)
    expect(consumerCol!.type.toUpperCase()).toBe('TEXT')

    const cursorCol = columns.find((c) => c.name === 'last_consumed_reward_id')
    expect(cursorCol).toBeDefined()
    expect(cursorCol!.type.toUpperCase()).toBe('INTEGER')
    expect(cursorCol!.notnull).toBe(1)
    expect(cursorCol!.dflt_value).toBe('0')

    const updatedAtCol = columns.find((c) => c.name === 'updated_at')
    expect(updatedAtCol).toBeDefined()
    expect(updatedAtCol!.notnull).toBe(1)
  })

  test("ATM-006: exactly one seed row ('memory_importance', 0, NULL, NULL, <ts>) after fresh migrate()", () => {
    const rows = taskDb.run((db) => db.prepare('SELECT * FROM reward_consumption_cursor').all()) as {
      consumer: string
      last_consumed_reward_id: number
      claimed_by: string | null
      claimed_at: string | null
      updated_at: string
    }[]
    expect(rows.length).toBe(1)
    expect(rows[0].consumer).toBe('memory_importance')
    expect(rows[0].last_consumed_reward_id).toBe(0)
    expect(rows[0].claimed_by).toBeNull()
    expect(rows[0].claimed_at).toBeNull()
    expect(typeof rows[0].updated_at).toBe('string')
    expect(rows[0].updated_at.length).toBeGreaterThan(0)
  })

  test('ATM-006: re-running migrate() (re-opening the same on-disk DB) is a no-op — still exactly one unchanged row', () => {
    const before = taskDb.run((db) => db.prepare('SELECT * FROM reward_consumption_cursor').all()) as any[]
    expect(before.length).toBe(1)
    taskDb.close()

    const second = new TaskDB(TEST_DB)
    try {
      const after = second.run((db) => db.prepare('SELECT * FROM reward_consumption_cursor').all()) as any[]
      expect(after.length).toBe(1)
      expect(after[0]).toEqual(before[0])
    } finally {
      second.close()
    }
  })

  test('ATM-006: a manual cursor advance survives re-migrate (INSERT OR IGNORE never overwrites an existing row)', () => {
    taskDb.run((db) =>
      db.prepare("UPDATE reward_consumption_cursor SET last_consumed_reward_id = 42 WHERE consumer = 'memory_importance'").run(),
    )
    taskDb.close()

    const second = new TaskDB(TEST_DB)
    try {
      const row = second.run(
        (db) =>
          db.prepare("SELECT last_consumed_reward_id FROM reward_consumption_cursor WHERE consumer = 'memory_importance'").get() as
            | { last_consumed_reward_id: number }
            | null,
      )
      expect(row).not.toBeNull()
      expect(row!.last_consumed_reward_id).toBe(42)
    } finally {
      second.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-022 / REQ-021 [P1] — reward_consumer_enabled flag, default OFF
// ---------------------------------------------------------------------------
describe('ATM-022: reward_consumer_enabled default-OFF (REQ-021)', () => {
  const TEST_DB = '/tmp/t4-rc-atm022.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => {
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-022: fresh migrate() → isFeatureEnabled(reward_consumer_enabled) === false', () => {
    expect(taskDb.isFeatureEnabled('reward_consumer_enabled')).toBe(false)
  })

  test('ATM-022: the seeded flag row exists with enabled=0 (present, not merely absent)', () => {
    const row = taskDb.run(
      (db) => db.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'reward_consumer_enabled'").get(),
    ) as { enabled: number } | null
    expect(row).not.toBeNull()
    expect(row!.enabled).toBe(0)
  })

  test('ATM-022: idempotent — a manually-flipped 1 stays 1 after re-migrate (re-opening the same on-disk DB)', () => {
    taskDb.setFeatureFlag('reward_consumer_enabled', true)
    expect(taskDb.isFeatureEnabled('reward_consumer_enabled')).toBe(true)
    taskDb.close()

    const second = new TaskDB(TEST_DB)
    try {
      expect(second.isFeatureEnabled('reward_consumer_enabled')).toBe(true)
      const row = second.run(
        (db) => db.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'reward_consumer_enabled'").get(),
      ) as { enabled: number } | null
      expect(row!.enabled).toBe(1)
    } finally {
      second.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-001 / REQ-001, REQ-026, REQ-027 [P1] — module scaffold: signature,
// stub behavior, named constants, and the static import-scope guardrail.
// ---------------------------------------------------------------------------
describe('ATM-001: consumePendingRewards() signature + stub + import allowlist (REQ-001/REQ-026/REQ-027)', () => {
  const TEST_DB = '/tmp/t4-rc-atm001.db'
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })
  afterEach(() => {
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-001: named constants carry the spec-mandated values', () => {
    expect(REWARD_CONSUMER_BATCH_LIMIT).toBe(200)
    expect(CLAIM_LEASE_MS).toBe(30 * 60 * 1000)
    expect(REWARD_IMPORTANCE_DELTA).toBe(1)
    expect(IMPORTANCE_MIN).toBe(0)
    expect(IMPORTANCE_MAX).toBe(5)
  })

  test('ATM-001: consumePendingRewards is exported as a function taking (taskDb, mem, opts?)', () => {
    expect(typeof consumePendingRewards).toBe('function')
    expect(consumePendingRewards.length).toBeLessThanOrEqual(3)
  })

  test('ATM-001: called with no opts → returns the documented 6-field RewardConsumptionResult, all-zero/false stub', () => {
    const result: RewardConsumptionResult = consumePendingRewards(taskDb, mem)
    expect(result).toEqual({
      processed: 0,
      skippedNoLinkage: 0,
      skippedLocked: false,
      cursorMissing: false,
      abortedOnCursorFailure: false,
      leaseLost: false,
    })
    expect(Object.keys(result).sort()).toEqual(
      ['processed', 'skippedNoLinkage', 'skippedLocked', 'cursorMissing', 'abortedOnCursorFailure', 'leaseLost'].sort(),
    )
  })

  test('ATM-001: accepts the two optional test-seam callbacks + limit without throwing, and never invokes them (zero rows processed)', () => {
    let onRowConsumedCalls = 0
    let onMemoriesResolvedCalls = 0
    const result = consumePendingRewards(taskDb, mem, {
      limit: 10,
      onRowConsumed: () => {
        onRowConsumedCalls++
      },
      onMemoriesResolved: () => {
        onMemoriesResolvedCalls++
      },
    })
    expect(result.processed).toBe(0)
    expect(onRowConsumedCalls).toBe(0)
    expect(onMemoriesResolvedCalls).toBe(0)
  })

  test('ATM-001 (static scan): the only VALUE import is getTernaryRewards, from ./ternary-reward', () => {
    const importLines = MODULE_SOURCE.split('\n').filter((l) => /^\s*import\b/.test(l))
    const valueImportLines = importLines.filter((l) => !/^\s*import\s+type\b/.test(l))
    // Every non-type-only import line must be exactly the getTernaryRewards import.
    for (const line of valueImportLines) {
      expect(line).toMatch(/import\s*\{\s*getTernaryRewards\s*\}\s*from\s*['"]\.\/ternary-reward['"]/)
    }
    // And that import must actually be present (not zero value imports either).
    expect(valueImportLines.some((l) => /getTernaryRewards/.test(l))).toBe(true)
  })

  test('ATM-001 (static scan): TaskDB/MemoryDB/Database/PersistedTernaryReward are import type only', () => {
    expect(MODULE_SOURCE).toMatch(/import\s+type\s*\{\s*TaskDB\s*\}\s*from\s*['"]\.\.\/db['"]/)
    expect(MODULE_SOURCE).toMatch(/import\s+type\s*\{\s*MemoryDB\s*\}\s*from\s*['"]\.\.\/memory['"]/)
    expect(MODULE_SOURCE).toMatch(/import\s+type\s*\{\s*Database\s*\}\s*from\s*['"]bun:sqlite['"]/)
    expect(MODULE_SOURCE).toMatch(
      /import\s+type\s*\{\s*PersistedTernaryReward\s*\}\s*from\s*['"]\.\/ternary-reward['"]/,
    )
    // None of these four appear as a plain (non-type) value import anywhere.
    const importLines = MODULE_SOURCE.split('\n').filter((l) => /^\s*import\b/.test(l))
    const nonTypeLines = importLines.filter((l) => !/^\s*import\s+type\b/.test(l))
    for (const sym of ['TaskDB', 'MemoryDB', 'Database', 'PersistedTernaryReward']) {
      for (const line of nonTypeLines) {
        expect(line).not.toContain(sym)
      }
    }
  })

  test('ATM-001 (static scan): zero value imports from decision.ts / failure-classification.ts / cross-family-critique.ts', () => {
    const importLines = MODULE_SOURCE.split('\n').filter((l) => /^\s*import\b/.test(l))
    const FORBIDDEN_MODULES = ['decision', 'failure-classification', 'cross-family-critique']
    for (const line of importLines) {
      for (const mod of FORBIDDEN_MODULES) {
        if (line.includes(`/${mod}'`) || line.includes(`/${mod}"`)) {
          // Any import line referencing one of these modules must be type-only.
          expect(line).toMatch(/^\s*import\s+type\b/)
        }
      }
    }
    // Belt-and-suspenders: no VALUE-import line even mentions these module names at all.
    const valueImportLines = importLines.filter((l) => !/^\s*import\s+type\b/.test(l))
    for (const line of valueImportLines) {
      for (const mod of FORBIDDEN_MODULES) {
        expect(line).not.toContain(mod)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-007 / REQ-007 [P1] — getRewardConsumptionCursor() pure read accessor
// ---------------------------------------------------------------------------
describe('ATM-007: getRewardConsumptionCursor() (REQ-007)', () => {
  const TEST_DB = '/tmp/t4-rc-atm007.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => {
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-007: fresh migrated DB → returns 0 for the default consumer', () => {
    const cursor = taskDb.run((db) => getRewardConsumptionCursor(db))
    expect(cursor).toBe(0)
  })

  test('ATM-007: fresh migrated DB → returns 0 when consumer is passed explicitly', () => {
    const cursor = taskDb.run((db) => getRewardConsumptionCursor(db, 'memory_importance'))
    expect(cursor).toBe(0)
  })

  test('ATM-007: after UPDATE ... SET last_consumed_reward_id=7 → returns 7', () => {
    taskDb.run((db) =>
      db.prepare("UPDATE reward_consumption_cursor SET last_consumed_reward_id = 7 WHERE consumer = 'memory_importance'").run(),
    )
    const cursor = taskDb.run((db) => getRewardConsumptionCursor(db))
    expect(cursor).toBe(7)
  })

  test('ATM-007: with the row deleted → returns 0, never throws', () => {
    taskDb.run((db) => db.prepare("DELETE FROM reward_consumption_cursor WHERE consumer = 'memory_importance'").run())
    let cursor: number | undefined
    expect(() => {
      cursor = taskDb.run((db) => getRewardConsumptionCursor(db))
    }).not.toThrow()
    expect(cursor).toBe(0)
  })

  test('ATM-007: with the whole table dropped → returns 0, never throws', () => {
    taskDb.run((db) => db.exec('DROP TABLE reward_consumption_cursor'))
    let cursor: number | undefined
    expect(() => {
      cursor = taskDb.run((db) => getRewardConsumptionCursor(db))
    }).not.toThrow()
    expect(cursor).toBe(0)
  })

  test('ATM-007: an unknown consumer name → returns 0 (not the memory_importance row)', () => {
    taskDb.run((db) =>
      db.prepare("UPDATE reward_consumption_cursor SET last_consumed_reward_id = 99 WHERE consumer = 'memory_importance'").run(),
    )
    const cursor = taskDb.run((db) => getRewardConsumptionCursor(db, 'some_other_consumer'))
    expect(cursor).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-010 / REQ-010 [P2] — module doc-comment cross-spec T1 prune contract
// ---------------------------------------------------------------------------
describe('ATM-010: module doc-comment states the T1 prune contract verbatim (REQ-010)', () => {
  test('ATM-010: contains the verbatim MIN-cursor SQL fragment', () => {
    expect(MODULE_SOURCE).toContain('SELECT MIN(last_consumed_reward_id) FROM reward_consumption_cursor')
  })

  test('ATM-010: documents the BEGIN IMMEDIATE / bounded-DELETE prune-transaction rule (a)', () => {
    expect(MODULE_SOURCE).toMatch(/BEGIN IMMEDIATE/)
    expect(MODULE_SOURCE).toMatch(/id\s*<=/)
  })

  test('ATM-010: documents all five FAIL-SAFE zero-prune conditions (b)', () => {
    expect(MODULE_SOURCE).toMatch(/FAIL-SAFE/)
    expect(MODULE_SOURCE).toMatch(/reward_consumer_enabled.*OFF/)
    expect(MODULE_SOURCE).toMatch(/table is missing/)
    expect(MODULE_SOURCE).toMatch(/zero\s*\n?\s*.*rows/i)
    expect(MODULE_SOURCE).toMatch(/not a valid non-negative integer/)
    expect(MODULE_SOURCE).toMatch(/lookup throws/)
    expect(MODULE_SOURCE).toMatch(/prune ZERO/)
  })

  test('ATM-010: documents the SECOND-CONSUMER RULE (c)', () => {
    expect(MODULE_SOURCE).toMatch(/SECOND-CONSUMER RULE/)
    expect(MODULE_SOURCE).toMatch(/register its cursor row/)
    expect(MODULE_SOURCE).toMatch(/starting.*0/)
  })

  test('ATM-010: documents the SAFETY ARGUMENT (d)', () => {
    expect(MODULE_SOURCE).toMatch(/SAFETY ARGUMENT/)
    expect(MODULE_SOURCE).toMatch(/monotonically/)
    expect(MODULE_SOURCE).toMatch(/consumed by every registered consumer/)
  })
})

// ===========================================================================
// PK-T4-3 (EPIC-02 exactly-once core) — shared helpers.
// ===========================================================================

/** Insert one pending ternary_rewards row; returns its id. */
function seedReward(
  taskDb: TaskDB,
  opts: { reward: -1 | 0 | 1; taskId?: number | null; decisionId?: number | null },
): number {
  return taskDb.run((db) => {
    db.prepare(
      `INSERT INTO ternary_rewards
         (policy_version, decision_id, task_id, subject_kind, cross_family_verdict,
          failure_severity, failure_signal_available, reward, created_at)
       VALUES (1, ?, ?, 'decision', NULL, NULL, 1, ?, datetime('now'))`,
    ).run(opts.decisionId ?? null, opts.taskId ?? null, opts.reward)
    return (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  })
}

/** saveMemory a fact with an optional source_task_id; returns its id. */
function seedMemory(mem: MemoryDB, opts: { importance: number; sourceTaskId?: number; content?: string }): number {
  const saved = mem.saveMemory({
    agent: 'boss',
    content: opts.content ?? `m-${Math.random().toString(36).slice(2)}`,
    category: 'fact',
    importance: opts.importance,
    source_task_id: opts.sourceTaskId,
  })
  return saved.id
}

function importanceOf(taskDb: TaskDB, id: number): number {
  return taskDb.run(
    (db) => (db.prepare('SELECT importance FROM memories WHERE id = ?').get(id) as { importance: number }).importance,
  )
}

type FullCursorRow = {
  consumer: string
  last_consumed_reward_id: number
  claimed_by: string | null
  claimed_at: string | null
  updated_at: string
}

function cursorRow(taskDb: TaskDB): FullCursorRow | null {
  return taskDb.run(
    (db) => db.prepare("SELECT * FROM reward_consumption_cursor WHERE consumer = 'memory_importance'").get() as
      | FullCursorRow
      | null,
  )
}

function setLease(taskDb: TaskDB, claimedBy: string | null, claimedAtSql: string): void {
  // claimedAtSql is a SQL expression, e.g. "datetime('now')" or "'2020-01-01 00:00:00'".
  taskDb.run((db) =>
    db
      .prepare(
        `UPDATE reward_consumption_cursor SET claimed_by = ?, claimed_at = ${claimedAtSql} WHERE consumer = 'memory_importance'`,
      )
      .run(claimedBy),
  )
}

function auditCount(taskDb: TaskDB, action: string): number {
  return taskDb.run(
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n,
  )
}

/** Records the SQL text of every db.prepare() call in order; returns {calls, restore}. */
function spyPrepare(taskDb: TaskDB): { calls: string[]; restore: () => void } {
  const db = taskDb.getHandle() as any
  const orig = db.prepare.bind(db)
  const calls: string[] = []
  db.prepare = (sql: string) => {
    calls.push(sql)
    return orig(sql)
  }
  return { calls, restore: () => { db.prepare = orig } }
}

// ---------------------------------------------------------------------------
// ATM-027 / REQ-032 [P1] — fail-closed on batch-start missing cursor row
// ---------------------------------------------------------------------------
describe('ATM-027: fail-closed on batch-start missing cursor row (REQ-032)', () => {
  const TEST_DB = '/tmp/t4-rc-atm027.db'
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })
  afterEach(() => {
    try {
      taskDb.close()
    } catch {}
    wipeDbFile(TEST_DB)
  })

  test('ATM-027: deleted cursor row → zero mutations, no recreate, cursorMissing, one error audit row, in-txn existence read', () => {
    const memId = seedMemory(mem, { importance: 2, sourceTaskId: 77 })
    seedReward(taskDb, { reward: 1, taskId: 77 })
    // Integrity anomaly: the seed cursor row is gone.
    taskDb.run((db) => db.prepare("DELETE FROM reward_consumption_cursor WHERE consumer = 'memory_importance'").run())

    const decaySpy = spyOn(mem, 'decayMemory')
    const sp = spyPrepare(taskDb)
    const result = consumePendingRewards(taskDb, mem)
    sp.restore()

    // FAIL CLOSED.
    expect(result.cursorMissing).toBe(true)
    expect(result.processed).toBe(0)
    expect(decaySpy).toHaveBeenCalledTimes(0)
    // The row is NOT recreated (no silent reprocess-from-0).
    expect(cursorRow(taskDb)).toBeNull()
    // The memory the reward would have nudged is untouched.
    expect(importanceOf(taskDb, memId)).toBe(2)
    // Exactly one error audit row, naming the missing cursor row.
    expect(auditCount(taskDb, 'reward_consumer_error')).toBe(1)
    const detail = taskDb.run(
      (db) =>
        (db.prepare("SELECT detail FROM audit_log WHERE action = 'reward_consumer_error'").get() as { detail: string })
          .detail,
    )
    expect(detail).toContain('memory_importance')
    expect(detail).toContain('missing')

    // REQ-024 in-txn snapshot: existence read is between the lease UPDATE and the claim-txn COMMIT.
    const iBegin = sp.calls.findIndex((s) => /BEGIN IMMEDIATE/.test(s))
    const iUpdate = sp.calls.findIndex((s) => /UPDATE reward_consumption_cursor/.test(s) && /claimed_by = \?/.test(s))
    const iExists = sp.calls.findIndex((s) => /SELECT 1 AS present/.test(s))
    const iCommit = sp.calls.findIndex((s) => /COMMIT/.test(s))
    expect(iBegin).toBeGreaterThanOrEqual(0)
    expect(iUpdate).toBeGreaterThan(iBegin)
    expect(iExists).toBeGreaterThan(iUpdate)
    expect(iCommit).toBeGreaterThan(iExists)
  })

  test('ATM-027: fail-closed returns cleanly (never throws)', () => {
    seedReward(taskDb, { reward: 1, taskId: 5 })
    taskDb.run((db) => db.prepare("DELETE FROM reward_consumption_cursor WHERE consumer = 'memory_importance'").run())
    expect(() => consumePendingRewards(taskDb, mem)).not.toThrow()
  })
})
