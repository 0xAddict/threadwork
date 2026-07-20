import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { TaskDB } from '../../db'
import {
  recordExpectedOutcome,
  persistOutcomeExpectation,
  diffOutcome,
} from '../../reflection/outcome-feedback'

// PK-PF1-1 (ATM-PF1-01/02) + PK-PF1-2 (ATM-PF1-03/04), PF-spec.md EPIC-PF1.
// PK-PF1-2 adds the pure core: recordExpectedOutcome()/persistOutcomeExpectation()
// (LOCAL BEGIN IMMEDIATE) and the pure diffOutcome() comparator. No
// reflect()/distillSharedPattern()/supersedeSharedPattern() yet (PK-PF1-3), and
// NO wiring into debrief.ts or the claim/delegation path yet (PK-PF1-4) — every
// call in this file is direct/unwired. This file grows as later PF1 packets
// land (ATM-PF1-05..11), per the ATM table's
// `tests/reflection/outcome-feedback.test.ts` naming.

const DB_TS = readFileSync(resolve(__dirname, '..', '..', 'db.ts'), 'utf-8')
const REFLECTION_TS = readFileSync(resolve(__dirname, '..', '..', 'reflection', 'outcome-feedback.ts'), 'utf-8')

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

// ---------------------------------------------------------------------------
// PK-PF1-2 — ATM-PF1-03: recordExpectedOutcome() / persistOutcomeExpectation()
// ---------------------------------------------------------------------------

describe('ATM-PF1-03: recordExpectedOutcome()/persistOutcomeExpectation() (static)', () => {
  test('reflection/outcome-feedback.ts uses the LOCAL BEGIN IMMEDIATE / COMMIT-or-ROLLBACK idiom', () => {
    expect(REFLECTION_TS).toMatch(/BEGIN IMMEDIATE/)
    expect(REFLECTION_TS).toMatch(/COMMIT/)
    expect(REFLECTION_TS).toMatch(/ROLLBACK/)
  })

  test('reflection/outcome-feedback.ts imports zero P5 write-ordering symbols (no withMemoryWriteTxn import)', () => {
    // Word-boundary regex so this test itself never needs to spell the
    // identifier as a bare importable-looking token near an import statement
    // — matches the guardrail's own scan shape (ATM-031 lesson from PK-PF1-1).
    const importLines = REFLECTION_TS.split('\n').filter(l => /^\s*import\b/.test(l))
    for (const line of importLines) {
      expect(line).not.toMatch(/withMemoryWriteTxn/)
    }
  })
})

