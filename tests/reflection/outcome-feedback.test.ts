import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { TaskDB } from '../../db'
import {
  recordExpectedOutcome,
  persistOutcomeExpectation,
  diffOutcome,
  reflect,
  distillSharedPattern,
  supersedeSharedPattern,
  getSharedPatterns,
  getOutcomeExpectations,
  computeSignature,
} from '../../reflection/outcome-feedback'

// PK-PF1-1 (ATM-PF1-01/02) + PK-PF1-2 (ATM-PF1-03/04) + PK-PF1-3
// (ATM-PF1-05..08), PF-spec.md EPIC-PF1. PK-PF1-3 adds reflect() (post-hoc
// diff pass + distillation trigger), distillSharedPattern()/
// supersedeSharedPattern(), and the getSharedPatterns()/getOutcomeExpectations()
// read-contracts. Still NO wiring into debrief.ts or the claim/delegation path
// (PK-PF1-4) — reflect() is called directly in every test here, fully
// standalone-testable. This file grows as later PF1 packets land
// (ATM-PF1-09..11), per the ATM table's
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
    return functionBody(REFLECTION_TS, 'export function diffOutcome', ['\nexport function ', '\nexport const ', '\nexport interface '])
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
// Cross-cutting: ATM-PF1-11 early guard (full guard with flag-OFF parity
// lands PK-PF1-4; this piece — the zero-write / read-only-import static
// scan — is now NON-trivial as of PK-PF1-3, since reflect() DOES consume the
// triad starting this packet. ATM-PF1-08 below extends this with the
// "read-only-import" half of the same guard.)
// ---------------------------------------------------------------------------

