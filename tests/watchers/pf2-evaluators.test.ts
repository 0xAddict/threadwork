import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { Database } from 'bun:sqlite'
import { TaskDB } from '../../db'
import {
  createWatcher,
  evaluateScheduledCondition,
  evaluateStateChangeCondition,
  evaluateLlmCondition,
  type ScheduledEvalInput,
  type StateChangeWatcherRow,
  type LlmEvalClient,
} from '../../watchers/declarative-watchers'

// PK-PF2-3 (ATM-PF2-11, ATM-PF2-12, ATM-PF2-13, ATM-PF2-15, ATM-PF2-16),
// PF-spec.md EPIC-PF2 (~/.claude/state/p4-p8-fanout/specs/PF-spec.md,
// REQ-PF2-12/13/14/17/18). The three bounded condition evaluators only —
// evaluateWatchers()'s watchdog-tick dispatch wiring (REQ-PF2-03/04) and
// fireWatcher()/idempotency (REQ-PF2-05/06) are explicitly out of scope,
// land in PK-PF2-4/5. No db.ts/server.ts/watchdog.ts touch in this packet.

const WATCHERS_TS = readFileSync(resolve(__dirname, '..', '..', 'watchers', 'declarative-watchers.ts'), 'utf-8')

function functionBody(source: string, startMarker: string, endMarkers: string[]): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  let end = source.length
  for (const m of endMarkers) {
    const idx = source.indexOf(m, start + startMarker.length)
    if (idx > -1 && idx < end) end = idx
  }
  return source.slice(start, end)
}

const TOP_LEVEL_MARKERS = ['\nexport function ', '\nexport async function ', '\nexport const ', '\nexport interface ', '\nfunction ']

function freshDb(): { db: TaskDB; path: string } {
  const path = `/tmp/pf2-evaluators-${crypto.randomUUID()}.db`
  return { db: new TaskDB(path), path }
}

