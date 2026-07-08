// tests/cross-family-critique-p6-integration.test.ts — P7 Stage 3
// integration test (ATM-012 / REQ-008 [P1] / M-008).
//
// Covers getMandatoryCrossFamilyReviewClassifications(db, filter?) against a
// REAL fixture DB seeded via P6's own persistFailureClassification() — not
// synthetic in-memory objects (that's tests/cross-family-critique.test.ts's
// job for ATM-011/013/014/015). Mirrors the exact DB-construction +
// flag-enable + persist-fixture pattern used by P6's own integration tests
// (tests/failure-classification.test.ts's ATM-020/ATM-024 describe blocks):
// a `TaskDB` (bun:sqlite-backed, migrate()'d automatically in its
// constructor), `taskDb.setFeatureFlag('failure_classification_enabled',
// true)` (persistFailureClassification() is a flag-gated no-op otherwise —
// REQ-010/ATM-021 in P6), and `taskDb.run(db => persistFailureClassification(db, ...))`
// to actually write rows.
//
// Isolation: run via run-tests-isolated.sh, which redirects HOME so the live
// board tasks.db is never touched. This file additionally uses its OWN
// throwaway temp/file-backed db path (wiped before/after each test), never
// touching the isolated-runner's redirected default DB_PATH either.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { TaskDB } from '../db'
import {
  persistFailureClassification,
  type FailureClassification,
} from '../verification/failure-classification'
import { getMandatoryCrossFamilyReviewClassifications } from '../verification/cross-family-critique'

/** Removes a sqlite db file plus its -shm/-wal sidecars, tolerating "doesn't exist". */
function wipeDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch { /* doesn't exist yet */ }
  }
}

/** Builds a FailureClassification literal with sane defaults, override-able per test. Mirrors
 * tests/failure-classification.test.ts's own makeFailureClassification() helper. */
function makeFailureClassification(overrides: Partial<FailureClassification> = {}): FailureClassification {
  return {
    failure_class: 'verification_failure',
    severity: 'medium',
    transience: 'transient',
    domain: 'agent',
    taxonomy_version: 1,
    signal_source: 'verify_check',
    source_ref: 'chk-1',
    task_id: null,
    agent: 'boss',
    summary: 'a test classification',
    raw_signal: { source: 'verify_check', checkResultId: 'chk-1' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ATM-012 / REQ-008 [P1] — getMandatoryCrossFamilyReviewClassifications()
// against a fixture DB seeded via P6's own persistFailureClassification()
// ---------------------------------------------------------------------------
describe('ATM-012: getMandatoryCrossFamilyReviewClassifications() — P6 fixture-DB integration (REQ-008)', () => {
  const TEST_DB = '/tmp/p7-cross-family-critique-atm012.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    // persistFailureClassification() is a flag-gated no-op when OFF (P6
    // REQ-010/ATM-021) — must enable it first or every persist call below
    // silently returns null and inserts nothing.
    taskDb.setFeatureFlag('failure_classification_enabled', true)
  })

  afterEach(() => wipeDbFile(TEST_DB))

  test('5 seeded rows (2 mandatory, 3 non-mandatory) for a given taskId -> returns EXACTLY the 2 mandatory rows, id ASC', () => {
    const TASK_ID = 777

    // Non-mandatory #1: severity='low', non-adversarial failure_class.
    const idNonMandatory1 = taskDb.run((db) =>
      persistFailureClassification(
        db,
        makeFailureClassification({
          task_id: TASK_ID,
          failure_class: 'blocked_dependency',
          severity: 'low',
          summary: 'non-mandatory: low severity',
        }),
      ),
    )

    // Mandatory #1: failure_class='correctness_adversarial_finding'.
    const idMandatory1 = taskDb.run((db) =>
      persistFailureClassification(
        db,
        makeFailureClassification({
          task_id: TASK_ID,
          failure_class: 'correctness_adversarial_finding',
          severity: 'medium',
          summary: 'mandatory: adversarial finding',
        }),
      ),
    )

    // Non-mandatory #2: severity='medium', non-adversarial failure_class.
    const idNonMandatory2 = taskDb.run((db) =>
      persistFailureClassification(
        db,
        makeFailureClassification({
          task_id: TASK_ID,
          failure_class: 'test_failure',
          severity: 'medium',
          summary: 'non-mandatory: medium severity',
        }),
      ),
    )

    // Mandatory #2: severity='high'.
    const idMandatory2 = taskDb.run((db) =>
      persistFailureClassification(
        db,
        makeFailureClassification({
          task_id: TASK_ID,
          failure_class: 'liveness_timeout',
          severity: 'high',
          summary: 'mandatory: high severity',
        }),
      ),
    )

    // Non-mandatory #3: severity='low', non-adversarial failure_class.
    const idNonMandatory3 = taskDb.run((db) =>
      persistFailureClassification(
        db,
        makeFailureClassification({
          task_id: TASK_ID,
          failure_class: 'infrastructure_transient',
          severity: 'low',
          summary: 'non-mandatory: low severity #2',
        }),
      ),
    )

    // Sanity: all 5 inserts succeeded (flag was ON), strictly increasing ids.
    expect(idNonMandatory1).not.toBeNull()
    expect(idMandatory1).not.toBeNull()
    expect(idNonMandatory2).not.toBeNull()
    expect(idMandatory2).not.toBeNull()
    expect(idNonMandatory3).not.toBeNull()

    const result = taskDb.run((db) => getMandatoryCrossFamilyReviewClassifications(db, { taskId: TASK_ID }))

    expect(result.length).toBe(2)
    // id ASC ordering preserved from the underlying getFailureClassifications() accessor.
    expect(result[0]!.id).toBe(idMandatory1!)
    expect(result[1]!.id).toBe(idMandatory2!)
    expect(result.map((r) => r.failure_class)).toEqual(['correctness_adversarial_finding', 'liveness_timeout'])
    expect(result.map((r) => r.severity)).toEqual(['medium', 'high'])

    // Explicitly confirm neither non-mandatory id leaked into the result.
    const resultIds = new Set(result.map((r) => r.id))
    expect(resultIds.has(idNonMandatory1!)).toBe(false)
    expect(resultIds.has(idNonMandatory2!)).toBe(false)
    expect(resultIds.has(idNonMandatory3!)).toBe(false)
  })

  test('no rows for the given taskId -> returns []', () => {
    const result = taskDb.run((db) => getMandatoryCrossFamilyReviewClassifications(db, { taskId: 999999 }))
    expect(result).toEqual([])
  })

  test('filter is forwarded to getFailureClassifications() — agent filter narrows correctly', () => {
    const TASK_ID = 888
    taskDb.run((db) =>
      persistFailureClassification(
        db,
        makeFailureClassification({
          task_id: TASK_ID,
          agent: 'boss',
          failure_class: 'correctness_adversarial_finding',
          severity: 'medium',
        }),
      ),
    )
    taskDb.run((db) =>
      persistFailureClassification(
        db,
        makeFailureClassification({
          task_id: TASK_ID,
          agent: 'steve',
          failure_class: 'correctness_adversarial_finding',
          severity: 'medium',
        }),
      ),
    )

    const resultForBoss = taskDb.run((db) =>
      getMandatoryCrossFamilyReviewClassifications(db, { taskId: TASK_ID, agent: 'boss' }),
    )
    expect(resultForBoss.length).toBe(1)
    expect(resultForBoss[0]!.agent).toBe('boss')
  })
})