describe('Verification-axis zero-write guard (ATM-PF1-11 preview, non-trivial as of PK-PF1-3)', () => {
  test('reflection/outcome-feedback.ts issues zero INSERT/UPDATE/DELETE against failure_classifications, cross_family_critiques, or ternary_rewards', () => {
    const forbidden = ['failure_classifications', 'cross_family_critiques', 'ternary_rewards']
    const writeVerbs = /\b(INSERT|UPDATE|DELETE)\b/i
    const lines = REFLECTION_TS.split('\n')
    const offenders = lines.filter(l => writeVerbs.test(l) && forbidden.some(t => l.includes(t)))
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// PK-PF1-3 — ATM-PF1-08: getSharedPatterns() / getOutcomeExpectations() read-contracts
// ---------------------------------------------------------------------------

describe('ATM-PF1-08: read-contracts (static SELECT-only scan)', () => {
  function bodyOf(fnName: string): string {
    return functionBody(REFLECTION_TS, `export function ${fnName}`, ['\nexport function ', '\nexport const ', '\nexport interface '])
  }

  test('getSharedPatterns() body contains only SELECT statements (no INSERT/UPDATE/DELETE)', () => {
    const body = bodyOf('getSharedPatterns')
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
    expect(body).toMatch(/SELECT/i)
  })

  test('getOutcomeExpectations() body contains only SELECT statements (no INSERT/UPDATE/DELETE)', () => {
    const body = bodyOf('getOutcomeExpectations')
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
    expect(body).toMatch(/SELECT/i)
  })

  test('reflection/outcome-feedback.ts value-imports ONLY the 3 read-contract getters from the verification-axis modules (no write symbols)', () => {
    const importLines = REFLECTION_TS.split('\n').filter(l => /^\s*import\b/.test(l) && /verification\//.test(l))
    const forbiddenWriteSymbols = ['persistFailureClassification', 'persistCrossFamilyCritique', 'persistTernaryReward']
    for (const line of importLines) {
      for (const sym of forbiddenWriteSymbols) {
        expect(line).not.toContain(sym)
      }
    }
  })
})

describe('ATM-PF1-08: read-contracts (runtime)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-readcontracts-${crypto.randomUUID()}.db`
    return { db: new TaskDB(path), path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }

  test('getSharedPatterns() defaults to is_active=1 filter', () => {
    const { db, path } = freshDb()
    try {
      db.run(handle => {
        handle.prepare("INSERT INTO shared_patterns (pattern_text, confidence, is_active) VALUES ('active one', 0.7, 1)").run()
        handle.prepare("INSERT INTO shared_patterns (pattern_text, confidence, is_active) VALUES ('inactive one', 0.7, 0)").run()
      })
      const active = db.run(handle => getSharedPatterns(handle))
      expect(active.length).toBe(1)
      expect(active[0].pattern_text).toBe('active one')

      const all = db.run(handle => getSharedPatterns(handle, { activeOnly: false }))
      expect(all.length).toBe(2)
    } finally {
      cleanup(db, path)
    }
  })

  test('getOutcomeExpectations() supports filtering by taskId', () => {
    const { db, path } = freshDb()
    try {
      db.setFeatureFlag('outcome_feedback_enabled', true)
      db.run(handle => persistOutcomeExpectation(handle, { task_id: 1, expected_outcome: 'a' }))
      db.run(handle => persistOutcomeExpectation(handle, { task_id: 2, expected_outcome: 'b' }))
      const forTask1 = db.run(handle => getOutcomeExpectations(handle, { taskId: 1 }))
      expect(forTask1.length).toBe(1)
      expect(forTask1[0].task_id).toBe(1)

      const all = db.run(handle => getOutcomeExpectations(handle))
      expect(all.length).toBe(2)
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// PK-PF1-3 — ATM-PF1-06/07: distillSharedPattern() / supersedeSharedPattern()
// ---------------------------------------------------------------------------

describe('ATM-PF1-06: distillSharedPattern() (static)', () => {
  test('reflection/outcome-feedback.ts uses BEGIN IMMEDIATE/COMMIT/ROLLBACK for shared_patterns writes (already asserted file-wide in ATM-PF1-03; sanity re-check scoped near persistSharedPattern)', () => {
    expect(REFLECTION_TS).toMatch(/persistSharedPattern/)
    expect(REFLECTION_TS.match(/BEGIN IMMEDIATE/g)?.length ?? 0).toBeGreaterThanOrEqual(2) // outcome_expectations + shared_patterns write paths
  })
})

describe('ATM-PF1-06: distillSharedPattern() (runtime, fresh DB)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-distill-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }
  function seedDiffedExpectation(db: TaskDB, taskId: number, expected: string, actual: string): number {
    return db.run(handle => {
      const id = persistOutcomeExpectation(handle, { task_id: taskId, expected_outcome: expected })!
      const diff = diffOutcome({ expected, actual })
      handle.prepare("UPDATE outcome_expectations SET diffed_at = datetime('now'), diff_result = ? WHERE id = ?").run(JSON.stringify(diff), id)
      return id
    })
  }

  test('3 diffs sharing a signature yield exactly one shared_patterns row with confidence in (0,1] and source_expectation_id set', () => {
    const { db, path } = freshDb()
    try {
      const ids = [
        seedDiffedExpectation(db, 1, 'task completes cleanly', 'task completes cleanly'),
        seedDiffedExpectation(db, 2, 'task completes cleanly', 'task completes cleanly'),
        seedDiffedExpectation(db, 3, 'task completes cleanly', 'task completes cleanly'),
      ]
      const rows = db.run(handle => getOutcomeExpectations(handle)).filter(r => ids.includes(r.id))
      const patternId = db.run(handle => distillSharedPattern(handle, rows, 'match::task completes cleanly'))
      expect(patternId).not.toBeNull()

      const patterns = db.run(handle => getSharedPatterns(handle))
      expect(patterns.length).toBe(1)
      expect(patterns[0].confidence).toBeGreaterThan(0)
      expect(patterns[0].confidence).toBeLessThanOrEqual(1)
      expect(patterns[0].source_expectation_id).not.toBeNull()
      expect(ids).toContain(patterns[0].source_expectation_id!) // non-null: proven by the assertion immediately above
    } finally {
      cleanup(db, path)
    }
  })

  test('2 diffs sharing a signature yield zero shared_patterns rows', () => {
    const { db, path } = freshDb()
    try {
      const ids = [
        seedDiffedExpectation(db, 1, 'x', 'x'),
        seedDiffedExpectation(db, 2, 'x', 'x'),
      ]
      const rows = db.run(handle => getOutcomeExpectations(handle)).filter(r => ids.includes(r.id))
      const patternId = db.run(handle => distillSharedPattern(handle, rows, 'match::x'))
      expect(patternId).toBeNull()
      const patterns = db.run(handle => getSharedPatterns(handle))
      expect(patterns.length).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('calling distillSharedPattern() twice for the SAME signature does not create a duplicate active pattern', () => {
    const { db, path } = freshDb()
    try {
      const ids = [
        seedDiffedExpectation(db, 1, 'y', 'y'),
        seedDiffedExpectation(db, 2, 'y', 'y'),
        seedDiffedExpectation(db, 3, 'y', 'y'),
      ]
      const rows = db.run(handle => getOutcomeExpectations(handle)).filter(r => ids.includes(r.id))
      const first = db.run(handle => distillSharedPattern(handle, rows, 'match::y'))
      const second = db.run(handle => distillSharedPattern(handle, rows, 'match::y'))
      expect(first).not.toBeNull()
      expect(second).toBeNull() // dedup: an active pattern for this signature already exists
      const patterns = db.run(handle => getSharedPatterns(handle))
      expect(patterns.length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })
})

describe('ATM-PF1-07: supersedeSharedPattern() (never-delete)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-supersede-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }

  test('superseding pattern #1 with #2 leaves #1 is_active=0/superseded_by=2, inserts #2 is_active=1, row count n -> n+1 (no deletion)', () => {
    const { db, path } = freshDb()
    try {
      const p1Id = db.run(handle => handle.prepare(
        "INSERT INTO shared_patterns (pattern_text, confidence, is_active) VALUES ('old pattern', 0.7, 1) RETURNING id",
      ).get() as { id: number }).id

      const before = db.run(handle => handle.prepare('SELECT COUNT(*) AS n FROM shared_patterns').get()) as { n: number }
      expect(before.n).toBe(1)

      const p2Id = db.run(handle => supersedeSharedPattern(handle, p1Id, { pattern_text: 'new pattern', confidence: 0.9, source_expectation_id: 1 }))
      expect(p2Id).not.toBeNull()

      const after = db.run(handle => handle.prepare('SELECT COUNT(*) AS n FROM shared_patterns').get()) as { n: number }
      expect(after.n).toBe(2) // n -> n+1, no deletion

      const p1After = db.run(handle => handle.prepare('SELECT is_active, superseded_by FROM shared_patterns WHERE id = ?').get(p1Id)) as { is_active: number; superseded_by: number }
      expect(p1After.is_active).toBe(0)
      expect(p1After.superseded_by).toBe(p2Id!) // non-null: proven by the assertion immediately above

      const p2After = db.run(handle => handle.prepare('SELECT is_active FROM shared_patterns WHERE id = ?').get(p2Id)) as { is_active: number }
      expect(p2After.is_active).toBe(1)

      // The old row is still PHYSICALLY present — never-delete (REQ-PF1-06).
      const p1StillThere = db.run(handle => handle.prepare('SELECT id FROM shared_patterns WHERE id = ?').get(p1Id))
      expect(p1StillThere).not.toBeNull()
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// PK-PF1-3 — ATM-PF1-05: reflect() post-hoc pass (standalone-testable, NOT
// wired into debrief.ts — that's PK-PF1-4)
// ---------------------------------------------------------------------------

describe('ATM-PF1-05: reflect() (runtime, fresh DB, standalone)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-reflect-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }
  function seedCompletedTask(db: TaskDB, result: string): number {
    return db.run(handle => handle.prepare(
      "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result) VALUES ('sadie', 'sadie', 'seed', 'normal', 'completed', ?) RETURNING id",
    ).get(result) as { id: number }).id
  }

  test('seed 3 completed outcome_expectations, call reflect() directly with flag ON, assert each gets a diffOutcome() result', () => {
    const { db, path } = freshDb()
    try {
      const taskIds = [seedCompletedTask(db, 'ok'), seedCompletedTask(db, 'ok'), seedCompletedTask(db, 'ok')]
      const expIds = taskIds.map(tid => db.run(handle => persistOutcomeExpectation(handle, { task_id: tid, expected_outcome: 'ok' }))!)

      const result = db.run(handle => reflect(handle))
      expect(result.diffed).toBe(3)

      const rows = db.run(handle => getOutcomeExpectations(handle)).filter(r => expIds.includes(r.id))
      for (const row of rows) {
        expect(row.diffed_at).not.toBeNull()
        expect(row.diff_result).not.toBeNull()
        const diff = JSON.parse(row.diff_result!)
        expect(diff.matched).toBe(true)
      }
    } finally {
      cleanup(db, path)
    }
  })

  test('flag OFF: reflect() diffs nothing and returns {diffed:0, distilled:0}', () => {
    const path = `/tmp/pf1-reflect-off-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    try {
      expect(db.isFeatureEnabled('outcome_feedback_enabled')).toBe(false)
      const taskId = seedCompletedTask(db, 'ok')
      // Can't persistOutcomeExpectation with flag OFF (returns null) — insert directly to prove reflect() itself no-ops.
      db.run(handle => handle.prepare("INSERT INTO outcome_expectations (task_id, expected_outcome) VALUES (?, 'ok')").run(taskId))
      const result = db.run(handle => reflect(handle))
      expect(result).toEqual({ diffed: 0, distilled: 0 })
      const row = db.run(handle => handle.prepare('SELECT diffed_at FROM outcome_expectations WHERE task_id = ?').get(taskId)) as { diffed_at: string | null }
      expect(row.diffed_at).toBeNull()
    } finally {
      cleanup(db, path)
    }
  })

  test('reflect() only diffs rows whose task has a non-null result (undiffed + uncompleted task is skipped)', () => {
    const { db, path } = freshDb()
    try {
      const incompleteTaskId = db.run(handle => handle.prepare(
        "INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie', 'sadie', 'not done yet', 'normal', 'in_progress') RETURNING id",
      ).get() as { id: number }).id
      db.run(handle => persistOutcomeExpectation(handle, { task_id: incompleteTaskId, expected_outcome: 'whatever' }))

      const result = db.run(handle => reflect(handle))
      expect(result.diffed).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('reflect() distills a shared pattern once 3 matching-signature diffs accumulate ACROSS multiple reflect() calls', () => {
    const { db, path } = freshDb()
    try {
      // Call 1: diff 2 matching rows — not enough to distill yet.
      const t1 = seedCompletedTask(db, 'stable outcome')
      const t2 = seedCompletedTask(db, 'stable outcome')
      db.run(handle => persistOutcomeExpectation(handle, { task_id: t1, expected_outcome: 'stable outcome' }))
      db.run(handle => persistOutcomeExpectation(handle, { task_id: t2, expected_outcome: 'stable outcome' }))
      const r1 = db.run(handle => reflect(handle))
      expect(r1.diffed).toBe(2)
      expect(r1.distilled).toBe(0)
      expect(db.run(handle => getSharedPatterns(handle)).length).toBe(0)

      // Call 2: one more matching row — now 3 total across calls, should distill.
      const t3 = seedCompletedTask(db, 'stable outcome')
      db.run(handle => persistOutcomeExpectation(handle, { task_id: t3, expected_outcome: 'stable outcome' }))
      const r2 = db.run(handle => reflect(handle))
      expect(r2.diffed).toBe(1)
      expect(r2.distilled).toBe(1)
      expect(db.run(handle => getSharedPatterns(handle)).length).toBe(1)

      // Call 3: a 4th matching row — pattern already distilled for this signature, must not duplicate.
      const t4 = seedCompletedTask(db, 'stable outcome')
      db.run(handle => persistOutcomeExpectation(handle, { task_id: t4, expected_outcome: 'stable outcome' }))
      const r3 = db.run(handle => reflect(handle))
      expect(r3.diffed).toBe(1)
      expect(r3.distilled).toBe(0) // already distilled for this signature — no duplicate
      expect(db.run(handle => getSharedPatterns(handle)).length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('reflect() calls the verification-axis triad read-only (static scan: only get*() calls, never a write symbol, matches ATM-PF1-08\'s import guard)', () => {
    const reflectBody = functionBody(REFLECTION_TS, 'export function reflect', ['\nexport function ', '\nexport const ', '\nexport interface '])
    expect(reflectBody).toMatch(/getFailureClassifications|getCrossFamilyCritiques|getTernaryRewards/)
    expect(reflectBody).not.toMatch(/persistFailureClassification|persistCrossFamilyCritique|persistTernaryReward/)
  })
})

// ---------------------------------------------------------------------------
// PK-PF1-4 Stage B — ATM-PF1-09: 4 distinct audit_log actions
// ---------------------------------------------------------------------------

describe('ATM-PF1-09: audit_log actions (runtime, fresh DB)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-audit-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }
  function auditActions(db: TaskDB): string[] {
    return db.run(handle => handle.prepare('SELECT action FROM audit_log ORDER BY id ASC').all() as { action: string }[]).map(r => r.action)
  }

  test('persistOutcomeExpectation() appends exactly one "outcome_expected" audit_log row, same transaction as the insert', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => persistOutcomeExpectation(handle, { task_id: 1, expected_outcome: 'x' }))
      expect(id).not.toBeNull()
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'outcome_expected').length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('reflect() appends one "outcome_reflected" audit_log row per row it diffs', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(handle => handle.prepare(
        "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result) VALUES ('sadie', 'sadie', 'seed', 'normal', 'completed', 'ok') RETURNING id",
      ).get() as { id: number }).id
      db.run(handle => persistOutcomeExpectation(handle, { task_id: taskId, expected_outcome: 'ok' }))
      const result = db.run(handle => reflect(handle))
      expect(result.diffed).toBe(1)
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'outcome_reflected').length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('distillSharedPattern() (via persistSharedPattern) appends exactly one "shared_pattern_distilled" audit_log row on a successful distill', () => {
    const { db, path } = freshDb()
    try {
      const ids = [1, 2, 3].map(n => db.run(handle => {
        const id = persistOutcomeExpectation(handle, { task_id: n, expected_outcome: 'z' })!
        const diff = diffOutcome({ expected: 'z', actual: 'z' })
        handle.prepare("UPDATE outcome_expectations SET diffed_at = datetime('now'), diff_result = ? WHERE id = ?").run(JSON.stringify(diff), id)
        return id
      }))
      const rows = db.run(handle => getOutcomeExpectations(handle)).filter(r => ids.includes(r.id))
      const patternId = db.run(handle => distillSharedPattern(handle, rows, 'match::z'))
      expect(patternId).not.toBeNull()
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'shared_pattern_distilled').length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('supersedeSharedPattern() appends exactly one "shared_pattern_superseded" audit_log row', () => {
    const { db, path } = freshDb()
    try {
      const p1Id = db.run(handle => handle.prepare(
        "INSERT INTO shared_patterns (pattern_text, confidence, is_active) VALUES ('old', 0.7, 1) RETURNING id",
      ).get() as { id: number }).id
      const p2Id = db.run(handle => supersedeSharedPattern(handle, p1Id, { pattern_text: 'new', confidence: 0.9, source_expectation_id: 1 }))
      expect(p2Id).not.toBeNull()
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'shared_pattern_superseded').length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('flag OFF: zero audit_log rows from any PF1 write path (no-op returns null before any write, incl. audit)', () => {
    const path = `/tmp/pf1-audit-off-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    try {
      const id = db.run(handle => persistOutcomeExpectation(handle, { task_id: 1, expected_outcome: 'x' }))
      expect(id).toBeNull()
      const actions = auditActions(db)
      expect(actions.filter(a => ['outcome_expected', 'outcome_reflected', 'shared_pattern_distilled', 'shared_pattern_superseded'].includes(a)).length).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('a failed persistOutcomeExpectation() transaction (forced throw) rolls back the audit row too (all-or-nothing)', () => {
    const { db, path } = freshDb()
    try {
      // task_id NOT NULL violation forces the INSERT (and therefore the whole txn) to throw.
      // @ts-expect-error — deliberate NOT NULL violation to force a DB-level throw.
      expect(() => db.run(handle => persistOutcomeExpectation(handle, { task_id: null, expected_outcome: 'x' }))).toThrow()
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'outcome_expected').length).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// PK-PF1-5 — codex round 1 fold. 3 findings folded (HIGH-3, MED-1 verified
// real, MED-3), all fixable entirely within reflection/outcome-feedback.ts.
// The other 2 HIGH + 1 MED findings from round 1 touch server.ts/debrief.ts
// or are design-level questions — reported to boss, not folded here (see
// BASELINES.md's PK-PF1-5 section for the full triage).
// ---------------------------------------------------------------------------

describe('PK-PF1-5 fold: distillSharedPattern() dedup is LIKE-injection-proof and spoof-proof (codex round 1, HIGH)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-5-dedup-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }
  function seedDiffedExpectation(db: TaskDB, taskId: number, expected: string, actual: string): number {
    return db.run(handle => {
      const id = persistOutcomeExpectation(handle, { task_id: taskId, expected_outcome: expected })!
      const diff = diffOutcome({ expected, actual })
      handle.prepare("UPDATE outcome_expectations SET diffed_at = datetime('now'), diff_result = ? WHERE id = ?").run(JSON.stringify(diff), id)
      return id
    })
  }

  test('a signature containing a literal "_" does not false-match an unrelated signature via SQL LIKE wildcard semantics', () => {
    const { db, path } = freshDb()
    try {
      // Distill "mismatch::fooxbar" first (note the "x", not "_").
      const group1Ids = [1, 2, 3].map(n => seedDiffedExpectation(db, n, 'fooxbar', 'different'))
      const rows1 = db.run(handle => getOutcomeExpectations(handle)).filter(r => group1Ids.includes(r.id))
      const p1 = db.run(handle => distillSharedPattern(handle, rows1, 'mismatch::fooxbar'))
      expect(p1).not.toBeNull()

      // Now distill "mismatch::foo_bar" — a DIFFERENT signature (real underscore).
      // Pre-fix, `LIKE '%[[sig:mismatch::foo_bar]]%'` treats `_` as a single-char
      // wildcard, so it ALSO matches the "fooxbar" tag stored above and
      // incorrectly skips this distillation.
      const group2Ids = [4, 5, 6].map(n => seedDiffedExpectation(db, n, 'foo_bar', 'different'))
      const rows2 = db.run(handle => getOutcomeExpectations(handle)).filter(r => group2Ids.includes(r.id))
      const p2 = db.run(handle => distillSharedPattern(handle, rows2, 'mismatch::foo_bar'))
      expect(p2).not.toBeNull() // must NOT be suppressed by the unrelated "fooxbar" tag

      const patterns = db.run(handle => getSharedPatterns(handle))
      expect(patterns.length).toBe(2)
    } finally {
      cleanup(db, path)
    }
  })

  test('a signature containing a literal "%" does not corrupt the dedup query', () => {
    const { db, path } = freshDb()
    try {
      const ids = [1, 2, 3].map(n => seedDiffedExpectation(db, n, '100% done', '100% done'))
      const rows = db.run(handle => getOutcomeExpectations(handle)).filter(r => ids.includes(r.id))
      const p1 = db.run(handle => distillSharedPattern(handle, rows, 'match::100% done'))
      expect(p1).not.toBeNull()
      // Re-distilling the SAME signature must still be correctly deduped (not
      // broken by the literal "%" in the tag).
      const p2 = db.run(handle => distillSharedPattern(handle, rows, 'match::100% done'))
      expect(p2).toBeNull()
    } finally {
      cleanup(db, path)
    }
  })

  test('a spoofed "[[sig:...]]" string embedded in expected_outcome text does not suppress an unrelated signature\'s distillation', () => {
    const { db, path } = freshDb()
    try {
      // Distill a real signature first.
      const realIds = [1, 2, 3].map(n => seedDiffedExpectation(db, n, 'real signature text', 'real signature text'))
      const realRows = db.run(handle => getOutcomeExpectations(handle)).filter(r => realIds.includes(r.id))
      const pReal = db.run(handle => distillSharedPattern(handle, realRows, 'match::real signature text'))
      expect(pReal).not.toBeNull()

      // A task description embeds a literal tag-shaped string that matches the
      // signature used for a SEPARATE, targeted attack signature.
      const spoofedText = `delegated: please handle [[sig:match::victim signature]] carefully`
      const spoofIds = [4].map(n => seedDiffedExpectation(db, n, spoofedText, spoofedText))
      // Pre-fix, a substring LIKE search for '%[[sig:match::victim signature]]%'
      // would match this row's pattern_text-adjacent expected_outcome text if it
      // ever got embedded into a pattern_text tail — the fix (strict tag-prefix
      // check) means this spoofed text alone can never satisfy the dedup query,
      // since the tag must be the pattern_text's actual PREFIX, not appear
      // anywhere in the human-readable trailing description.
      const victimIds = [5, 6, 7].map(n => seedDiffedExpectation(db, n, 'victim signature', 'victim signature'))
      const victimRows = db.run(handle => getOutcomeExpectations(handle)).filter(r => victimIds.includes(r.id))
      const pVictim = db.run(handle => distillSharedPattern(handle, victimRows, 'match::victim signature'))
      expect(pVictim).not.toBeNull() // must NOT be suppressed by the spoofed text
    } finally {
      cleanup(db, path)
    }
  })
})

describe('PK-PF1-5 fold: reflect() excludes non-completed tasks (codex round 1, MED — verified real against completeTaskWithFinalizerCheck)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-5-review-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }

  test('a task with status=review and a populated result is NOT diffed — the review-gate has not been accepted yet (db.ts:1805/1874 card-vs-task terminal semantics)', () => {
    const { db, path } = freshDb()
    try {
      // Mirrors what completeTaskWithFinalizerCheck() actually does for a
      // board-CARD row: status='review', result populated, in the SAME UPDATE
      // shape as db.ts:1805-1820.
      const taskId = db.run(handle => handle.prepare(
        "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result, complexity_user) VALUES ('sadie', 'sadie', 'card', 'normal', 'review', 'card work summary', 3) RETURNING id",
      ).get() as { id: number }).id
      db.run(handle => persistOutcomeExpectation(handle, { task_id: taskId, expected_outcome: 'card work summary' }))

      const result = db.run(handle => reflect(handle))
      expect(result.diffed).toBe(0) // must NOT diff a review-gated card before human [Accept]

      const row = db.run(handle => handle.prepare('SELECT diffed_at FROM outcome_expectations WHERE task_id = ?').get(taskId)) as { diffed_at: string | null }
      expect(row.diffed_at).toBeNull()
    } finally {
      cleanup(db, path)
    }
  })

  test('a task with status=completed and a populated result IS diffed (unchanged plain-task behavior)', () => {
    const { db, path } = freshDb()
    try {
      const taskId = db.run(handle => handle.prepare(
        "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result) VALUES ('sadie', 'sadie', 'plain', 'normal', 'completed', 'plain task result') RETURNING id",
      ).get() as { id: number }).id
      db.run(handle => persistOutcomeExpectation(handle, { task_id: taskId, expected_outcome: 'plain task result' }))

      const result = db.run(handle => reflect(handle))
      expect(result.diffed).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })
})

describe('PK-PF1-5 fold: supersedeSharedPattern() validation + full-lineage dedup (codex round 1, MED)', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-5-supersede-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }
  function seedDiffedExpectation(db: TaskDB, taskId: number, expected: string, actual: string): number {
    return db.run(handle => {
      const id = persistOutcomeExpectation(handle, { task_id: taskId, expected_outcome: expected })!
      const diff = diffOutcome({ expected, actual })
      handle.prepare("UPDATE outcome_expectations SET diffed_at = datetime('now'), diff_result = ? WHERE id = ?").run(JSON.stringify(diff), id)
      return id
    })
  }

  test('supersedeSharedPattern() returns null (no write) when oldPatternId does not exist', () => {
    const { db, path } = freshDb()
    try {
      const before = db.run(handle => handle.prepare('SELECT COUNT(*) AS n FROM shared_patterns').get()) as { n: number }
      const result = db.run(handle => supersedeSharedPattern(handle, 99999, { pattern_text: 'new', confidence: 0.9, source_expectation_id: 1 }))
      expect(result).toBeNull()
      const after = db.run(handle => handle.prepare('SELECT COUNT(*) AS n FROM shared_patterns').get()) as { n: number }
      expect(after.n).toBe(before.n) // zero writes — no orphan replacement row
    } finally {
      cleanup(db, path)
    }
  })

  test('supersedeSharedPattern() returns null (no write) when oldPatternId is already inactive (already superseded)', () => {
    const { db, path } = freshDb()
    try {
      const p1Id = db.run(handle => handle.prepare(
        "INSERT INTO shared_patterns (pattern_text, confidence, is_active) VALUES ('p1', 0.7, 1) RETURNING id",
      ).get() as { id: number }).id
      const p2Id = db.run(handle => supersedeSharedPattern(handle, p1Id, { pattern_text: 'p2', confidence: 0.8, source_expectation_id: 1 }))
      expect(p2Id).not.toBeNull()

      // Attempting to supersede the now-INACTIVE p1 again must fail cleanly.
      const before = db.run(handle => handle.prepare('SELECT COUNT(*) AS n FROM shared_patterns').get()) as { n: number }
      const p3Id = db.run(handle => supersedeSharedPattern(handle, p1Id, { pattern_text: 'p3', confidence: 0.9, source_expectation_id: 1 }))
      expect(p3Id).toBeNull()
      const after = db.run(handle => handle.prepare('SELECT COUNT(*) AS n FROM shared_patterns').get()) as { n: number }
      expect(after.n).toBe(before.n)
    } finally {
      cleanup(db, path)
    }
  })

  test('after a valid supersede, distillSharedPattern() does NOT re-distill the same (now-superseded) signature', () => {
    const { db, path } = freshDb()
    try {
      const ids = [1, 2, 3].map(n => seedDiffedExpectation(db, n, 'stable', 'stable'))
      const rows = db.run(handle => getOutcomeExpectations(handle)).filter(r => ids.includes(r.id))
      const p1 = db.run(handle => distillSharedPattern(handle, rows, 'match::stable'))
      expect(p1).not.toBeNull()

      // Supersede p1 with a manually-curated replacement (arbitrary pattern_text,
      // simulating a human/curator supersede, not another auto-distill).
      const p2 = db.run(handle => supersedeSharedPattern(handle, p1!, { pattern_text: 'curated replacement text', confidence: 0.95, source_expectation_id: rows[0].id }))
      expect(p2).not.toBeNull()

      // A 4th matching row accumulates — pre-fix, distillSharedPattern()'s
      // "is_active=1" dedup filter finds NO active row for the "match::stable"
      // tag (p1 is now inactive) and incorrectly re-distills, creating a
      // duplicate active pattern for the same underlying signature.
      const id4 = seedDiffedExpectation(db, 4, 'stable', 'stable')
      const allRows = db.run(handle => getOutcomeExpectations(handle)).filter(r => [...ids, id4].includes(r.id))
      const p3 = db.run(handle => distillSharedPattern(handle, allRows, 'match::stable'))
      expect(p3).toBeNull() // must NOT re-distill — the signature was already handled (superseded)

      const activePatterns = db.run(handle => getSharedPatterns(handle))
      expect(activePatterns.length).toBe(1) // only the curated replacement is active
      expect(activePatterns[0].pattern_text).toContain('curated replacement text')
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// PK-PF1-5 codex round 1 fold — E2/HIGH, boss's L2 lock, RECURRENCE-COLLISION
// test class: two DISTINCT tasks with equivalent descriptions must produce
// IDENTICAL signatures, so N>=3 distillation is actually reachable for real
// cross-task data. `buildExpectedOutcome()` below reproduces server.ts's
// exact argument-construction template — cross-checked by the static test at
// the end of this section so the reproduction can never silently drift from
// the real code. (The companion UNIQUENESS-STRIPPING test class lives in
// tests/guardrails/pf1-4-wiring.guard.test.ts, since it's a pure static scan
// of server.ts's source, not a runtime/signature test.)
// ---------------------------------------------------------------------------

describe('PK-PF1-5 fold (E2/L2): RECURRENCE-COLLISION — equivalent descriptions produce identical signatures, distillation reachable', () => {
  function freshDb(): { db: TaskDB; path: string } {
    const path = `/tmp/pf1-5-recurrence-${crypto.randomUUID()}.db`
    const db = new TaskDB(path)
    db.setFeatureFlag('outcome_feedback_enabled', true)
    return { db, path }
  }
  function cleanup(db: TaskDB, path: string): void {
    db.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(path + suffix) } catch {}
    }
  }
  // Mirrors server.ts's `Expected outcome: ${description}` template exactly
  // — see the static cross-check test below.
  function buildExpectedOutcome(description: string): string {
    return `Expected outcome: ${description}`
  }
  function seedTaskAndExpectation(db: TaskDB, description: string, result: string): { taskId: number; expectationId: number } {
    const taskId = db.run(handle => handle.prepare(
      "INSERT INTO tasks (from_agent, to_agent, description, priority, status, result) VALUES ('sadie', 'sadie', ?, 'normal', 'completed', ?) RETURNING id",
    ).get(description, result) as { id: number }).id
    const expectationId = db.run(handle => persistOutcomeExpectation(handle, { task_id: taskId, expected_outcome: buildExpectedOutcome(description) }))!
    return { taskId, expectationId }
  }

  test('two DISTINCT tasks (different task_ids) with the equivalent description produce IDENTICAL stored expected_outcome text (no task_id leaked into the text)', () => {
    const { db, path } = freshDb()
    try {
      const t1 = seedTaskAndExpectation(db, 'ship the widget', 'done')
      const t2 = seedTaskAndExpectation(db, 'ship the widget', 'done')
      expect(t1.taskId).not.toBe(t2.taskId) // genuinely distinct tasks

      const row1 = db.run(handle => getOutcomeExpectations(handle, { taskId: t1.taskId }))[0]
      const row2 = db.run(handle => getOutcomeExpectations(handle, { taskId: t2.taskId }))[0]
      expect(row1.expected_outcome).toBe(row2.expected_outcome) // byte-identical text
      expect(row1.expected_outcome).not.toContain(String(t1.taskId))
      expect(row1.expected_outcome).not.toContain(String(t2.taskId))
    } finally {
      cleanup(db, path)
    }
  })

  test('two DISTINCT tasks with equivalent descriptions produce the IDENTICAL computeSignature() output', () => {
    const { db, path } = freshDb()
    try {
      const desc = 'run the nightly export'
      const exp1 = buildExpectedOutcome(desc)
      const exp2 = buildExpectedOutcome(desc)
      const diff1 = diffOutcome({ expected: exp1, actual: 'export failed: timeout' })
      const diff2 = diffOutcome({ expected: exp2, actual: 'export failed: connection reset' }) // different actual text — still same signature, since signature is expected-side only
      const sig1 = computeSignature(diff1.matched, exp1)
      const sig2 = computeSignature(diff2.matched, exp2)
      expect(sig1).toBe(sig2)
    } finally {
      cleanup(db, path)
    }
  })

  test('3 DISTINCT tasks with equivalent descriptions reach the N>=3 distillation threshold via reflect() — this is the actual reachability proof', () => {
    const { db, path } = freshDb()
    try {
      seedTaskAndExpectation(db, 'restart the ingestion pipeline', 'restarted successfully')
      seedTaskAndExpectation(db, 'restart the ingestion pipeline', 'restarted successfully')
      seedTaskAndExpectation(db, 'restart the ingestion pipeline', 'restarted successfully')

      const r1 = db.run(handle => reflect(handle))
      expect(r1.diffed).toBe(3)
      expect(r1.distilled).toBe(1) // pre-E2, this was always 0 — 3 distinct task_ids meant 3 distinct signatures, never reachable

      const patterns = db.run(handle => getSharedPatterns(handle))
      expect(patterns.length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('STATIC CROSS-CHECK: server.ts\'s actual expected_outcome argument template matches buildExpectedOutcome() above exactly, so this test file\'s reproduction cannot silently drift from the real code', () => {
    expect(REFLECTION_TS).toBeTruthy() // sanity: file loaded
    const serverTsPath = resolve(__dirname, '..', '..', 'server.ts')
    const serverTs = readFileSync(serverTsPath, 'utf-8')
    // All 4 sites must use the literal template `Expected outcome: ${...}`.
    const occurrences = (serverTs.match(/expected_outcome: `Expected outcome: \$\{[^}]+\}`/g) ?? []).length
    expect(occurrences).toBe(4)
  })
})