describe('ATM-PF1-03: recordExpectedOutcome()/persistOutcomeExpectation() (runtime, fresh DB)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-expectation-${crypto.randomUUID()}.db`
    return { db: new TaskDB(path), path }
  }

  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }

  test('flag ON: recordExpectedOutcome() inserts exactly one outcome_expectations row', () => {
    const { db, path } = freshDb()
    try {
      db.setFeatureFlag('outcome_feedback_enabled', true)
      const before = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(before.n).toBe(0)

      const id = db.run(handle => recordExpectedOutcome(handle, { task_id: 1, expected_outcome: 'task #1 completes cleanly' }))
      expect(id).not.toBeNull()

      const after = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(after.n).toBe(1)

      const row = db.run(d => d.prepare('SELECT task_id, expected_outcome FROM outcome_expectations WHERE id = ?').get(id)) as { task_id: number; expected_outcome: string }
      expect(row.task_id).toBe(1)
      expect(row.expected_outcome).toBe('task #1 completes cleanly')
    } finally {
      cleanup(db, path)
    }
  })

  test('flag OFF: recordExpectedOutcome() performs zero writes and returns null (REQ-PF1-08)', () => {
    const { db, path } = freshDb()
    try {
      expect(db.isFeatureEnabled('outcome_feedback_enabled')).toBe(false)
      const result = db.run(handle => recordExpectedOutcome(handle, { task_id: 1, expected_outcome: 'should not persist' }))
      expect(result).toBeNull()
      const after = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(after.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('persistOutcomeExpectation() is called by recordExpectedOutcome() — same effect, called directly', () => {
    const { db, path } = freshDb()
    try {
      db.setFeatureFlag('outcome_feedback_enabled', true)
      const id = db.run(handle => persistOutcomeExpectation(handle, { task_id: 42, expected_outcome: 'direct call' }))
      expect(id).not.toBeNull()
      const row = db.run(d => d.prepare('SELECT task_id FROM outcome_expectations WHERE id = ?').get(id)) as { task_id: number }
      expect(row.task_id).toBe(42)
    } finally {
      cleanup(db, path)
    }
  })

  test('a thrown error mid-transaction leaves zero rows (ROLLBACK proof) — task_id NOT NULL violation', () => {
    const { db, path } = freshDb()
    try {
      db.setFeatureFlag('outcome_feedback_enabled', true)
      // @ts-expect-error — deliberately violate the NOT NULL task_id column to force a DB-level throw.
      expect(() => db.run(handle => persistOutcomeExpectation(handle, { task_id: null, expected_outcome: 'x' }))).toThrow()
      const after = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(after.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// PK-PF1-2 — ATM-PF1-04: pure diffOutcome()
// ---------------------------------------------------------------------------

describe('ATM-PF1-04: pure diffOutcome() (static purity scan)', () => {
  function diffOutcomeBody(): string {
    return functionBody(REFLECTION_TS, 'export function diffOutcome', ['\nexport function ', '\nexport const '])
  }

  test('diffOutcome() body contains no Date.now()', () => {
    expect(diffOutcomeBody()).not.toMatch(/Date\.now\(\)/)
  })

  test('diffOutcome() body contains no `new Date`', () => {
    expect(diffOutcomeBody()).not.toMatch(/new Date/)
  })

  test('diffOutcome() body contains no DB/IO calls (no `.prepare(`, no `db.run(`, no `readFileSync`/`writeFileSync`)', () => {
    const body = diffOutcomeBody()
    expect(body).not.toMatch(/\.prepare\(/)
    expect(body).not.toMatch(/db\.run\(/)
    expect(body).not.toMatch(/readFileSync|writeFileSync/)
  })
})

describe('ATM-PF1-04: pure diffOutcome() (runtime)', () => {
  test('diffOutcome({expected, actual: expected}) -> {matched: true}', () => {
    const result = diffOutcome({ expected: 'X happens', actual: 'X happens' })
    expect(result).toEqual({ matched: true })
  })

  test('diffOutcome({expected, actual: different}) -> {matched: false, delta}', () => {
    const result = diffOutcome({ expected: 'X happens', actual: 'Y happens' })
    expect(result.matched).toBe(false)
    expect(result.delta).toBeTruthy()
  })

  test('called twice on identical input returns deep-equal output (determinism)', () => {
    const input = { expected: 'foo', actual: 'bar' }
    const r1 = diffOutcome(input)
    const r2 = diffOutcome(input)
    expect(r1).toEqual(r2)
  })

  test('never reads a wall clock — two calls made with an artificial delay between them still produce identical output', async () => {
    const input = { expected: 'stable', actual: 'stable' }
    const r1 = diffOutcome(input)
    await new Promise(resolve => setTimeout(resolve, 5))
    const r2 = diffOutcome(input)
    expect(r1).toEqual(r2)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: ATM-PF1-11 early guard (full guard lands PK-PF1-4; this is a
// proactive early check per team-lead's PK-PF1-2 dispatch — trivially true
// right now since reflect() doesn't exist yet, but locks the invariant in
// from this packet forward so a later packet can't silently regress it).
// ---------------------------------------------------------------------------

describe('Verification-axis zero-write guard (early, ATM-PF1-11 preview)', () => {
  test('reflection/outcome-feedback.ts issues zero INSERT/UPDATE/DELETE against failure_classifications, cross_family_critiques, or ternary_rewards', () => {
    const forbidden = ['failure_classifications', 'cross_family_critiques', 'ternary_rewards']
    const writeVerbs = /\b(INSERT|UPDATE|DELETE)\b/i
    const lines = REFLECTION_TS.split('\n')
    const offenders = lines.filter(l => writeVerbs.test(l) && forbidden.some(t => l.includes(t)))
    expect(offenders).toEqual([])
  })
})
