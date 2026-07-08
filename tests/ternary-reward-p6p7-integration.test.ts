// tests/ternary-reward-p6p7-integration.test.ts — P8 Stage 3 integration test
// (ATM-013 / REQ-007 [P1] / M-006).
//
// Covers aggregateCrossFamilyVerdict()/worstMandatoryFailureSeverity() folding
// the output of P7's getCrossFamilyCritiques()/P6's getFailureClassifications()
// against a REAL fixture DB seeded via P7's own persistCrossFamilyCritique() and
// P6's own persistFailureClassification() — not synthetic in-memory objects
// (that's tests/ternary-reward.test.ts's job for ATM-011/012). Mirrors the exact
// DB-construction + flag-enable + persist-fixture pattern used by P7's own
// integration tests (tests/cross-family-critique-p6-integration.test.ts):
// a `TaskDB` (bun:sqlite-backed, migrate()'d automatically in its constructor),
// `taskDb.setFeatureFlag(...)` to enable each upstream persist path (they are
// flag-gated no-ops otherwise), and `taskDb.run(db => fn(db))` to write/read.
//
// NOTE on scope isolation: this TEST file imports the two upstream PERSIST fns
// (persistCrossFamilyCritique / persistFailureClassification) purely to SEED the
// fixture — that is the test's own import graph, NOT the module's.
// ternary-reward.ts itself imports zero write symbols (asserted by ATM-015).
//
// Isolation: run via run-tests-isolated.sh (redirects HOME so the live board
// tasks.db is never touched). This file additionally uses its OWN throwaway
// file-backed db path, wiped before/after each test.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { TaskDB } from '../db'
import {
  persistCrossFamilyCritique,
  getCrossFamilyCritiques,
  type CrossFamilyCritiqueRecord,
} from '../verification/cross-family-critique'
import {
  persistFailureClassification,
  getFailureClassifications,
  type FailureClassification,
} from '../verification/failure-classification'
import { aggregateCrossFamilyVerdict, worstMandatoryFailureSeverity } from '../verification/ternary-reward'

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

/** Inserts a real decisions row, returning its id (mirrors P7's own insertDecision helper). */
function insertDecision(db: import('bun:sqlite').Database, opts: { taskId?: number | null } = {}): number {
  const row = db
    .prepare(`
      INSERT INTO decisions (title, context, opened_by, task_id)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `)
    .get('p8 integration decision', null, 'boss', opts.taskId === undefined ? null : opts.taskId) as { id: number }
  return row.id
}

function makeCritiqueRecord(overrides: Partial<CrossFamilyCritiqueRecord> = {}): CrossFamilyCritiqueRecord {
  return {
    decision_id: 1,
    critique_id: null,
    position_id: null,
    producer_agent: 'boss',
    producer_family: 'openai',
    critic_agent: 'steve',
    critic_family: 'anthropic',
    is_cross_family: true,
    verdict: 'concur',
    linked_failure_class: null,
    ...overrides,
  }
}

function makeFailureClassification(overrides: Partial<FailureClassification> = {}): FailureClassification {
  return {
    failure_class: 'verification_failure',
    severity: 'medium',
    transience: 'transient',
    domain: 'agent',
    taxonomy_version: 1,
    signal_source: 'verify_check',
    source_ref: null,
    task_id: null,
    agent: 'boss',
    summary: 'a test classification',
    raw_signal: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ATM-013 / REQ-007 [P1] — fixture-DB integration for both adapters
// ---------------------------------------------------------------------------
describe('ATM-013: P6+P7 fixture-DB integration for both read adapters', () => {
  const TEST_DB = '/tmp/p8-ternary-reward-atm013.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    // Both upstream persist paths are flag-gated no-ops when OFF — must enable.
    taskDb.setFeatureFlag('cross_family_critique_enabled', true)
    taskDb.setFeatureFlag('failure_classification_enabled', true)
  })

  afterEach(() => wipeDbFile(TEST_DB))

  test('2 cross-family rows (block + concur) → aggregateCrossFamilyVerdict === "block" (precedence)', () => {
    const TASK_ID = 4242
    const decisionId = taskDb.run((db) => insertDecision(db, { taskId: TASK_ID }))

    // Seed via P7's OWN persist fn: one 'concur', one 'block', both cross-family.
    taskDb.run((db) =>
      persistCrossFamilyCritique(
        db,
        makeCritiqueRecord({ decision_id: decisionId, is_cross_family: true, verdict: 'concur' }),
      ),
    )
    taskDb.run((db) =>
      persistCrossFamilyCritique(
        db,
        makeCritiqueRecord({ decision_id: decisionId, is_cross_family: true, verdict: 'block' }),
      ),
    )

    const critiques = taskDb.run((db) => getCrossFamilyCritiques(db, { decisionId }))
    expect(critiques.length).toBe(2)
    expect(aggregateCrossFamilyVerdict(critiques)).toBe('block')
  })

  test('P6 rows (1 high, 1 low) for the linked task → worstMandatoryFailureSeverity === "high"', () => {
    const TASK_ID = 4242

    taskDb.run((db) =>
      persistFailureClassification(db, makeFailureClassification({ task_id: TASK_ID, severity: 'high' })),
    )
    taskDb.run((db) =>
      persistFailureClassification(db, makeFailureClassification({ task_id: TASK_ID, severity: 'low' })),
    )

    const classifications = taskDb.run((db) => getFailureClassifications(db, { taskId: TASK_ID }))
    expect(classifications.length).toBe(2)
    expect(worstMandatoryFailureSeverity(classifications)).toBe('high')
  })

  test('end-to-end: both adapters fold seeded rows → block + high for the same decision/task', () => {
    const TASK_ID = 7777
    const decisionId = taskDb.run((db) => insertDecision(db, { taskId: TASK_ID }))

    taskDb.run((db) =>
      persistCrossFamilyCritique(
        db,
        makeCritiqueRecord({ decision_id: decisionId, is_cross_family: true, verdict: 'block' }),
      ),
    )
    taskDb.run((db) =>
      persistCrossFamilyCritique(
        db,
        makeCritiqueRecord({ decision_id: decisionId, is_cross_family: true, verdict: 'concur' }),
      ),
    )
    taskDb.run((db) =>
      persistFailureClassification(db, makeFailureClassification({ task_id: TASK_ID, severity: 'high' })),
    )
    taskDb.run((db) =>
      persistFailureClassification(db, makeFailureClassification({ task_id: TASK_ID, severity: 'low' })),
    )

    const verdict = taskDb.run((db) => aggregateCrossFamilyVerdict(getCrossFamilyCritiques(db, { decisionId })))
    const severity = taskDb.run((db) =>
      worstMandatoryFailureSeverity(getFailureClassifications(db, { taskId: TASK_ID })),
    )
    expect(verdict).toBe('block')
    expect(severity).toBe('high')
  })
})