function cleanup(db: TaskDB, path: string): void {
  db.close()
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

// ---------------------------------------------------------------------------
// ATM-PF2-11: evaluateScheduledCondition (static purity)
// ---------------------------------------------------------------------------

describe('ATM-PF2-11: evaluateScheduledCondition() purity (static)', () => {
  function body(): string {
    return functionBody(WATCHERS_TS, 'export function evaluateScheduledCondition', TOP_LEVEL_MARKERS)
  }

  test('body contains no Date.now()', () => {
    expect(body()).not.toMatch(/Date\.now\(\)/)
  })

  test('body contains no `new Date`', () => {
    expect(body()).not.toMatch(/new Date/)
  })

  test('body contains no DB/IO calls (no .prepare(, no db.run()', () => {
    expect(body()).not.toMatch(/\.prepare\(/)
    expect(body()).not.toMatch(/db\.run\(/)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-11: evaluateScheduledCondition (runtime)
// ---------------------------------------------------------------------------

describe('ATM-PF2-11: evaluateScheduledCondition() (runtime)', () => {
  test('due: interval_seconds=3600, last_fired_at=now-3601 -> true', () => {
    const now = 1_000_000
    const input: ScheduledEvalInput = { interval_seconds: 3600, last_fired_at: now - 3601 }
    expect(evaluateScheduledCondition(input, now)).toBe(true)
  })

  test('not due: last_fired_at=now-60 -> false', () => {
    const now = 1_000_000
    const input: ScheduledEvalInput = { interval_seconds: 3600, last_fired_at: now - 60 }
    expect(evaluateScheduledCondition(input, now)).toBe(false)
  })

  test('boundary: last_fired_at=now-interval_seconds exactly -> true (now >= last_fired_at + interval_seconds is inclusive)', () => {
    const now = 1_000_000
    const input: ScheduledEvalInput = { interval_seconds: 3600, last_fired_at: now - 3600 }
    expect(evaluateScheduledCondition(input, now)).toBe(true)
  })

  test('one second before boundary -> false', () => {
    const now = 1_000_000
    const input: ScheduledEvalInput = { interval_seconds: 3600, last_fired_at: now - 3599 }
    expect(evaluateScheduledCondition(input, now)).toBe(false)
  })

  test('last_fired_at=null (never fired) -> true', () => {
    const input: ScheduledEvalInput = { interval_seconds: 3600, last_fired_at: null }
    expect(evaluateScheduledCondition(input, 1_000_000)).toBe(true)
  })

  test('malformed interval_seconds (zero, negative, NaN, non-finite) is rejected (throws)', () => {
    expect(() => evaluateScheduledCondition({ interval_seconds: 0, last_fired_at: null }, 1000)).toThrow()
    expect(() => evaluateScheduledCondition({ interval_seconds: -5, last_fired_at: null }, 1000)).toThrow()
    expect(() => evaluateScheduledCondition({ interval_seconds: NaN, last_fired_at: null }, 1000)).toThrow()
    expect(() => evaluateScheduledCondition({ interval_seconds: Infinity, last_fired_at: null }, 1000)).toThrow()
  })

  test('purity: called twice on identical input returns identical output', () => {
    const input: ScheduledEvalInput = { interval_seconds: 100, last_fired_at: 500 }
    const r1 = evaluateScheduledCondition(input, 700)
    const r2 = evaluateScheduledCondition(input, 700)
    expect(r1).toBe(r2)
  })

  test('never reads a wall clock — an artificial delay between two calls with the same explicit `now` still produces identical output', async () => {
    const input: ScheduledEvalInput = { interval_seconds: 100, last_fired_at: 500 }
    const r1 = evaluateScheduledCondition(input, 700)
    await new Promise(resolve => setTimeout(resolve, 5))
    const r2 = evaluateScheduledCondition(input, 700)
    expect(r1).toBe(r2)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-12/15/16: evaluateStateChangeCondition (static)
// ---------------------------------------------------------------------------

describe('ATM-PF2-12/15: evaluateStateChangeCondition() (static)', () => {
  function body(): string {
    return functionBody(WATCHERS_TS, 'export function evaluateStateChangeCondition', TOP_LEVEL_MARKERS)
  }

  test('body uses the LOCAL BEGIN IMMEDIATE / COMMIT-or-ROLLBACK idiom', () => {
    expect(body()).toMatch(/BEGIN IMMEDIATE/)
    expect(body()).toMatch(/COMMIT/)
    expect(body()).toMatch(/ROLLBACK/)
  })

  test('body contains no Date.now() or `new Date` (snapshot timestamping uses SQL datetime(\'now\'), not JS Date)', () => {
    expect(body()).not.toMatch(/Date\.now\(\)/)
    expect(body()).not.toMatch(/new Date/)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-12/15/16: evaluateStateChangeCondition (runtime, fresh DB)
// ---------------------------------------------------------------------------

describe('ATM-PF2-12/15/16: evaluateStateChangeCondition() (runtime, fresh DB)', () => {
  function seedTasksTable(db: Database, rows: Array<{ status: string }>): void {
    for (const r of rows) {
      db.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie', 'sadie', 'seed', 'normal', ?)").run(r.status)
    }
  }

  function createSelectorWatcher(db: TaskDB, taskId: number): StateChangeWatcherRow {
    const id = db.run(handle => createWatcher(handle, {
      name: `selector watcher ${taskId}`,
      trigger_type: 'state_change',
      condition_spec: {
        watched_table: 'tasks',
        watched_column: 'status',
        comparator: 'eq',
        operand: 'completed',
        watched_selector: { id: taskId },
      },
      action_spec: { description: 'react', to: 'sadie' },
    }))
    return {
      id,
      condition_spec: {
        watched_table: 'tasks',
        watched_column: 'status',
        comparator: 'eq',
        operand: 'completed',
        watched_selector: { id: taskId },
      },
    }
  }

  test('fires once on the false->true transition of the resolved scalar (single-row selector, comparator eq)', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','seed','normal','pending') RETURNING id").get() as { id: number }).id)
      const watcher = createSelectorWatcher(db, taskId)

      // First eval: status is 'pending' (not 'completed') -> predicate false, no fire.
      const r1 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r1).toBe(false)

      // Transition the row to 'completed'.
      db.run(d => d.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(taskId))

      // Second eval: predicate now true, was false last time -> fires.
      const r2 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r2).toBe(true)

      // Third eval: predicate still true, was true last time -> does NOT re-fire (level, not edge).
      const r3 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r3).toBe(false)
    } finally {
      cleanup(db, path)
    }
  })

  test('snapshot is persisted (last_observed_value/last_observed_at) on a clean transition', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','seed','normal','pending') RETURNING id").get() as { id: number }).id)
      const watcher = createSelectorWatcher(db, taskId)

      db.run(handle => evaluateStateChangeCondition(watcher, handle)) // seed snapshot = 'pending'
      let row = db.run(d => d.prepare('SELECT last_observed_value, last_observed_at FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null; last_observed_at: string | null }
      expect(row.last_observed_value).toBe('pending')
      expect(row.last_observed_at).not.toBeNull()

      db.run(d => d.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(taskId))
      db.run(handle => evaluateStateChangeCondition(watcher, handle))
      row = db.run(d => d.prepare('SELECT last_observed_value, last_observed_at FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null; last_observed_at: string | null }
      expect(row.last_observed_value).toBe('completed')
    } finally {
      cleanup(db, path)
    }
  })

  test('a 0-row selector evaluates to UNAVAILABLE: returns false, does not throw, snapshot unchanged', () => {
    const { db, path } = freshDb()
    try {
      const watcher: StateChangeWatcherRow = {
        id: db.run(handle => createWatcher(handle, {
          name: 'zero-row watcher',
          trigger_type: 'state_change',
          condition_spec: {
            watched_table: 'tasks', watched_column: 'status', comparator: 'eq', operand: 'completed',
            watched_selector: { id: 999999 }, // matches no row
          },
          action_spec: {},
        })),
        condition_spec: {
          watched_table: 'tasks', watched_column: 'status', comparator: 'eq', operand: 'completed',
          watched_selector: { id: 999999 },
        },
      }
      const before = db.run(d => d.prepare('SELECT last_observed_value FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null }
      expect(before.last_observed_value).toBeNull()

      let result: boolean | undefined
      expect(() => { result = db.run(handle => evaluateStateChangeCondition(watcher, handle)) }).not.toThrow()
      expect(result).toBe(false)

      const after = db.run(d => d.prepare('SELECT last_observed_value FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null }
      expect(after.last_observed_value).toBeNull() // unchanged
    } finally {
      cleanup(db, path)
    }
  })

  test('a >1-row selector evaluates to UNAVAILABLE: returns false, does not throw, snapshot unchanged', () => {
    const { db, path } = freshDb()
    try {
      // Two rows share status='pending' so a selector on status matches >1 row.
      db.run(d => d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','a','normal','pending')").run())
      db.run(d => d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','b','normal','pending')").run())

      const watcher: StateChangeWatcherRow = {
        id: db.run(handle => createWatcher(handle, {
          name: 'multi-row watcher',
          trigger_type: 'state_change',
          condition_spec: {
            watched_table: 'tasks', watched_column: 'id', comparator: 'gt', operand: 0,
            watched_selector: { status: 'pending' }, // matches 2 rows
          },
          action_spec: {},
        })),
        condition_spec: {
          watched_table: 'tasks', watched_column: 'id', comparator: 'gt', operand: 0,
          watched_selector: { status: 'pending' },
        },
      }
      const before = db.run(d => d.prepare('SELECT last_observed_value FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null }
      expect(before.last_observed_value).toBeNull()

      let result: boolean | undefined
      expect(() => { result = db.run(handle => evaluateStateChangeCondition(watcher, handle)) }).not.toThrow()
      expect(result).toBe(false)

      const after = db.run(d => d.prepare('SELECT last_observed_value FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null }
      expect(after.last_observed_value).toBeNull()
    } finally {
      cleanup(db, path)
    }
  })

  test('watched_aggregate (COUNT) fires once on the aggregate transition', () => {
    const { db, path } = freshDb()
    try {
      const watcher: StateChangeWatcherRow = {
        id: db.run(handle => createWatcher(handle, {
          name: 'count watcher',
          trigger_type: 'state_change',
          condition_spec: {
            watched_table: 'tasks', watched_column: 'id', comparator: 'gt', operand: 2,
            watched_aggregate: 'COUNT',
          },
          action_spec: {},
        })),
        condition_spec: {
          watched_table: 'tasks', watched_column: 'id', comparator: 'gt', operand: 2,
          watched_aggregate: 'COUNT',
        },
      }

      // Seed 2 rows -> COUNT(*)=2, predicate (2 > 2) is false.
      seedTasksTable(db.run(d => d) as unknown as Database, [{ status: 'x' }, { status: 'x' }])
      const r1 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r1).toBe(false)

      // Add a 3rd row -> COUNT(*)=3, predicate (3 > 2) now true -> fires.
      db.run(d => d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','c','normal','x')").run())
      const r2 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r2).toBe(true)

      // No more rows added -> predicate still true, was true -> does not re-fire.
      const r3 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r3).toBe(false)
    } finally {
      cleanup(db, path)
    }
  })

  test('comparator "changed": fires only when the resolved scalar differs from the prior snapshot, not on the first-ever observation', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','seed','normal','pending') RETURNING id").get() as { id: number }).id)
      const watcher: StateChangeWatcherRow = {
        id: db.run(handle => createWatcher(handle, {
          name: 'changed watcher',
          trigger_type: 'state_change',
          condition_spec: {
            watched_table: 'tasks', watched_column: 'status', comparator: 'changed', operand: null,
            watched_selector: { id: taskId },
          },
          action_spec: {},
        })),
        condition_spec: {
          watched_table: 'tasks', watched_column: 'status', comparator: 'changed', operand: null,
          watched_selector: { id: taskId },
        },
      }

      // First-ever observation: no prior snapshot to have "changed" from -> does not fire.
      const r1 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r1).toBe(false)

      // No change since last observation -> still no fire.
      const r2 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r2).toBe(false)

      // Value changes -> fires.
      db.run(d => d.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(taskId))
      const r3 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r3).toBe(true)

      // Unchanged again -> no re-fire.
      const r4 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r4).toBe(false)
    } finally {
      cleanup(db, path)
    }
  })

  test('snapshot txn atomicity: a fault injected mid-transaction (forced throw on the snapshot UPDATE) leaves NO partial snapshot write and propagates the error', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','seed','normal','pending') RETURNING id").get() as { id: number }).id)
      const watcher = createSelectorWatcher(db, taskId)

      const proto = Database.prototype as unknown as { prepare: (this: Database, ...args: unknown[]) => any }
      const originalPrepare = proto.prepare
      proto.prepare = function (this: Database, ...callArgs: unknown[]) {
        const sql = callArgs[0] as string
        if (/^UPDATE declarative_watchers SET last_observed_value/.test(sql.trim())) {
          throw new Error('injected fault: snapshot UPDATE failed')
        }
        return originalPrepare.apply(this, callArgs)
      }

      try {
        expect(() => db.run(handle => evaluateStateChangeCondition(watcher, handle))).toThrow()
      } finally {
        proto.prepare = originalPrepare
      }

      const row = db.run(d => d.prepare('SELECT last_observed_value FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null }
      expect(row.last_observed_value).toBeNull() // never persisted -- ROLLBACK proof
    } finally {
      cleanup(db, path)
    }
  })

  test('LOCAL BEGIN IMMEDIATE ordering, verified at runtime via a scoped db.prepare monkeypatch: BEGIN IMMEDIATE precedes the snapshot read and the snapshot UPDATE, which precede COMMIT', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','seed','normal','completed') RETURNING id").get() as { id: number }).id)
      const watcher = createSelectorWatcher(db, taskId)

      const proto = Database.prototype as unknown as { prepare: (this: Database, ...args: unknown[]) => any }
      const originalPrepare = proto.prepare
      const sequence: string[] = []
      proto.prepare = function (this: Database, ...callArgs: unknown[]) {
        const sql = (callArgs[0] as string).trim()
        if (sql === 'BEGIN IMMEDIATE') sequence.push('BEGIN IMMEDIATE')
        else if (/^SELECT last_observed_value, last_observed_at FROM declarative_watchers/.test(sql)) sequence.push('SNAPSHOT_READ')
        else if (/^UPDATE declarative_watchers SET last_observed_value/.test(sql)) sequence.push('SNAPSHOT_WRITE')
        else if (sql === 'COMMIT') sequence.push('COMMIT')
        return originalPrepare.apply(this, callArgs)
      }
      try {
        db.run(handle => evaluateStateChangeCondition(watcher, handle))
      } finally {
        proto.prepare = originalPrepare
      }
      expect(sequence[0]).toBe('BEGIN IMMEDIATE')
      expect(sequence[sequence.length - 1]).toBe('COMMIT')
      expect(sequence.indexOf('SNAPSHOT_READ')).toBeGreaterThan(sequence.indexOf('BEGIN IMMEDIATE'))
      expect(sequence.indexOf('SNAPSHOT_WRITE')).toBeGreaterThan(sequence.indexOf('SNAPSHOT_READ'))
      expect(sequence.indexOf('COMMIT')).toBeGreaterThan(sequence.indexOf('SNAPSHOT_WRITE'))
    } finally {
      cleanup(db, path)
    }
  })

  test('PK-PF2-6 round 1 fold: Checkpoint 1 -- the selector-scalar query is bounded with LIMIT 2, so a non-unique selector cannot materialize an unbounded result set before the single-row check runs', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare("INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','seed','normal','completed') RETURNING id").get() as { id: number }).id)
      const watcher = createSelectorWatcher(db, taskId)

      const proto = Database.prototype as unknown as { prepare: (this: Database, ...args: unknown[]) => any }
      const originalPrepare = proto.prepare
      let selectorSql: string | null = null
      proto.prepare = function (this: Database, ...callArgs: unknown[]) {
        const sql = (callArgs[0] as string).trim()
        if (/^SELECT "status" AS scalar FROM "tasks"/.test(sql)) selectorSql = sql
        return originalPrepare.apply(this, callArgs)
      }
      try {
        db.run(handle => evaluateStateChangeCondition(watcher, handle))
      } finally {
        proto.prepare = originalPrepare
      }
      expect(selectorSql).not.toBeNull()
      expect(selectorSql as unknown as string).toMatch(/LIMIT 2\s*$/)
    } finally {
      cleanup(db, path)
    }
  })

  test('watched_table/watched_column with unsafe identifier characters are rejected upstream by createWatcher() (identifier-injection guard)', () => {
    const { db, path } = freshDb()
    try {
      expect(() => db.run(handle => createWatcher(handle, {
        name: 'injection attempt',
        trigger_type: 'state_change',
        condition_spec: {
          watched_table: 'tasks; DROP TABLE tasks; --',
          watched_column: 'status',
          comparator: 'eq',
          operand: 'x',
          watched_selector: { id: 1 },
        },
        action_spec: {},
      }))).toThrow()
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// PK-PF2-6 round 1 fold — HIGH finding 4 (both halves): SQL NULL was
// conflated with "no prior snapshot"/"selector never matches".
// ---------------------------------------------------------------------------

describe('PK-PF2-6 round 1 fold: null-valued watched_selector terms use IS NULL, not = ? (a NULL parameter never matches via "=")', () => {
  test('a watched_selector with a null value correctly resolves a row whose actual column value IS NULL (previously always UNAVAILABLE -- 0 rows -- since SQL `col = NULL` never matches)', () => {
    const { db, path } = freshDb()
    try {
      db.run(d => d.prepare(
        "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result) VALUES ('sadie','sadie','seed','normal','pending', NULL)",
      ).run())

      const watcher: StateChangeWatcherRow = {
        id: db.run(handle => createWatcher(handle, {
          name: 'null-selector watcher',
          trigger_type: 'state_change',
          condition_spec: {
            watched_table: 'tasks', watched_column: 'status', comparator: 'eq', operand: 'completed',
            watched_selector: { result: null }, // selects the row WHERE result IS NULL
          },
          action_spec: {},
        })),
        condition_spec: {
          watched_table: 'tasks', watched_column: 'status', comparator: 'eq', operand: 'completed',
          watched_selector: { result: null },
        },
      }

      // If the selector resolved to UNAVAILABLE (the pre-fix bug), the
      // snapshot would stay NULL forever and this would never distinguish
      // from "never observed". Prove resolution actually happens: fire the
      // eval once to seed the snapshot, then transition and fire again --
      // both must work, which is only possible if the null-valued selector
      // genuinely matched the seeded row.
      const r1 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r1).toBe(false) // status='pending' -> eq 'completed' is false, seeds snapshot

      const row = db.run(d => d.prepare('SELECT last_observed_value FROM declarative_watchers WHERE id = ?').get(watcher.id)) as { last_observed_value: string | null }
      expect(row.last_observed_value).toBe('pending') // proves the selector resolved the row, not UNAVAILABLE (which would leave it NULL)

      db.run(d => d.prepare("UPDATE tasks SET status = 'completed' WHERE result IS NULL").run())
      const r2 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r2).toBe(true) // genuine transition, fires
    } finally {
      cleanup(db, path)
    }
  })
})

describe('PK-PF2-6 round 1 fold: last_observed_at (not last_observed_value===null) is the "never observed" presence marker', () => {
  test('a watched column that is genuinely NULL on its first observation, and STAYS null on the second observation, does NOT re-fire (a stable level, not a fresh transition) -- the pre-fix bug conflated "genuinely observed null" with "never observed", causing a spurious re-fire every time', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare(
        "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result) VALUES ('sadie','sadie','seed','normal','pending', NULL) RETURNING id",
      ).get() as { id: number }).id)

      const watcher: StateChangeWatcherRow = {
        id: db.run(handle => createWatcher(handle, {
          name: 'genuine-null watcher',
          trigger_type: 'state_change',
          condition_spec: {
            watched_table: 'tasks', watched_column: 'result', comparator: 'eq', operand: null,
            watched_selector: { id: taskId },
          },
          action_spec: {},
        })),
        condition_spec: {
          watched_table: 'tasks', watched_column: 'result', comparator: 'eq', operand: null,
          watched_selector: { id: taskId },
        },
      }

      // Eval 1: result IS NULL, first-ever observation -- "eq null" is
      // true, and there's genuinely no prior data, so this is a legitimate
      // absent->true transition (fires, matches Checkpoint 4's own
      // "absent->true is explicit" reasoning).
      const r1 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r1).toBe(true)

      // Eval 2: result is STILL NULL, unchanged -- "eq null" is still
      // true, but it was ALSO true last time (a genuine prior observation
      // of null, not "unobserved") -- must NOT re-fire.
      const r2 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r2).toBe(false)
    } finally {
      cleanup(db, path)
    }
  })

  test('"changed" comparator: a genuinely-observed null that transitions to a non-null value fires; repeating the same non-null value afterward does not re-fire', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(d => (d.prepare(
        "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result) VALUES ('sadie','sadie','seed','normal','pending', NULL) RETURNING id",
      ).get() as { id: number }).id)

      const watcher: StateChangeWatcherRow = {
        id: db.run(handle => createWatcher(handle, {
          name: 'changed-from-null watcher',
          trigger_type: 'state_change',
          condition_spec: {
            watched_table: 'tasks', watched_column: 'result', comparator: 'changed', operand: null,
            watched_selector: { id: taskId },
          },
          action_spec: {},
        })),
        condition_spec: {
          watched_table: 'tasks', watched_column: 'result', comparator: 'changed', operand: null,
          watched_selector: { id: taskId },
        },
      }

      // First-ever observation (result=null) -- no prior snapshot to have
      // "changed" from -- must not fire (matches the existing, already-
      // shipped "changed" contract for the non-null case).
      const r1 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r1).toBe(false)

      // Value changes from null to a real value -- genuine change, fires.
      db.run(d => d.prepare("UPDATE tasks SET result = 'done' WHERE id = ?").run(taskId))
      const r2 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r2).toBe(true)

      // Unchanged again -- no re-fire.
      const r3 = db.run(handle => evaluateStateChangeCondition(watcher, handle))
      expect(r3).toBe(false)
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-13: evaluateLlmCondition (static)
// ---------------------------------------------------------------------------

describe('ATM-PF2-13: evaluateLlmCondition() no open expression evaluation (static)', () => {
  test('watchers/declarative-watchers.ts still contains zero eval-equivalent dynamic code execution', () => {
    expect(WATCHERS_TS).not.toMatch(/\beval\(/)
    expect(WATCHERS_TS).not.toMatch(/new Function\(/)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-13: evaluateLlmCondition (runtime, mocked client — zero real API calls)
// ---------------------------------------------------------------------------

describe('ATM-PF2-13: evaluateLlmCondition() (runtime, mocked LLM client)', () => {
  function mockClient(response: string | Error): LlmEvalClient & { callCount: number; lastPrompt?: string; lastMaxTokens?: number } {
    const client = {
      callCount: 0,
      lastPrompt: undefined as string | undefined,
      lastMaxTokens: undefined as number | undefined,
      async complete(prompt: string, maxTokens: number): Promise<string> {
        client.callCount++
        client.lastPrompt = prompt
        client.lastMaxTokens = maxTokens
        if (response instanceof Error) throw response
        return response
      },
    }
    return client
  }

  test('an affirmative "true" reply maps to true, exactly one call', async () => {
    const client = mockClient('true')
    const result = await evaluateLlmCondition({ prompt: 'Is X true?', max_tokens: 16 }, client)
    expect(result).toBe(true)
    expect(client.callCount).toBe(1)
    expect(client.lastPrompt).toBe('Is X true?')
  })

  test('a "false" reply maps to false', async () => {
    const client = mockClient('false')
    const result = await evaluateLlmCondition({ prompt: 'Is X true?' }, client)
    expect(result).toBe(false)
    expect(client.callCount).toBe(1)
  })

  test('case/whitespace tolerant strict-boolean parsing: "TRUE", " True \\n" both map to true', async () => {
    for (const reply of ['TRUE', ' True \n', 'true']) {
      const client = mockClient(reply)
      const result = await evaluateLlmCondition({ prompt: 'p' }, client)
      expect(result).toBe(true)
    }
  })

  test('a non-boolean/ambiguous reply ("maybe", empty string, arbitrary prose) defaults to false, never throws', async () => {
    for (const reply of ['maybe', '', 'I think so, probably', 'TRUE and also false', '1']) {
      const client = mockClient(reply)
      let result: boolean | undefined
      await expect((async () => { result = await evaluateLlmCondition({ prompt: 'p' }, client) })()).resolves.toBeUndefined()
      expect(result).toBe(false)
    }
  })

  test('a thrown/rejected client call (error) defaults to false, never throws out of the evaluator', async () => {
    const client = mockClient(new Error('boom: model unavailable'))
    let result: boolean | undefined
    await expect((async () => { result = await evaluateLlmCondition({ prompt: 'p' }, client) })()).resolves.toBeUndefined()
    expect(result).toBe(false)
    expect(client.callCount).toBe(1)
  })

  test('a rejected client call shaped like a timeout defaults to false', async () => {
    const client = mockClient(new Error('timeout after 30000ms'))
    const result = await evaluateLlmCondition({ prompt: 'p' }, client)
    expect(result).toBe(false)
  })

  test('exactly one call per evaluation -- no retry loop (v1 has no retries)', async () => {
    const client = mockClient('true')
    await evaluateLlmCondition({ prompt: 'p' }, client)
    expect(client.callCount).toBe(1)
    await evaluateLlmCondition({ prompt: 'p' }, client)
    expect(client.callCount).toBe(2) // one more call per one more evaluation, never internally retried within a single call
  })

  test('max_tokens is passed through to the client; defaults to a bounded value when omitted', async () => {
    const client = mockClient('true')
    await evaluateLlmCondition({ prompt: 'p', max_tokens: 42 }, client)
    expect(client.lastMaxTokens).toBe(42)

    const client2 = mockClient('true')
    await evaluateLlmCondition({ prompt: 'p' }, client2)
    expect(client2.lastMaxTokens).toBeGreaterThan(0)
  })
})
