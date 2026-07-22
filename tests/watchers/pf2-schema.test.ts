import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { TaskDB } from '../../db'

// PK-PF2-1 (ATM-PF2-01/02), PF-spec.md EPIC-PF2 (~/.claude/state/p4-p8-fanout/
// specs/PF-spec.md, REQ-PF2-01/02/05/09/16). Schema + flag ONLY — no
// createWatcher()/persistWatcher()/evaluateWatchers()/fireWatcher() land in
// this packet (those are PK-PF2-2..5). This file grows as later PF2 packets
// land, per the ATM table's `tests/watchers/declarative-watchers.test.ts`
// naming — named `pf2-schema.test.ts` here since PK-PF2-1 has no
// watchers/declarative-watchers.ts logic yet to co-locate with.

const DB_TS = readFileSync(resolve(__dirname, '..', '..', 'db.ts'), 'utf-8')

function migrateBody(): string {
  // Everything from `private migrate(): void {` to the next method
  // (`createTask(...)`, the first method after migrate() in class order) —
  // a tight slice so a static match genuinely proves the DDL/flag-seed lives
  // inside migrate() itself, not merely somewhere in db.ts.
  const start = DB_TS.indexOf('private migrate(): void {')
  const end = DB_TS.indexOf('createTask(input: CreateTaskInput): Task {')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return DB_TS.slice(start, end)
}

function freshDb(): { db: TaskDB; path: string } {
  const path = `/tmp/pf2-schema-flag-${crypto.randomUUID()}.db`
  return { db: new TaskDB(path), path }
}

