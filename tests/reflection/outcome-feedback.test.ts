import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { TaskDB } from '../../db'

// PK-PF1-1 (ATM-PF1-01/02, PF-spec.md EPIC-PF1). Schema+flag ONLY in this
// packet — no recordExpectedOutcome()/persistOutcomeExpectation()/reflect()
// logic yet (that's PK-PF1-2/3). This file grows as later PF1 packets land
// (ATM-PF1-03..11), per the ATM table's `tests/reflection/outcome-feedback.test.ts`
// naming.

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

describe('ATM-PF1-01: outcome_expectations + shared_patterns schema (static)', () => {
  test('migrate() contains CREATE TABLE IF NOT EXISTS outcome_expectations', () => {
    expect(migrateBody()).toMatch(/CREATE TABLE IF NOT EXISTS outcome_expectations/)
  })

  test('migrate() contains CREATE TABLE IF NOT EXISTS shared_patterns', () => {
    expect(migrateBody()).toMatch(/CREATE TABLE IF NOT EXISTS shared_patterns/)
  })
})

describe('ATM-PF1-02: outcome_feedback_enabled flag (static)', () => {
  test("migrate() contains the exact INSERT OR IGNORE seed for outcome_feedback_enabled=0", () => {
    expect(migrateBody()).toContain(
      "INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('outcome_feedback_enabled', 0)",
    )
  })
})

describe('ATM-PF1-01: outcome_expectations + shared_patterns schema (runtime, fresh DB)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-schema-flag-${crypto.randomUUID()}.db`
    return { db: new TaskDB(path), path }
  }

  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }

  test('migrate() provisions both tables on a fresh DB', () => {
    const { db, path } = freshDb()
    try {
      const tables = (db.run(d =>
        d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ) as Array<{ name: string }>).map(r => r.name)
      expect(tables).toContain('outcome_expectations')
      expect(tables).toContain('shared_patterns')
    } finally {
      cleanup(db, path)
    }
  })

  test('outcome_expectations has the append-only column shape (id, task_id, expected_outcome, recorded_at, diffed_at, diff_result)', () => {
    const { db, path } = freshDb()
    try {
      const cols = (db.run(d =>
        d.prepare('PRAGMA table_info(outcome_expectations)').all(),
      ) as Array<{ name: string }>).map(r => r.name)
      for (const c of ['id', 'task_id', 'expected_outcome', 'recorded_at', 'diffed_at', 'diff_result']) {
        expect(cols).toContain(c)
      }
    } finally {
      cleanup(db, path)
    }
  })

  test('shared_patterns has the supersedeable column shape (id, pattern_text, confidence, source_expectation_id, is_active, superseded_by, created_at)', () => {
    const { db, path } = freshDb()
    try {
      const cols = (db.run(d =>
        d.prepare('PRAGMA table_info(shared_patterns)').all(),
      ) as Array<{ name: string }>).map(r => r.name)
      for (const c of ['id', 'pattern_text', 'confidence', 'source_expectation_id', 'is_active', 'superseded_by', 'created_at']) {
        expect(cols).toContain(c)
      }
    } finally {
      cleanup(db, path)
    }
  })

  test('shared_patterns.is_active defaults to 1 (a freshly-inserted pattern starts active)', () => {
    const { db, path } = freshDb()
    try {
      db.run(d =>
        d.prepare(
          "INSERT INTO shared_patterns (pattern_text, confidence) VALUES ('test pattern', 0.5)",
        ).run(),
      )
      const row = db.run(d =>
        d.prepare('SELECT is_active, superseded_by FROM shared_patterns WHERE pattern_text = ?').get('test pattern'),
      ) as { is_active: number; superseded_by: number | null }
      expect(row.is_active).toBe(1)
      expect(row.superseded_by).toBeNull()
    } finally {
      cleanup(db, path)
    }
  })

  test('migrate() is idempotent — re-opening the same DB file does not error and does not duplicate the schema', () => {
    const path = `/tmp/pf1-schema-flag-${crypto.randomUUID()}.db`
    const first = new TaskDB(path)
    first.close()
    let second: TaskDB | undefined
    try {
      expect(() => { second = new TaskDB(path) }).not.toThrow()
      const tables = (second!.run(d =>
        d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('outcome_expectations','shared_patterns')").all(),
      ) as Array<{ name: string }>).map(r => r.name)
      expect(tables.sort()).toEqual(['outcome_expectations', 'shared_patterns'])
    } finally {
      second?.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(path + suffix) } catch {}
      }
    }
  })
})

describe('ATM-PF1-02: outcome_feedback_enabled flag (runtime, fresh DB)', () => {
  test('a fresh TaskDB seeds outcome_feedback_enabled to false (OFF)', () => {
    const path = `/tmp/pf1-flag-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    try {
      expect(db.isFeatureEnabled('outcome_feedback_enabled')).toBe(false)
      const row = db.run(d =>
        d.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'").get(),
      ) as { enabled: number } | null
      expect(row).not.toBeNull()
      expect(row!.enabled).toBe(0)
    } finally {
      db.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(path + suffix) } catch {}
      }
    }
  })

  test('flipping the flag ON then re-migrating (fresh TaskDB against the same file) does not clobber it back to 0', () => {
    const path = `/tmp/pf1-flag-${crypto.randomUUID()}.db`
    const first = new TaskDB(path)
    first.setFeatureFlag('outcome_feedback_enabled', true)
    first.close()

    const second = new TaskDB(path) // constructor re-runs migrate()
    try {
      expect(second.isFeatureEnabled('outcome_feedback_enabled')).toBe(true)
    } finally {
      second.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(path + suffix) } catch {}
      }
    }
  })
})