function cleanup(db: TaskDB, path: string): void {
  db.close()
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

describe('ATM-PF2-01: declarative_watchers + declarative_watcher_firings schema (static)', () => {
  test('migrate() contains CREATE TABLE IF NOT EXISTS declarative_watchers', () => {
    expect(migrateBody()).toMatch(/CREATE TABLE IF NOT EXISTS declarative_watchers\b/)
  })

  test('migrate() contains CREATE TABLE IF NOT EXISTS declarative_watcher_firings', () => {
    expect(migrateBody()).toMatch(/CREATE TABLE IF NOT EXISTS declarative_watcher_firings\b/)
  })

  test('migrate() does NOT contain a bare CREATE TABLE IF NOT EXISTS watchers (collision guard vs watcher_heartbeat)', () => {
    expect(migrateBody()).not.toMatch(/CREATE TABLE IF NOT EXISTS watchers\b/)
  })

  test('db.ts contains zero literal "declarative_watchers" tables named bare "watchers" anywhere (repo-wide static scan, not just migrate())', () => {
    // A stricter, whole-file guarantee than the migrateBody() check above:
    // no line anywhere in db.ts declares a table literally named `watchers`.
    const offenders = DB_TS.split('\n').filter(l => /CREATE TABLE IF NOT EXISTS watchers\b/.test(l))
    expect(offenders).toEqual([])
  })

  test('declarative_watcher_firings DDL contains idempotency_key TEXT NOT NULL UNIQUE (DB-level fire-once guard)', () => {
    expect(migrateBody()).toContain('idempotency_key TEXT NOT NULL UNIQUE')
  })
})

describe('ATM-PF2-02: declarative_watchers_enabled flag (static)', () => {
  test("migrate() contains the exact INSERT OR IGNORE seed for declarative_watchers_enabled=0", () => {
    expect(migrateBody()).toContain(
      "INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('declarative_watchers_enabled', 0)",
    )
  })
})

describe('ATM-PF2-01: declarative_watchers + declarative_watcher_firings schema (runtime, fresh DB)', () => {
  test('migrate() provisions both tables on a fresh DB', () => {
    const { db, path } = freshDb()
    try {
      const tables = (db.run(d =>
        d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ) as Array<{ name: string }>).map(r => r.name)
      expect(tables).toContain('declarative_watchers')
      expect(tables).toContain('declarative_watcher_firings')
    } finally {
      cleanup(db, path)
    }
  })

  test('no table literally named "watchers" exists on a fresh DB (collision guard vs watcher_heartbeat)', () => {
    const { db, path } = freshDb()
    try {
      const tables = (db.run(d =>
        d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ) as Array<{ name: string }>).map(r => r.name)
      expect(tables).not.toContain('watchers')
      // watcher_heartbeat (the pre-existing, unrelated mechanism) must still
      // exist untouched — proves this packet didn't rename/collide with it.
      expect(tables).toContain('watcher_heartbeat')
    } finally {
      cleanup(db, path)
    }
  })

  test('declarative_watchers has the full spec column shape (id, name, trigger_type, condition_spec, action_spec, enabled, last_fired_at, last_observed_value, last_observed_at, created_at)', () => {
    const { db, path } = freshDb()
    try {
      const cols = (db.run(d =>
        d.prepare('PRAGMA table_info(declarative_watchers)').all(),
      ) as Array<{ name: string }>).map(r => r.name)
      for (const c of ['id', 'name', 'trigger_type', 'condition_spec', 'action_spec', 'enabled', 'last_fired_at', 'last_observed_value', 'last_observed_at', 'created_at']) {
        expect(cols).toContain(c)
      }
    } finally {
      cleanup(db, path)
    }
  })

  test('declarative_watcher_firings has the spec column shape (id, watcher_id, fired_at, created_task_id, idempotency_key)', () => {
    const { db, path } = freshDb()
    try {
      const cols = (db.run(d =>
        d.prepare('PRAGMA table_info(declarative_watcher_firings)').all(),
      ) as Array<{ name: string }>).map(r => r.name)
      for (const c of ['id', 'watcher_id', 'fired_at', 'created_task_id', 'idempotency_key']) {
        expect(cols).toContain(c)
      }
    } finally {
      cleanup(db, path)
    }
  })

  test('declarative_watchers.trigger_type CHECK constraint rejects a value outside scheduled|state_change|llm_eval', () => {
    const { db, path } = freshDb()
    try {
      expect(() => db.run(d =>
        d.prepare(
          "INSERT INTO declarative_watchers (name, trigger_type, condition_spec, action_spec) VALUES ('bogus watcher', 'bogus_type', '{}', '{}')",
        ).run(),
      )).toThrow()
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('declarative_watchers.trigger_type CHECK constraint accepts each of scheduled|state_change|llm_eval', () => {
    const { db, path } = freshDb()
    try {
      for (const t of ['scheduled', 'state_change', 'llm_eval']) {
        expect(() => db.run(d =>
          d.prepare(
            "INSERT INTO declarative_watchers (name, trigger_type, condition_spec, action_spec) VALUES (?, ?, '{}', '{}')",
          ).run(`watcher-${t}`, t),
        )).not.toThrow()
      }
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(3)
    } finally {
      cleanup(db, path)
    }
  })

  test('declarative_watchers.enabled defaults to 1 (a freshly-inserted watcher starts enabled)', () => {
    const { db, path } = freshDb()
    try {
      db.run(d =>
        d.prepare(
          "INSERT INTO declarative_watchers (name, trigger_type, condition_spec, action_spec) VALUES ('test watcher', 'scheduled', '{}', '{}')",
        ).run(),
      )
      const row = db.run(d =>
        d.prepare('SELECT enabled, last_fired_at, last_observed_value, last_observed_at FROM declarative_watchers WHERE name = ?').get('test watcher'),
      ) as { enabled: number; last_fired_at: string | null; last_observed_value: string | null; last_observed_at: string | null }
      expect(row.enabled).toBe(1)
      expect(row.last_fired_at).toBeNull()
      expect(row.last_observed_value).toBeNull()
      expect(row.last_observed_at).toBeNull()
    } finally {
      cleanup(db, path)
    }
  })

  test('declarative_watcher_firings.idempotency_key UNIQUE constraint rejects a duplicate insert (DB-level fire-once guard, REQ-PF2-16)', () => {
    const { db, path } = freshDb()
    try {
      const watcherId = (db.run(d =>
        d.prepare(
          "INSERT INTO declarative_watchers (name, trigger_type, condition_spec, action_spec) VALUES ('firing watcher', 'scheduled', '{}', '{}') RETURNING id",
        ).get() as { id: number },
      )).id

      db.run(d =>
        d.prepare(
          "INSERT INTO declarative_watcher_firings (watcher_id, created_task_id, idempotency_key) VALUES (?, NULL, ?)",
        ).run(watcherId, 'idem-key-1'),
      )
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }
      expect(count.n).toBe(1)

      // Second insert with the SAME idempotency_key must be rejected by the
      // DB-level UNIQUE constraint, not merely skipped by an app-level check.
      expect(() => db.run(d =>
        d.prepare(
          "INSERT INTO declarative_watcher_firings (watcher_id, created_task_id, idempotency_key) VALUES (?, NULL, ?)",
        ).run(watcherId, 'idem-key-1'),
      )).toThrow()

      const countAfter = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }
      expect(countAfter.n).toBe(1) // still exactly one — the duplicate was rejected, not silently accepted
    } finally {
      cleanup(db, path)
    }
  })

  test('declarative_watcher_firings.idempotency_key NOT NULL constraint rejects a null value', () => {
    const { db, path } = freshDb()
    try {
      const watcherId = (db.run(d =>
        d.prepare(
          "INSERT INTO declarative_watchers (name, trigger_type, condition_spec, action_spec) VALUES ('nn watcher', 'scheduled', '{}', '{}') RETURNING id",
        ).get() as { id: number },
      )).id
      expect(() => db.run(d =>
        // @ts-expect-error — deliberately violate the NOT NULL idempotency_key column to force a DB-level throw.
        d.prepare("INSERT INTO declarative_watcher_firings (watcher_id, created_task_id, idempotency_key) VALUES (?, NULL, NULL)").run(watcherId),
      )).toThrow()
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }
      expect(count.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('migrate() is idempotent — re-opening the same DB file does not error and does not duplicate the schema', () => {
    const path = `/tmp/pf2-schema-flag-${crypto.randomUUID()}.db`
    const first = new TaskDB(path)
    first.close()
    let second: TaskDB | undefined
    try {
      expect(() => { second = new TaskDB(path) }).not.toThrow()
      const tables = (second!.run(d =>
        d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('declarative_watchers','declarative_watcher_firings')").all(),
      ) as Array<{ name: string }>).map(r => r.name)
      expect(tables.sort()).toEqual(['declarative_watcher_firings', 'declarative_watchers'])
    } finally {
      second?.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(path + suffix) } catch {}
      }
    }
  })
})

describe('ATM-PF2-02: declarative_watchers_enabled flag (runtime, fresh DB)', () => {
  test('a fresh TaskDB seeds declarative_watchers_enabled to false (OFF)', () => {
    const { db, path } = freshDb()
    try {
      expect(db.isFeatureEnabled('declarative_watchers_enabled')).toBe(false)
      const row = db.run(d =>
        d.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'declarative_watchers_enabled'").get(),
      ) as { enabled: number } | null
      expect(row).not.toBeNull()
      expect(row!.enabled).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('flipping the flag ON then re-migrating (fresh TaskDB against the same file) does not clobber it back to 0', () => {
    const path = `/tmp/pf2-flag-${crypto.randomUUID()}.db`
    const first = new TaskDB(path)
    first.setFeatureFlag('declarative_watchers_enabled', true)
    first.close()

    const second = new TaskDB(path) // constructor re-runs migrate()
    try {
      expect(second.isFeatureEnabled('declarative_watchers_enabled')).toBe(true)
    } finally {
      second.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(path + suffix) } catch {}
      }
    }
  })
})
