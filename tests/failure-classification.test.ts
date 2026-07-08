// tests/failure-classification.test.ts — P6 EPIC-01 (Taxonomy) TDD tests.
//
// Covers ATM-001 (canonical versioned FailureClass), ATM-002 (append-only
// version guardrail against a committed snapshot fixture), ATM-003 (three
// orthogonal classification axes), and ATM-004 (distinctness/alignment
// guardrails against decision.ts's CritiqueSeverity and db.ts's BlockedOn,
// imported as TYPES ONLY — zero runtime dependency on those modules).
//
// This stage does NOT test classifyFailure(), adapters, persistence, or the
// read accessor — those land in later P6 stages (see specs/P6-spec.md).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import type { CritiqueSeverity } from '../decision'
import type { BlockedOn } from '../db'
import { TaskDB } from '../db'
import taxonomySnapshot from './fixtures/failure-classification-taxonomy.snapshot.json'
import {
  type FailureClass,
  TAXONOMY_VERSION,
  TAXONOMY_CHANGELOG,
  ALL_FAILURE_CLASSES,
  type FailureSeverity,
  ALL_FAILURE_SEVERITIES,
  type FailureTransience,
  ALL_FAILURE_TRANSIENCES,
  type FailureDomain,
  ALL_FAILURE_DOMAINS,
  type FailureClassification,
  type RawFailureSignal,
  IDLE_COUNT_STAGNATION_THRESHOLD,
  classifyFailure,
  persistFailureClassification,
  type PersistedFailureClassification,
  getFailureClassifications,
  fromVerifyCheckResult,
  fromTestRun,
  fromIdleCount,
  fromWatchdogFault,
  fromWatchdogBlocked,
  fromWatchdogDeadSession,
  fromEscalationBridgeAllPathsFailed,
  fromAdversarialFinding,
} from '../verification/failure-classification'

// ---------------------------------------------------------------------------
// ATM-001 / REQ-001 [P1] — Canonical versioned FailureClass
// ---------------------------------------------------------------------------
describe('ATM-001: canonical versioned FailureClass', () => {
  const EXPECTED_CLASSES: FailureClass[] = [
    'verification_failure',
    'test_failure',
    'liveness_timeout',
    'blocked_dependency',
    'infrastructure_transient',
    'contract_scope_conformance',
    'resource_budget_exhaustion',
    'correctness_adversarial_finding',
    'unknown',
  ]

  test('ATM-001: ALL_FAILURE_CLASSES has exactly 9 entries matching the literal set verbatim', () => {
    expect(ALL_FAILURE_CLASSES.length).toBe(9)
    expect([...ALL_FAILURE_CLASSES]).toEqual(EXPECTED_CLASSES)
  })

  test('ATM-001: TAXONOMY_VERSION === 1', () => {
    expect(TAXONOMY_VERSION).toBe(1)
  })

  test('ATM-001: ALL_FAILURE_CLASSES is frozen', () => {
    expect(Object.isFrozen(ALL_FAILURE_CLASSES)).toBe(true)
  })

  test('ATM-001: TAXONOMY_CHANGELOG is empty at v1', () => {
    expect(TAXONOMY_CHANGELOG).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATM-002 / REQ-001(a) [P2] — Append-only version guardrail
// ---------------------------------------------------------------------------
describe('ATM-002: append-only version guardrail', () => {
  type TaxonomySnapshot = { versions: Record<string, string[]> }
  const snapshot = taxonomySnapshot as TaxonomySnapshot

  test('ATM-002: snapshot entry for current TAXONOMY_VERSION deep-equals live ALL_FAILURE_CLASSES', () => {
    const currentEntry = snapshot.versions[String(TAXONOMY_VERSION)]
    expect(currentEntry).toBeDefined()
    expect(currentEntry).toEqual([...ALL_FAILURE_CLASSES])
  })

  test('ATM-002: max snapshot version key equals live TAXONOMY_VERSION', () => {
    const versionKeys = Object.keys(snapshot.versions).map(Number)
    const maxVersion = Math.max(...versionKeys)
    expect(maxVersion).toBe(TAXONOMY_VERSION)
  })

  test('ATM-002: changelog length matches version, and last entry (if any) matches current version', () => {
    expect(TAXONOMY_CHANGELOG.length).toBe(TAXONOMY_VERSION - 1)
    if (TAXONOMY_VERSION > 1) {
      expect(TAXONOMY_CHANGELOG[TAXONOMY_CHANGELOG.length - 1]?.version).toBe(TAXONOMY_VERSION)
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-003 / REQ-002 [P1] — Three orthogonal axes + frozen arrays
// ---------------------------------------------------------------------------
describe('ATM-003: three orthogonal axes', () => {
  test('ATM-003: ALL_FAILURE_SEVERITIES has exactly the 4 documented members and is frozen', () => {
    const expected: FailureSeverity[] = ['low', 'medium', 'high', 'critical']
    expect([...ALL_FAILURE_SEVERITIES]).toEqual(expected)
    expect(Object.isFrozen(ALL_FAILURE_SEVERITIES)).toBe(true)
  })

  test('ATM-003: ALL_FAILURE_TRANSIENCES has exactly the 3 documented members and is frozen', () => {
    const expected: FailureTransience[] = ['transient', 'permanent', 'unknown']
    expect([...ALL_FAILURE_TRANSIENCES]).toEqual(expected)
    expect(Object.isFrozen(ALL_FAILURE_TRANSIENCES)).toBe(true)
  })

  test('ATM-003: ALL_FAILURE_DOMAINS has exactly the 7 documented members and is frozen', () => {
    const expected: FailureDomain[] = [
      'agent',
      'human',
      'external_api',
      'infrastructure',
      'upstream_task',
      'system',
      'unknown',
    ]
    expect([...ALL_FAILURE_DOMAINS]).toEqual(expected)
    expect(Object.isFrozen(ALL_FAILURE_DOMAINS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ATM-004 / REQ-002(a)(b) [P2] — Distinctness + alignment guardrail
// ---------------------------------------------------------------------------
describe('ATM-004: distinctness + alignment guardrails', () => {
  // (a) DISTINCTNESS — compile-time: the literal triple below must be exactly
  // assignable to/from decision.ts's CritiqueSeverity (read-only type import,
  // zero runtime dependency on decision.ts values). If decision.ts's union
  // ever changes, this assignment stops compiling — catching drift.
  type _CritiqueSeverityLiteralTriple = 'observation' | 'concern' | 'blocker'
  type _CritiqueSeverityAlignmentCheck = [CritiqueSeverity] extends [_CritiqueSeverityLiteralTriple]
    ? [_CritiqueSeverityLiteralTriple] extends [CritiqueSeverity]
      ? true
      : false
    : false
  const _critiqueSeverityAlignmentCheck: _CritiqueSeverityAlignmentCheck = true

  test('ATM-004(a): ALL_FAILURE_SEVERITIES has zero overlap with CritiqueSeverity values', () => {
    void _critiqueSeverityAlignmentCheck // referenced so the compile-time check is exercised
    const critiqueSeverityValues = new Set<string>(['observation', 'concern', 'blocker'])
    const overlap = ALL_FAILURE_SEVERITIES.filter((v) => critiqueSeverityValues.has(v))
    expect(overlap).toEqual([])
  })

  // (b) ALIGNMENT — compile-time: the literal quad below must be exactly
  // assignable to/from db.ts's BlockedOn (read-only type import; no import of
  // or query against tasks.blocked_on data — string literals + type only).
  type _BlockedOnLiteralQuad = 'human' | 'external_api' | 'upstream_task' | 'agent'
  type _BlockedOnAlignmentCheck = [BlockedOn] extends [_BlockedOnLiteralQuad]
    ? [_BlockedOnLiteralQuad] extends [BlockedOn]
      ? true
      : false
    : false
  const _blockedOnAlignmentCheck: _BlockedOnAlignmentCheck = true

  test('ATM-004(b): ALL_FAILURE_DOMAINS is a superset of BlockedOn values', () => {
    void _blockedOnAlignmentCheck // referenced so the compile-time check is exercised
    const blockedOnValues: string[] = ['human', 'external_api', 'upstream_task', 'agent']
    const domainSet = new Set<string>(ALL_FAILURE_DOMAINS)
    for (const v of blockedOnValues) {
      expect(domainSet.has(v)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// EPIC-02: FailureClassification record + pure classifyFailure() classifier
// ---------------------------------------------------------------------------
// Covers ATM-005 (record type + RawFailureSignal union), ATM-006 (table-
// driven classifier against the authoritative 16-row mapping table), ATM-007
// (unknown fallback, no throw), ATM-008 (purity + idempotency + source-level
// no-clock guardrail), and ATM-009 (never-throw fuzz over 50 malformed
// inputs, including circular references).

// ---------------------------------------------------------------------------
// ATM-005 / REQ-003 [P1] — FailureClassification record + RawFailureSignal
// ---------------------------------------------------------------------------
describe('ATM-005: FailureClassification record + RawFailureSignal union', () => {
  // Compile-time structural check: FailureClassification must NOT have a
  // `classified_at` or `timestamp` key. If either key existed, the `extends
  // keyof` check below would resolve to `false` and assigning the `true`
  // literal to it would fail to compile.
  type _ClassificationHasNoTimestamp = 'classified_at' extends keyof FailureClassification
    ? false
    : 'timestamp' extends keyof FailureClassification
      ? false
      : true
  const _classificationHasNoTimestamp: _ClassificationHasNoTimestamp = true

  // ONE literal instance per RawFailureSignal variant (all 9 source tags).
  const literalSignals: RawFailureSignal[] = [
    { source: 'verify_check', checkResultId: 'chk-1', task_id: 10, agent: 'boss', summary: 'a failing check' },
    { source: 'test_run', task_id: 11, agent: 'steve', summary: 'unit test failed' },
    { source: 'verify_idle_count', idle_count: 3, task_id: 12, agent: 'sadie', summary: 'idle 3x' },
    { source: 'watchdog_fault', faultType: 'crash', task_id: 13, agent: 'kiera', summary: 'crashed' },
    { source: 'watchdog_blocked', blocked_on: 'human', task_id: 14, agent: 'boss', summary: 'blocked on human' },
    { source: 'watchdog_dead_session', task_id: 15, agent: 'steve', summary: 'dead session' },
    { source: 'escalation_bridge_all_paths_failed', agent: 'sadie', summary: 'all paths failed', source_ref: 'step-3' },
    { source: 'adversarial_finding', category: 'correctness', severityHint: 'HIGH', verifierName: 'codex', summary: 'bug found' },
    { source: 'manual', task_id: 16, agent: 'kiera', summary: 'manual note' },
  ]

  test('ATM-005: exactly 9 RawFailureSignal variants, one literal each, covering the documented source tags', () => {
    expect(literalSignals.length).toBe(9)
    const sources = literalSignals.map((s) => s.source)
    expect(sources).toEqual([
      'verify_check',
      'test_run',
      'verify_idle_count',
      'watchdog_fault',
      'watchdog_blocked',
      'watchdog_dead_session',
      'escalation_bridge_all_paths_failed',
      'adversarial_finding',
      'manual',
    ])
  })

  test('ATM-005: each literal RawFailureSignal round-trips through JSON.stringify -> JSON.parse unchanged', () => {
    for (const sig of literalSignals) {
      const roundTripped = JSON.parse(JSON.stringify(sig))
      expect(roundTripped).toEqual(sig)
    }
  })

  test('ATM-005: FailureClassification has exactly the documented fields and no classified_at/timestamp', () => {
    void _classificationHasNoTimestamp // referenced so the compile-time check is exercised
    const sample: FailureClassification = {
      failure_class: 'unknown',
      severity: 'medium',
      transience: 'unknown',
      domain: 'unknown',
      taxonomy_version: TAXONOMY_VERSION,
      signal_source: 'manual',
      source_ref: null,
      task_id: null,
      agent: null,
      summary: '',
      raw_signal: null,
    }
    const keys = Object.keys(sample).sort()
    expect(keys).toEqual([
      'agent',
      'domain',
      'failure_class',
      'raw_signal',
      'severity',
      'signal_source',
      'source_ref',
      'summary',
      'task_id',
      'taxonomy_version',
      'transience',
    ])
    expect(keys).not.toContain('classified_at')
    expect(keys).not.toContain('timestamp')
  })

  test('ATM-005: IDLE_COUNT_STAGNATION_THRESHOLD === 3', () => {
    expect(IDLE_COUNT_STAGNATION_THRESHOLD).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// ATM-006 / REQ-004(a) [P1] — table-driven classifyFailure() against the
// authoritative 16-row mapping table
// ---------------------------------------------------------------------------
describe('ATM-006: classifyFailure — table-driven 16-row mapping', () => {
  type ExpectedQuad = {
    failure_class: FailureClass
    severity: FailureSeverity
    transience: FailureTransience
    domain: FailureDomain
  }
  type TableCase = { row: number; label: string; signal: RawFailureSignal; expected: ExpectedQuad }

  const cases: TableCase[] = [
    {
      row: 1,
      label: 'verify_check maps unconditionally to verification_failure',
      signal: { source: 'verify_check', checkResultId: 'chk-1', task_id: 1, agent: 'boss', summary: 'failing check' },
      expected: { failure_class: 'verification_failure', severity: 'medium', transience: 'transient', domain: 'agent' },
    },
    {
      row: 2,
      label: 'test_run maps to test_failure',
      signal: { source: 'test_run', task_id: 2, agent: 'steve', summary: 'test failed' },
      expected: { failure_class: 'test_failure', severity: 'high', transience: 'transient', domain: 'agent' },
    },
    {
      row: 3,
      label: 'verify_idle_count >= threshold maps to resource_budget_exhaustion',
      signal: { source: 'verify_idle_count', idle_count: 3, task_id: 3, agent: 'sadie', summary: 'stalled' },
      expected: { failure_class: 'resource_budget_exhaustion', severity: 'medium', transience: 'permanent', domain: 'agent' },
    },
    {
      row: 4,
      label: "watchdog_fault faultType==='crash' maps to liveness_timeout/critical",
      signal: { source: 'watchdog_fault', faultType: 'crash', task_id: 4, agent: 'kiera', summary: 'crashed' },
      expected: { failure_class: 'liveness_timeout', severity: 'critical', transience: 'transient', domain: 'agent' },
    },
    {
      row: 5,
      label: "watchdog_fault faultType==='timeout' maps to liveness_timeout/high",
      signal: { source: 'watchdog_fault', faultType: 'timeout', task_id: 5, agent: 'boss', summary: 'timed out' },
      expected: { failure_class: 'liveness_timeout', severity: 'high', transience: 'transient', domain: 'agent' },
    },
    {
      row: 6,
      label: "watchdog_blocked blocked_on==='human'",
      signal: { source: 'watchdog_blocked', blocked_on: 'human', task_id: 6, agent: 'steve', summary: 'waiting on human' },
      expected: { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'human' },
    },
    {
      row: 7,
      label: "watchdog_blocked blocked_on==='external_api'",
      signal: { source: 'watchdog_blocked', blocked_on: 'external_api', task_id: 7, agent: 'sadie', summary: 'waiting on API' },
      expected: { failure_class: 'blocked_dependency', severity: 'medium', transience: 'transient', domain: 'external_api' },
    },
    {
      row: 8,
      label: "watchdog_blocked blocked_on==='upstream_task'",
      signal: { source: 'watchdog_blocked', blocked_on: 'upstream_task', task_id: 8, agent: 'kiera', summary: 'waiting on upstream' },
      expected: { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'upstream_task' },
    },
    {
      row: 9,
      label: "watchdog_blocked blocked_on==='agent'",
      signal: { source: 'watchdog_blocked', blocked_on: 'agent', task_id: 9, agent: 'boss', summary: 'waiting on agent' },
      expected: { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'agent' },
    },
    {
      row: 10,
      label: 'watchdog_blocked blocked_on===null (legacy)',
      signal: { source: 'watchdog_blocked', blocked_on: null, task_id: 10, agent: 'steve', summary: 'legacy blocked' },
      expected: { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'unknown' },
    },
    {
      row: 11,
      label: 'watchdog_dead_session always maps to liveness_timeout/critical/permanent',
      signal: { source: 'watchdog_dead_session', task_id: 11, agent: 'sadie', summary: 'session died' },
      expected: { failure_class: 'liveness_timeout', severity: 'critical', transience: 'permanent', domain: 'agent' },
    },
    {
      row: 12,
      label: 'escalation_bridge_all_paths_failed always maps to infrastructure_transient',
      signal: { source: 'escalation_bridge_all_paths_failed', agent: 'kiera', summary: 'all paths failed', source_ref: 'step-final' },
      expected: { failure_class: 'infrastructure_transient', severity: 'critical', transience: 'transient', domain: 'infrastructure' },
    },
    {
      row: 13,
      label: "adversarial_finding category==='correctness'",
      signal: { source: 'adversarial_finding', category: 'correctness', severityHint: 'HIGH', verifierName: 'codex', summary: 'bug' },
      expected: { failure_class: 'correctness_adversarial_finding', severity: 'high', transience: 'permanent', domain: 'system' },
    },
    {
      row: 14,
      label: 'adversarial_finding category in contract-scope set',
      signal: { source: 'adversarial_finding', category: 'scope_conformance', severityHint: 'MEDIUM', verifierName: 'codex', summary: 'scope creep' },
      expected: { failure_class: 'contract_scope_conformance', severity: 'medium', transience: 'permanent', domain: 'system' },
    },
    {
      row: 15,
      label: 'adversarial_finding unrecognized category',
      signal: { source: 'adversarial_finding', category: 'made_up_category', severityHint: 'MED', verifierName: 'codex', summary: 'weird' },
      expected: { failure_class: 'unknown', severity: 'medium', transience: 'permanent', domain: 'system' },
    },
    {
      row: 16,
      label: 'manual always falls to the unknown quadruple',
      signal: { source: 'manual', task_id: 16, agent: 'boss', summary: 'manual note' },
      expected: { failure_class: 'unknown', severity: 'medium', transience: 'unknown', domain: 'unknown' },
    },
  ]

  for (const c of cases) {
    test(`ATM-006 row ${c.row}: ${c.label}`, () => {
      const result = classifyFailure(c.signal)
      expect({
        failure_class: result.failure_class,
        severity: result.severity,
        transience: result.transience,
        domain: result.domain,
      }).toEqual(c.expected)
    })
  }

  test('ATM-006 row 16 (unrecognized-source cast): also falls to the unknown quadruple', () => {
    const result = classifyFailure({ source: 'not_a_real_source' } as any)
    expect({
      failure_class: result.failure_class,
      severity: result.severity,
      transience: result.transience,
      domain: result.domain,
    }).toEqual({ failure_class: 'unknown', severity: 'medium', transience: 'unknown', domain: 'unknown' })
  })

  test('ATM-006: classifyFailure populates taxonomy_version/signal_source/source_ref/task_id/agent/summary/raw_signal', () => {
    const signal: RawFailureSignal = {
      source: 'verify_check',
      checkResultId: 'chk-99',
      task_id: 42,
      agent: 'boss',
      summary: 'SG-9 check failed',
    }
    const result = classifyFailure(signal)
    expect(result.taxonomy_version).toBe(TAXONOMY_VERSION)
    expect(result.signal_source).toBe('verify_check')
    expect(result.source_ref).toBe('chk-99')
    expect(result.task_id).toBe(42)
    expect(result.agent).toBe('boss')
    expect(result.summary).toBe('SG-9 check failed')
    expect(result.raw_signal).toEqual(signal)
  })

  test('ATM-006: absent optional context fields populate as null/"" (not undefined)', () => {
    const result = classifyFailure({ source: 'test_run' })
    expect(result.source_ref).toBeNull()
    expect(result.task_id).toBeNull()
    expect(result.agent).toBeNull()
    expect(result.summary).toBe('')
  })

  const contractScopeCategories = [
    'scope_conformance',
    'verifiability',
    'ears_conformance',
    'traceability',
    'classifier_rigor',
    'consumption_contract',
  ]
  for (const category of contractScopeCategories) {
    test(`ATM-006 supplemental: adversarial_finding category="${category}" maps to contract_scope_conformance`, () => {
      const result = classifyFailure({ source: 'adversarial_finding', category, severityHint: 'MEDIUM', summary: 'x' })
      expect(result.failure_class).toBe('contract_scope_conformance')
      expect(result.transience).toBe('permanent')
      expect(result.domain).toBe('system')
    })
  }

  test('ATM-006 supplemental: severityHint mapping — HIGH/MEDIUM/MED/other', () => {
    const high = classifyFailure({ source: 'adversarial_finding', category: 'correctness', severityHint: 'HIGH', summary: 'x' })
    const medium = classifyFailure({ source: 'adversarial_finding', category: 'correctness', severityHint: 'MEDIUM', summary: 'x' })
    const med = classifyFailure({ source: 'adversarial_finding', category: 'correctness', severityHint: 'MED', summary: 'x' })
    const other = classifyFailure({ source: 'adversarial_finding', category: 'correctness', severityHint: 'LOW', summary: 'x' })
    expect(high.severity).toBe('high')
    expect(medium.severity).toBe('medium')
    expect(med.severity).toBe('medium')
    expect(other.severity).toBe('medium')
  })
})

// ---------------------------------------------------------------------------
// ATM-007 / REQ-004(b) [P1] — unknown fallback, never throws
// ---------------------------------------------------------------------------
describe('ATM-007: unknown fallback — no throw on unrecognized/malformed input', () => {
  test('ATM-007(a): classifyFailure({ source: "not_a_real_source" } as any) -> unknown, no throw', () => {
    expect(() => classifyFailure({ source: 'not_a_real_source' } as any)).not.toThrow()
    const result = classifyFailure({ source: 'not_a_real_source' } as any)
    expect(result.failure_class).toBe('unknown')
    expect(result.severity).toBe('medium')
    expect(result.transience).toBe('unknown')
    expect(result.domain).toBe('unknown')
  })

  test('ATM-007(b): classifyFailure({ source: "watchdog_fault" } as any) (missing faultType) -> unknown, no throw', () => {
    expect(() => classifyFailure({ source: 'watchdog_fault' } as any)).not.toThrow()
    const result = classifyFailure({ source: 'watchdog_fault' } as any)
    expect(result.failure_class).toBe('unknown')
    expect(result.severity).toBe('medium')
    expect(result.transience).toBe('unknown')
    expect(result.domain).toBe('unknown')
  })

  // Codex round-2 fold (Finding 1 / REQ-004(b)): recognized sources with
  // malformed/missing/wrong-type REQUIRED fields must ALSO fall to the full
  // row-16 unknown quadruple — not partially map via some other branch.
  test('ATM-007(c): classifyFailure({ source: "verify_check" } as any) (missing checkResultId) -> full unknown quadruple, no throw', () => {
    expect(() => classifyFailure({ source: 'verify_check' } as any)).not.toThrow()
    const result = classifyFailure({ source: 'verify_check' } as any)
    expect(result.failure_class).toBe('unknown')
    expect(result.severity).toBe('medium')
    expect(result.transience).toBe('unknown')
    expect(result.domain).toBe('unknown')
  })

  test('ATM-007(d): classifyFailure({ source: "watchdog_blocked" } as any) (missing blocked_on) -> full unknown quadruple, no throw', () => {
    expect(() => classifyFailure({ source: 'watchdog_blocked' } as any)).not.toThrow()
    const result = classifyFailure({ source: 'watchdog_blocked' } as any)
    expect(result.failure_class).toBe('unknown')
    expect(result.severity).toBe('medium')
    expect(result.transience).toBe('unknown')
    expect(result.domain).toBe('unknown')
  })

  test("ATM-007(e): classifyFailure({ source: 'watchdog_blocked', blocked_on: 'bogus' } as any) -> full unknown quadruple, no throw (only blocked_on===null maps to row 10)", () => {
    expect(() => classifyFailure({ source: 'watchdog_blocked', blocked_on: 'bogus' } as any)).not.toThrow()
    const result = classifyFailure({ source: 'watchdog_blocked', blocked_on: 'bogus' } as any)
    expect(result.failure_class).toBe('unknown')
    expect(result.severity).toBe('medium')
    expect(result.transience).toBe('unknown')
    expect(result.domain).toBe('unknown')
  })

  test('ATM-007(f): classifyFailure({ source: "adversarial_finding" } as any) (missing category) -> full unknown quadruple, no throw', () => {
    expect(() => classifyFailure({ source: 'adversarial_finding' } as any)).not.toThrow()
    const result = classifyFailure({ source: 'adversarial_finding' } as any)
    expect(result.failure_class).toBe('unknown')
    expect(result.severity).toBe('medium')
    expect(result.transience).toBe('unknown')
    expect(result.domain).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// ATM-008 / REQ-004(c) [P1] — purity + idempotency
// ---------------------------------------------------------------------------
describe('ATM-008: purity + idempotency', () => {
  test('ATM-008(a): classifyFailure(sig) called twice on the same literal input fully deep-equals (no timestamp field to exclude)', () => {
    const sig: RawFailureSignal = {
      source: 'watchdog_fault',
      faultType: 'crash',
      task_id: 99,
      agent: 'boss',
      summary: 'flaky crash',
    }
    const r1 = classifyFailure(sig)
    const r2 = classifyFailure(sig)
    expect(r1).toEqual(r2)
    expect(r1).toStrictEqual(r2)
  })

  test('ATM-008(b): the classifyFailure function body contains no Date/Date.now/performance.now/datetime( occurrence (source-level check)', () => {
    const modulePath = join(import.meta.dir, '..', 'verification', 'failure-classification.ts')
    const source = readFileSync(modulePath, 'utf8')

    const marker = 'export function classifyFailure'
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)

    const braceStart = source.indexOf('{', start)
    expect(braceStart).toBeGreaterThan(start)

    // Brace-match to find the end of the classifyFailure function body, so
    // the check is scoped to the function itself.
    let depth = 0
    let end = -1
    for (let i = braceStart; i < source.length; i++) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end).toBeGreaterThan(braceStart)

    const body = source.slice(braceStart, end + 1)
    expect(body).not.toMatch(/\bnew\s+Date\b/)
    expect(body).not.toMatch(/\bDate\.now\b/)
    expect(body).not.toMatch(/\bDate\s*\(/)
    expect(body).not.toMatch(/\bperformance\.now\b/)
    expect(body).not.toMatch(/datetime\(/)
  })
})

// ---------------------------------------------------------------------------
// ATM-009 / REQ-004(b) [P2] — never-throw fuzz over 50 malformed inputs
// ---------------------------------------------------------------------------

/** Bare quadruple shape used to pin an exact expected classification per ATM-009 case. */
type Atm009Quad = { failure_class: string; severity: string; transience: string; domain: string }

/** Row 16 — the full unknown fallback quadruple. */
const ATM009_UNKNOWN_QUAD: Atm009Quad = { failure_class: 'unknown', severity: 'medium', transience: 'unknown', domain: 'unknown' }

/** One ATM-009 fuzz case: an input plus the exact quadruple classifyFailure(input) must produce. */
type Atm009Case = { input: unknown; expected: Atm009Quad }

/**
 * Builds exactly 50 programmatically-generated cases covering EVERY
 * recognized RawFailureSignal source (Codex round-2 fold, Finding 1):
 * missing/wrong-type REQUIRED fields (verify_check.checkResultId,
 * watchdog_fault.faultType, verify_idle_count.idle_count,
 * watchdog_blocked.blocked_on, adversarial_finding.category/severityHint),
 * null/undefined/primitive/array top-level signals, nested-object garbage,
 * and objects with a circular reference (one AS the signal itself, one
 * embedded as a `raw_signal`-named field, one nested inside).
 *
 * Each case pins the EXACT expected quadruple:
 *  - Cases with a malformed/missing REQUIRED discriminating field (or an
 *    unrecognized `source` altogether) expect the FULL row-16 unknown
 *    quadruple {unknown, medium, unknown, unknown} — this is
 *    ATM009_UNKNOWN_QUAD.
 *  - Sources with NO required discriminating field (test_run,
 *    watchdog_dead_session, escalation_bridge_all_paths_failed) always map
 *    to their REAL class regardless of which optional context fields are
 *    present/malformed — these cases expect that real quadruple, never the
 *    fallback.
 *  - A valid-but-unrecognized-STRING adversarial_finding category (both
 *    category and severityHint correctly typed as strings) is row 15:
 *    failure_class 'unknown' but with hint-mapped severity / permanent /
 *    system — NOT the full fallback quadruple. This is the one case where
 *    failure_class alone would be misleading, which is exactly why this
 *    fuzz asserts the full quadruple per case, not just failure_class.
 */
function buildAtm009Cases(): Atm009Case[] {
  const cases: Atm009Case[] = []
  const full = (input: unknown): void => { cases.push({ input, expected: ATM009_UNKNOWN_QUAD }) }
  const real = (input: unknown, expected: Atm009Quad): void => { cases.push({ input, expected }) }

  // Top-level non-object / nullish / primitive signals (9) — no recognizable
  // `source` at all -> full unknown quadruple.
  full(null)
  full(undefined)
  full(42)
  full('just a string')
  full(true)
  full(false)
  full([])
  full([1, 2, 3])
  full({})

  // Missing / wrong-type `source` (6) -> full unknown quadruple.
  full({ source: undefined })
  full({ source: null })
  full({ source: 123 })
  full({ source: {} })
  full({ source: [] })
  full({ source: true })

  // verify_check with malformed/missing checkResultId (3) — REQUIRED field
  // malformed -> full unknown quadruple (Finding 1 fix: previously this
  // source mapped unconditionally, ignoring checkResultId entirely).
  full({ source: 'verify_check' })
  full({ source: 'verify_check', checkResultId: 123 })
  full({ source: 'verify_check', checkResultId: null })

  // test_run (2) — NO required discriminating field beyond `source` itself;
  // always maps to its real class (row 2) regardless of malformed optional
  // context fields.
  real({ source: 'test_run' }, { failure_class: 'test_failure', severity: 'high', transience: 'transient', domain: 'agent' })
  real({ source: 'test_run', task_id: 'not-a-number', agent: 42, summary: null },
    { failure_class: 'test_failure', severity: 'high', transience: 'transient', domain: 'agent' })

  // watchdog_fault with malformed/unrecognized faultType (4) -> full unknown
  // quadruple (pre-existing, unchanged else-branch behavior — KEPT).
  full({ source: 'watchdog_fault' })
  full({ source: 'watchdog_fault', faultType: 123 })
  full({ source: 'watchdog_fault', faultType: null })
  full({ source: 'watchdog_fault', faultType: 'segfault' })

  // verify_idle_count with malformed/below-threshold idle_count (5) -> full
  // unknown quadruple (pre-existing, unchanged else-branch behavior — KEPT).
  full({ source: 'verify_idle_count' })
  full({ source: 'verify_idle_count', idle_count: 'three' })
  full({ source: 'verify_idle_count', idle_count: -1 })
  full({ source: 'verify_idle_count', idle_count: Number.NaN })
  full({ source: 'verify_idle_count', idle_count: null })

  // watchdog_blocked with missing/wrong-type/unrecognized-string blocked_on
  // (3) — REQUIRED field malformed -> full unknown quadruple (Finding 1
  // fix). blocked_on: null is deliberately NOT included here — it is the
  // explicit row-10 legacy value, not malformed (see ATM-006 row 10 /
  // ATM-013 blockedCases, which cover it as a real-mapping case elsewhere).
  full({ source: 'watchdog_blocked' })
  full({ source: 'watchdog_blocked', blocked_on: 'bogus' })
  full({ source: 'watchdog_blocked', blocked_on: 123 })

  // watchdog_dead_session (2) — NO required discriminating field; always
  // maps to its real class (row 11) regardless of malformed optional context
  // fields.
  real({ source: 'watchdog_dead_session' }, { failure_class: 'liveness_timeout', severity: 'critical', transience: 'permanent', domain: 'agent' })
  real({ source: 'watchdog_dead_session', task_id: 'nope', agent: {}, summary: 42 },
    { failure_class: 'liveness_timeout', severity: 'critical', transience: 'permanent', domain: 'agent' })

  // escalation_bridge_all_paths_failed (2) — NO required discriminating
  // field; always maps to its real class (row 12) regardless of malformed
  // optional context fields.
  real({ source: 'escalation_bridge_all_paths_failed' },
    { failure_class: 'infrastructure_transient', severity: 'critical', transience: 'transient', domain: 'infrastructure' })
  real({ source: 'escalation_bridge_all_paths_failed', agent: 42, summary: null, source_ref: {} },
    { failure_class: 'infrastructure_transient', severity: 'critical', transience: 'transient', domain: 'infrastructure' })

  // adversarial_finding with malformed/missing category OR severityHint (4)
  // — BOTH are required strings -> full unknown quadruple (Finding 1 fix:
  // previously a missing/wrong-type category still produced a partial
  // hint-mapped-severity/permanent/system quad instead of the full
  // fallback).
  full({ source: 'adversarial_finding' })
  full({ source: 'adversarial_finding', category: 123 })
  full({ source: 'adversarial_finding', category: 'made_up_category' }) // severityHint missing
  full({ source: 'adversarial_finding', category: null, severityHint: 999 })

  // adversarial_finding with a valid-but-unrecognized STRING category (both
  // required fields correctly typed) — row 15: unknown CLASS but NOT the
  // full fallback quad (severity is hint-mapped, transience/domain are
  // permanent/system, not medium/unknown/unknown).
  real({ source: 'adversarial_finding', category: 'totally_unrecognized', severityHint: 'HIGH' },
    { failure_class: 'unknown', severity: 'high', transience: 'permanent', domain: 'system' })

  // manual with malformed fields — this IS the fallback rule itself, so
  // always full unknown quadruple regardless of shape (3).
  full({ source: 'manual' })
  full({ source: 'manual', task_id: 'nope', agent: 42, summary: {} })
  full({ source: 'manual', task_id: null, agent: null, summary: null })

  // Nested-object garbage with unrecognized sources (3) -> full unknown
  // quadruple.
  for (let i = 0; i < 3; i++) {
    full({
      source: `garbage_source_${i}`,
      nested: { a: { b: { c: [i, 'x', null, undefined] } } },
      task_id: i % 2 === 0 ? `id-${i}` : i,
      agent: i,
      summary: i % 3 === 0 ? null : { weird: true },
      extra: new Array(3).fill({ deep: { deeper: 'x' } }),
    })
  }

  // Circular references (3): AS the signal itself, embedded as a
  // `raw_signal`-named field, and nested one level deep. All unrecognized
  // sources -> full unknown quadruple.
  const circAsSignal: Record<string, unknown> = { source: 'circular_as_signal_source' }
  circAsSignal.self = circAsSignal
  full(circAsSignal)

  const circViaField: Record<string, unknown> = { source: 'circular_via_field_source' }
  circViaField.raw_signal = circViaField
  full(circViaField)

  const circNested: Record<string, unknown> = { source: 'manual' }
  circNested.nested = { parent: circNested }
  full(circNested)

  return cases
}

describe('ATM-009: never-throw fuzz — 50 cases (malformed-required-field + no-required-field sanity), incl. circular refs', () => {
  test('ATM-009: exactly 50 cases are generated', () => {
    expect(buildAtm009Cases().length).toBe(50)
  })

  test('ATM-009: all 50 cases classify to their exact expected quadruple (full unknown fallback for malformed-required-field inputs, real class for no-required-field sources) with zero exceptions', () => {
    const cases = buildAtm009Cases()
    let thrown = 0
    const thrownDetails: string[] = []
    const mismatches: { index: number; expected: Atm009Quad; actual: Atm009Quad }[] = []

    cases.forEach(({ input, expected }, index) => {
      try {
        const result = classifyFailure(input as any)
        expect(typeof result).toBe('object')
        expect(result).not.toBeNull()
        const actual: Atm009Quad = {
          failure_class: result.failure_class,
          severity: result.severity,
          transience: result.transience,
          domain: result.domain,
        }
        if (
          actual.failure_class !== expected.failure_class
          || actual.severity !== expected.severity
          || actual.transience !== expected.transience
          || actual.domain !== expected.domain
        ) {
          mismatches.push({ index, expected, actual })
        }
      } catch (err) {
        thrown++
        thrownDetails.push(`index ${index}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    expect(thrownDetails).toEqual([])
    expect(thrown).toBe(0)
    expect(mismatches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// EPIC-04 (Stage 3): durable, append-only persistence
// ---------------------------------------------------------------------------
// Covers ATM-019 (table + 3 indexes in migrate()), ATM-027 (feature-flag
// seed, formally EPIC-06 but seeded/tested here since it lives in migrate()),
// ATM-020 (persistFailureClassification()), ATM-021 (flag gate), ATM-022
// (append-only static scan), ATM-023 (build-order independence from P5), and
// ATM-030 (audit atomicity, two-direction fault injection). See
// verification/failure-classification.ts and db.ts for the implementation.

/** Builds a FailureClassification literal with sane defaults, override-able per test. */
function makeFailureClassification(overrides: Partial<FailureClassification> = {}): FailureClassification {
  return {
    failure_class: 'verification_failure',
    severity: 'medium',
    transience: 'transient',
    domain: 'agent',
    taxonomy_version: TAXONOMY_VERSION,
    signal_source: 'verify_check',
    source_ref: 'chk-1',
    task_id: null,
    agent: 'boss',
    summary: 'a test classification',
    raw_signal: { source: 'verify_check', checkResultId: 'chk-1' },
    ...overrides,
  }
}

/** Removes a sqlite db file plus its -shm/-wal sidecars, tolerating "doesn't exist". */
function wipeDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch { /* doesn't exist yet */ }
  }
}

// ---------------------------------------------------------------------------
// ATM-019 / REQ-009 [P1] — failure_classifications table + 3 indexes
// ---------------------------------------------------------------------------
describe('ATM-019: failure_classifications table + indexes (REQ-009)', () => {
  const TEST_DB = '/tmp/p6-persist-atm019.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-019: failure_classifications has exactly the documented columns, and NO classified_at column', () => {
    const columns = taskDb.run(db => db.prepare("PRAGMA table_info('failure_classifications')").all()) as { name: string }[]
    const columnNames = columns.map(c => c.name).sort()
    expect(columnNames).toEqual(
      [
        'id',
        'taxonomy_version',
        'failure_class',
        'severity',
        'transience',
        'domain',
        'signal_source',
        'source_ref',
        'task_id',
        'agent',
        'summary',
        'raw_signal_json',
        'created_at',
      ].sort()
    )
    expect(columnNames).not.toContain('classified_at')
  })

  test('ATM-019: 3 indexes exist covering task_id, failure_class, and created_at', () => {
    const indexes = taskDb.run(db => db.prepare("PRAGMA index_list('failure_classifications')").all()) as { name: string }[]
    expect(indexes.length).toBeGreaterThanOrEqual(3)

    const coveredColumns = new Set<string>()
    for (const idx of indexes) {
      const infoRows = taskDb.run(db => db.prepare(`PRAGMA index_info('${idx.name}')`).all()) as { name: string }[]
      for (const row of infoRows) coveredColumns.add(row.name)
    }
    expect(coveredColumns.has('task_id')).toBe(true)
    expect(coveredColumns.has('failure_class')).toBe(true)
    expect(coveredColumns.has('created_at')).toBe(true)
  })

  test('ATM-019: re-running migrate() (fresh TaskDB against the same file) is idempotent — no error, same schema', () => {
    expect(() => new TaskDB(TEST_DB)).not.toThrow()
    const columns = taskDb.run(db => db.prepare("PRAGMA table_info('failure_classifications')").all()) as { name: string }[]
    expect(columns.length).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// ATM-027 / REQ-015 [P1] — failure_classification_enabled flag seed
// ---------------------------------------------------------------------------
describe('ATM-027: failure_classification_enabled flag seed (REQ-015)', () => {
  const TEST_DB = '/tmp/p6-persist-atm027.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-027: fresh migrate() seeds failure_classification_enabled=0, read via isFeatureEnabled()', () => {
    expect(taskDb.isFeatureEnabled('failure_classification_enabled')).toBe(false)
    const row = taskDb.run(db => db.prepare(
      "SELECT enabled FROM feature_flags WHERE flag_name = 'failure_classification_enabled'"
    ).get()) as { enabled: number } | null
    expect(row).not.toBeNull()
    expect(row!.enabled).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-020 / REQ-009 [P1] — persistFailureClassification()
// ---------------------------------------------------------------------------
describe('ATM-020: persistFailureClassification() (REQ-009)', () => {
  const TEST_DB = '/tmp/p6-persist-atm020.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-020: 3 sequential persists (flag ON) -> 3 rows, strictly increasing ids, created_at populated, every field round-trips incl. raw_signal_json', () => {
    taskDb.setFeatureFlag('failure_classification_enabled', true)

    const inputs: FailureClassification[] = [
      makeFailureClassification({ summary: 'first', raw_signal: { source: 'verify_check', checkResultId: 'a' } }),
      makeFailureClassification({
        summary: 'second',
        task_id: 42,
        agent: 'steve',
        failure_class: 'test_failure',
        signal_source: 'test_run',
        raw_signal: { source: 'test_run', nested: { x: 1, y: [1, 2, 3] } },
      }),
      makeFailureClassification({ summary: 'third', source_ref: null, task_id: null, agent: null, raw_signal: null }),
    ]

    const ids: number[] = []
    for (const input of inputs) {
      const id = taskDb.run(db => persistFailureClassification(db, input))
      expect(id).not.toBeNull()
      ids.push(id as number)
    }

    expect(ids[1]).toBeGreaterThan(ids[0])
    expect(ids[2]).toBeGreaterThan(ids[1])

    const rows = taskDb.run(db => db.prepare('SELECT * FROM failure_classifications ORDER BY id ASC').all()) as any[]
    expect(rows.length).toBe(3)

    rows.forEach((row, i) => {
      const input = inputs[i]
      expect(row.id).toBe(ids[i])
      expect(typeof row.created_at).toBe('string')
      expect(row.created_at.length).toBeGreaterThan(0)
      expect(row.taxonomy_version).toBe(input.taxonomy_version)
      expect(row.failure_class).toBe(input.failure_class)
      expect(row.severity).toBe(input.severity)
      expect(row.transience).toBe(input.transience)
      expect(row.domain).toBe(input.domain)
      expect(row.signal_source).toBe(input.signal_source)
      expect(row.source_ref).toBe(input.source_ref)
      expect(row.task_id).toBe(input.task_id)
      expect(row.agent).toBe(input.agent)
      expect(row.summary).toBe(input.summary)
      expect(JSON.parse(row.raw_signal_json)).toEqual(input.raw_signal)
    })
  })

  test('ATM-020: source-level — persistFailureClassification uses a LOCAL BEGIN IMMEDIATE, and the module imports no memory-ordering.ts symbol', () => {
    const modulePath = join(import.meta.dir, '..', 'verification', 'failure-classification.ts')
    const source = readFileSync(modulePath, 'utf8')

    const marker = 'export function persistFailureClassification'
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)

    const braceStart = source.indexOf('{', start)
    expect(braceStart).toBeGreaterThan(start)

    let depth = 0
    let end = -1
    for (let i = braceStart; i < source.length; i++) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end).toBeGreaterThan(braceStart)

    const body = source.slice(braceStart, end + 1)
    expect(body).toMatch(/BEGIN IMMEDIATE/)
    expect(body).toMatch(/COMMIT/)
    expect(body).toMatch(/ROLLBACK/)

    expect(source).not.toMatch(/from\s+['"]\.{1,2}\/memory-ordering['"]/)
    expect(source).not.toMatch(/\bwithMemoryWriteTxn\b/)
    expect(source).not.toMatch(/\bnextWriteSeq\b/)
  })
})

// ---------------------------------------------------------------------------
// ATM-021 / REQ-010 [P1] — flag gate
// ---------------------------------------------------------------------------
describe('ATM-021: flag gate (REQ-010)', () => {
  const TEST_DB = '/tmp/p6-persist-atm021.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-021: flag OFF (default) -> persist returns null, row count stays 0', () => {
    const id = taskDb.run(db => persistFailureClassification(db, makeFailureClassification()))
    expect(id).toBeNull()
    const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number }).n)
    expect(count).toBe(0)
  })

  test('ATM-021: flag ON -> row inserted, non-null numeric id returned', () => {
    taskDb.setFeatureFlag('failure_classification_enabled', true)
    const id = taskDb.run(db => persistFailureClassification(db, makeFailureClassification()))
    expect(id).not.toBeNull()
    expect(typeof id).toBe('number')
    const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number }).n)
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ATM-022 / REQ-011 [P2] — append-only, no UPDATE/DELETE
// ---------------------------------------------------------------------------
describe('ATM-022: append-only — no UPDATE/DELETE against failure_classifications (REQ-011)', () => {
  test('ATM-022: neither UPDATE nor DELETE targeting failure_classifications appears in failure-classification.ts or db.ts', () => {
    const fcPath = join(import.meta.dir, '..', 'verification', 'failure-classification.ts')
    const dbPath = join(import.meta.dir, '..', 'db.ts')
    const fcSource = readFileSync(fcPath, 'utf8')
    const dbSource = readFileSync(dbPath, 'utf8')

    const updateRe = /UPDATE\s+failure_classifications/i
    const deleteRe = /DELETE\s+FROM\s+failure_classifications/i

    expect(updateRe.test(fcSource)).toBe(false)
    expect(deleteRe.test(fcSource)).toBe(false)
    expect(updateRe.test(dbSource)).toBe(false)
    expect(deleteRe.test(dbSource)).toBe(false)
  })

  // Codex round-2 fold (Finding 4 / REQ-011): the scan above only covers
  // verification/failure-classification.ts + db.ts. A mutation could just as
  // easily be added to watchdog.ts, verify.ts, or any other P6-touched file
  // and slip past that narrow scan. ATM-022's REQ-011 text requires scanning
  // the entire changed diff / import graph — this test does that: it walks
  // EVERY file in the P6 changed-file set (git diff --name-only vs the base
  // commit), not just the two known-safe files.
  test('ATM-022: neither UPDATE nor DELETE targeting failure_classifications appears anywhere in the full P6 changed-file set', () => {
    const REPO = join(import.meta.dir, '..')
    const BASE_COMMIT = '5014d7f'

    let proc: ReturnType<typeof Bun.spawnSync>
    try {
      proc = Bun.spawnSync(['git', '-C', REPO, 'diff', '--name-only', BASE_COMMIT], { cwd: REPO })
    } catch (err) {
      throw new Error(`ATM-022: git is unavailable — cannot verify the full-diff append-only scan: ${err}`)
    }
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr?.toString() ?? '(no stderr)'
      throw new Error(
        `ATM-022: 'git diff --name-only ${BASE_COMMIT}' exited ${proc.exitCode} — cannot verify the full-diff ` +
        `append-only scan. stderr: ${stderr}`,
      )
    }
    const out = (proc.stdout ?? Buffer.alloc(0)).toString().trim()
    const changedFiles = out.length === 0 ? [] : out.split('\n')

    // Sanity precondition: the diff must be non-trivial, otherwise a git
    // misconfig returning [] would make this test pass for the wrong reason.
    expect(changedFiles.length).toBeGreaterThan(0)

    const updateRe = /UPDATE\s+failure_classifications/i
    const deleteRe = /DELETE\s+FROM\s+failure_classifications/i

    const offenders: { file: string; line: number; text: string }[] = []
    for (const relPath of changedFiles) {
      let content: string
      try {
        content = readFileSync(join(REPO, relPath), 'utf8')
      } catch {
        continue // deleted / binary / unreadable file — filter to existing readable source files
      }
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        if (updateRe.test(line) || deleteRe.test(line)) {
          offenders.push({ file: relPath, line: idx + 1, text: line.trim() })
        }
      })
    }

    if (offenders.length > 0) {
      throw new Error(
        `ATM-022 violation: found an UPDATE/DELETE statement targeting failure_classifications outside the ` +
        `verification/failure-classification.ts + db.ts scan above:\n` +
        offenders.map(o => `  ${o.file}:${o.line} — ${o.text}`).join('\n'),
      )
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATM-023 / REQ-012 [P2] — build-order independence (zero P5 coupling)
// ---------------------------------------------------------------------------
describe('ATM-023: build-order independence — zero P5 coupling (REQ-012)', () => {
  const TEST_DB = '/tmp/p6-persist-atm023.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-023(a): failure-classification.ts source has zero references to memory-ordering.ts, withMemoryWriteTxn, or nextWriteSeq', () => {
    const fcPath = join(import.meta.dir, '..', 'verification', 'failure-classification.ts')
    const source = readFileSync(fcPath, 'utf8')
    expect(source).not.toMatch(/memory-ordering/)
    expect(source).not.toMatch(/\bwithMemoryWriteTxn\b/)
    expect(source).not.toMatch(/\bnextWriteSeq\b/)
  })

  test('ATM-023(b): persistFailureClassification succeeds against a fresh migrated temp DB with zero dependence on memory-ordering.ts (atomicity comes from the LOCAL BEGIN IMMEDIATE proven in ATM-020, not any P5 symbol — see ATM-023(a))', () => {
    taskDb.setFeatureFlag('failure_classification_enabled', true)
    const id = taskDb.run(db => persistFailureClassification(db, makeFailureClassification()))
    expect(id).not.toBeNull()
    expect(typeof id).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// ATM-030 / REQ-018 [P2] — audit atomicity, two-direction fault injection
// ---------------------------------------------------------------------------
describe('ATM-030: audit atomicity, two-direction fault injection (REQ-018)', () => {
  const TEST_DB = '/tmp/p6-persist-atm030.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('failure_classification_enabled', true)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-030(a) happy path: persisting a classification produces exactly ONE audit_log row with action=failure_classified, detail containing failure_class/task_id/agent', () => {
    const input = makeFailureClassification({ task_id: 77, agent: 'sadie', failure_class: 'test_failure' })
    const id = taskDb.run(db => persistFailureClassification(db, input))
    expect(id).not.toBeNull()

    const auditRows = taskDb.run(db => db.prepare(
      "SELECT * FROM audit_log WHERE action = 'failure_classified'"
    ).all()) as any[]
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].task_id).toBe(77)

    const detail = JSON.parse(auditRows[0].detail)
    expect(detail.failure_class).toBe('test_failure')
    expect(detail.task_id).toBe(77)
    expect(detail.agent).toBe('sadie')
  })

  test('ATM-030(b) fault-injection (audit direction): forcing the AUDIT insert to throw (audit_log renamed away) rolls back the classification row too — 0 rows, persist rethrows', () => {
    taskDb.run(db => db.exec('ALTER TABLE audit_log RENAME TO audit_log_atm030_bak'))
    try {
      let threw = false
      let thrownErr: unknown = null
      try {
        taskDb.run(db => persistFailureClassification(db, makeFailureClassification()))
      } catch (err) {
        threw = true
        thrownErr = err
      }
      expect(threw).toBe(true)
      expect(thrownErr).not.toBeNull()

      const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number }).n)
      expect(count).toBe(0)
    } finally {
      taskDb.run(db => db.exec('ALTER TABLE audit_log_atm030_bak RENAME TO audit_log'))
    }
  })

  test('ATM-030(c) fault-injection (classification direction): forcing the CLASSIFICATION insert to throw (failure_classifications renamed away) leaves NO audit_log row with action=failure_classified', () => {
    taskDb.run(db => db.exec('ALTER TABLE failure_classifications RENAME TO failure_classifications_atm030_bak'))
    try {
      let threw = false
      try {
        taskDb.run(db => persistFailureClassification(db, makeFailureClassification()))
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    } finally {
      taskDb.run(db => db.exec('ALTER TABLE failure_classifications_atm030_bak RENAME TO failure_classifications'))
    }

    const auditRows = taskDb.run(db => db.prepare(
      "SELECT * FROM audit_log WHERE action = 'failure_classified'"
    ).all()) as any[]
    expect(auditRows.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EPIC-05 (Stage 4): the P7/P8 read accessor
// ---------------------------------------------------------------------------
// Covers ATM-024 (getFailureClassifications() filters + ordering + shape),
// ATM-025 (scope guard: no reward computation, no cross-family critique
// construction in this module), and ATM-026 (forward-compat pass-through for
// rows bearing an unknown failure_class / newer taxonomy_version).

/**
 * Inserts a failure_classifications row DIRECTLY (bypassing
 * persistFailureClassification / the feature flag) with a caller-controlled
 * `created_at`, so `since` filtering can be tested deterministically despite
 * the column's 1-second DEFAULT datetime('now') resolution.
 */
function insertClassificationRow(
  db: Database,
  opts: {
    taskId: number | null
    agent: string | null
    failureClass: string
    createdAt: string
    taxonomyVersion?: number
    severity?: string
    transience?: string
    domain?: string
    signalSource?: string
    sourceRef?: string | null
    summary?: string
    rawSignalJson?: string | null
  },
): number {
  const row = db
    .prepare(`
      INSERT INTO failure_classifications (
        taxonomy_version, failure_class, severity, transience, domain,
        signal_source, source_ref, task_id, agent, summary, raw_signal_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `)
    .get(
      opts.taxonomyVersion ?? TAXONOMY_VERSION,
      opts.failureClass,
      opts.severity ?? 'medium',
      opts.transience ?? 'transient',
      opts.domain ?? 'agent',
      opts.signalSource ?? 'manual',
      opts.sourceRef ?? null,
      opts.taskId,
      opts.agent,
      opts.summary ?? 'seed row',
      opts.rawSignalJson ?? null,
      opts.createdAt,
    ) as { id: number }
  return row.id
}

// ---------------------------------------------------------------------------
// ATM-024 / REQ-013 [P1] — getFailureClassifications() read accessor
// ---------------------------------------------------------------------------
describe('ATM-024: getFailureClassifications() — filters, ordering, shape (REQ-013)', () => {
  const TEST_DB = '/tmp/p6-persist-atm024.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  /**
   * 5 rows, directly inserted with controlled distinct created_at values (so
   * the `since` sub-test is deterministic), spanning 2 task_ids, 2 agents,
   * and 3 failure_classes:
   *   A: task_id=1 agent=boss  failure_class=verification_failure created_at=2026-01-01
   *   B: task_id=1 agent=steve failure_class=test_failure         created_at=2026-01-02
   *   C: task_id=2 agent=boss  failure_class=liveness_timeout     created_at=2026-01-03
   *   D: task_id=2 agent=steve failure_class=verification_failure created_at=2026-01-04
   *   E: task_id=1 agent=boss  failure_class=test_failure         created_at=2026-01-05
   * Inserted in id order A,B,C,D,E (ascending id === insertion order).
   */
  function seedFiveRows(db: Database): Record<'A' | 'B' | 'C' | 'D' | 'E', number> {
    const A = insertClassificationRow(db, {
      taskId: 1, agent: 'boss', failureClass: 'verification_failure', createdAt: '2026-01-01 00:00:00',
      rawSignalJson: JSON.stringify({ source: 'verify_check', checkResultId: 'chk-a' }),
    })
    const B = insertClassificationRow(db, {
      taskId: 1, agent: 'steve', failureClass: 'test_failure', createdAt: '2026-01-02 00:00:00',
    })
    const C = insertClassificationRow(db, {
      taskId: 2, agent: 'boss', failureClass: 'liveness_timeout', createdAt: '2026-01-03 00:00:00',
    })
    const D = insertClassificationRow(db, {
      taskId: 2, agent: 'steve', failureClass: 'verification_failure', createdAt: '2026-01-04 00:00:00',
      rawSignalJson: null,
    })
    const E = insertClassificationRow(db, {
      taskId: 1, agent: 'boss', failureClass: 'test_failure', createdAt: '2026-01-05 00:00:00',
    })
    return { A, B, C, D, E }
  }

  test('ATM-024: no-filter call returns all 5 rows in ascending id order, each with a numeric id and non-null created_at', () => {
    const ids = taskDb.run(db => seedFiveRows(db))
    const results = taskDb.run(db => getFailureClassifications(db))

    expect(results.length).toBe(5)
    expect(results.map(r => r.id)).toEqual([ids.A, ids.B, ids.C, ids.D, ids.E])
    for (const r of results) {
      expect(typeof r.id).toBe('number')
      expect(r.created_at).not.toBeNull()
      expect(typeof r.created_at).toBe('string')
      expect(r.created_at.length).toBeGreaterThan(0)
    }
  })

  test('ATM-024: filter by taskId returns exactly the matching subset in ascending id order', () => {
    const ids = taskDb.run(db => seedFiveRows(db))
    const results = taskDb.run(db => getFailureClassifications(db, { taskId: 1 }))
    expect(results.map(r => r.id)).toEqual([ids.A, ids.B, ids.E])
    for (const r of results) expect(r.task_id).toBe(1)
  })

  test('ATM-024: filter by agent returns exactly the matching subset in ascending id order', () => {
    const ids = taskDb.run(db => seedFiveRows(db))
    const results = taskDb.run(db => getFailureClassifications(db, { agent: 'steve' }))
    expect(results.map(r => r.id)).toEqual([ids.B, ids.D])
    for (const r of results) expect(r.agent).toBe('steve')
  })

  test('ATM-024: filter by failureClass returns exactly the matching subset in ascending id order', () => {
    const ids = taskDb.run(db => seedFiveRows(db))
    const results = taskDb.run(db => getFailureClassifications(db, { failureClass: 'verification_failure' }))
    expect(results.map(r => r.id)).toEqual([ids.A, ids.D])
    for (const r of results) expect(r.failure_class).toBe('verification_failure')
  })

  test('ATM-024: filter by since (inclusive) returns exactly the matching subset in ascending id order', () => {
    const ids = taskDb.run(db => seedFiveRows(db))
    const results = taskDb.run(db => getFailureClassifications(db, { since: '2026-01-03 00:00:00' }))
    expect(results.map(r => r.id)).toEqual([ids.C, ids.D, ids.E])
    for (const r of results) expect(r.created_at >= '2026-01-03 00:00:00').toBe(true)
  })

  test('ATM-024: raw_signal is parsed defensively from raw_signal_json (valid JSON -> object, null -> null)', () => {
    const ids = taskDb.run(db => seedFiveRows(db))
    const results = taskDb.run(db => getFailureClassifications(db))
    const rowA = results.find(r => r.id === ids.A)!
    const rowD = results.find(r => r.id === ids.D)!
    expect(rowA.raw_signal).toEqual({ source: 'verify_check', checkResultId: 'chk-a' })
    expect(rowD.raw_signal).toBeNull()
  })

  test('ATM-024: malformed raw_signal_json parses defensively to null without throwing', () => {
    taskDb.run(db => insertClassificationRow(db, {
      taskId: 9, agent: 'kiera', failureClass: 'unknown', createdAt: '2026-01-06 00:00:00',
      rawSignalJson: '{not valid json',
    }))
    let results: PersistedFailureClassification[] = []
    expect(() => {
      results = taskDb.run(db => getFailureClassifications(db, { taskId: 9 }))
    }).not.toThrow()
    expect(results.length).toBe(1)
    expect(results[0]!.raw_signal).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ATM-025 / REQ-013 [P1] — scope guard: no reward, no cross-family critique
// ---------------------------------------------------------------------------
describe('ATM-025: scope guard — no reward computation, no cross-family critique construction (REQ-013)', () => {
  test('ATM-025: failure-classification.ts source contains no reward-valued code and no cross-family critique construction', () => {
    const modulePath = join(import.meta.dir, '..', 'verification', 'failure-classification.ts')
    const source = readFileSync(modulePath, 'utf8')

    // (a) No reward-valued code anywhere in this module.
    expect(source).not.toMatch(/reward/i)

    // (b) No reference to critique CONSTRUCTION. The module has one
    // pre-existing, type-only `CritiqueSeverity` import (ATM-004's
    // decision.ts distinctness guardrail) which is unrelated to building a
    // critique across multiple classifications — strip that single known
    // identifier out before scanning so it doesn't false-positive this
    // check, then assert zero remaining occurrences of the word.
    const withoutKnownTypeImport = source.replace(/CritiqueSeverity/g, '')
    expect(withoutKnownTypeImport).not.toMatch(/critique/i)
  })
})

// ---------------------------------------------------------------------------
// ATM-026 / REQ-014 [P2] — forward-compat read pass-through
// ---------------------------------------------------------------------------
describe('ATM-026: forward-compat read pass-through — unknown failure_class + newer taxonomy_version (REQ-014)', () => {
  const TEST_DB = '/tmp/p6-persist-atm026.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-026: a row with an unrecognized failure_class and taxonomy_version=999 is returned unchanged, no throw', () => {
    const id = taskDb.run(db => insertClassificationRow(db, {
      taskId: 55,
      agent: 'sadie',
      failureClass: 'future_class_v2',
      createdAt: '2026-02-01 00:00:00',
      taxonomyVersion: 999,
    }))

    let results: PersistedFailureClassification[] = []
    expect(() => {
      results = taskDb.run(db => getFailureClassifications(db, { taskId: 55 }))
    }).not.toThrow()

    expect(results.length).toBe(1)
    const row = results[0]!
    expect(row.id).toBe(id)
    expect(row.failure_class).toBe('future_class_v2')
    expect(row.taxonomy_version).toBe(999)
  })
})

// ---------------------------------------------------------------------------
// EPIC-03 (Stage 5): pure signal adapters (ATM-010/013/018)
// ---------------------------------------------------------------------------
// Covers ATM-010 (verify.ts adapters: fromVerifyCheckResult / fromTestRun /
// fromIdleCount, incl. the SG-13 dedup exclusion — Codex #5), ATM-013
// (watchdog.ts adapters: fromWatchdogFault / fromWatchdogBlocked /
// fromWatchdogDeadSession, all 5 blocked_on cases), and ATM-018
// (fromAdversarialFinding — standalone, no production call site wired in
// this stage). Live-file wiring + integration coverage for these adapters
// lives in the sibling *-verify-integration.test.ts,
// *-watchdog-integration.test.ts, and *-escalation-integration.test.ts files.

describe('ATM-010: verify.ts adapters — fromVerifyCheckResult / fromTestRun / fromIdleCount', () => {
  test('ATM-010: a failing non-SG-13 CheckResult maps to a verify_check signal -> classifyFailure -> verification_failure', () => {
    const check = { id: 'SG-1', description: 'x', verified: false, evidence: 'missing', checked_at: 'now' }
    const sig = fromVerifyCheckResult(check)
    expect(sig).not.toBeNull()
    expect(sig!.source).toBe('verify_check')
    expect((sig as any).checkResultId).toBe('SG-1')
    const result = classifyFailure(sig!)
    expect(result.failure_class).toBe('verification_failure')
  })

  test('ATM-010: a tests_pass:false Summary maps to a test_run signal -> classifyFailure -> test_failure', () => {
    const summary = { tests_pass: false, test_output: 'boom', idle_count: 0 }
    const sig = fromTestRun(summary)
    expect(sig).not.toBeNull()
    expect(sig!.source).toBe('test_run')
    const result = classifyFailure(sig!)
    expect(result.failure_class).toBe('test_failure')
  })

  test('ATM-010: an idle_count:5 Summary maps to a verify_idle_count signal -> classifyFailure -> resource_budget_exhaustion', () => {
    const summary = { idle_count: 5 }
    const sig = fromIdleCount(summary)
    expect(sig).not.toBeNull()
    expect(sig!.source).toBe('verify_idle_count')
    const result = classifyFailure(sig!)
    expect(result.failure_class).toBe('resource_budget_exhaustion')
  })

  test('ATM-010: a FAILING SG-13 CheckResult -> fromVerifyCheckResult returns null (never double-classified)', () => {
    const check = { id: 'SG-13', description: 'All tests pass', verified: false, evidence: 'Tests failing', checked_at: 'now' }
    expect(fromVerifyCheckResult(check)).toBeNull()
  })

  test('ATM-010: a PASSING check (verified: true) -> fromVerifyCheckResult returns null', () => {
    const check = { id: 'SG-2', description: 'x', verified: true, evidence: 'ok', checked_at: 'now' }
    expect(fromVerifyCheckResult(check)).toBeNull()
  })

  test('ATM-010: a tests_pass:true Summary -> fromTestRun returns null', () => {
    expect(fromTestRun({ tests_pass: true })).toBeNull()
  })

  test('ATM-010: an idle_count below threshold -> fromIdleCount returns null', () => {
    expect(fromIdleCount({ idle_count: IDLE_COUNT_STAGNATION_THRESHOLD - 1 })).toBeNull()
  })
})

describe('ATM-013: watchdog.ts adapters — fromWatchdogFault / fromWatchdogBlocked / fromWatchdogDeadSession', () => {
  test('ATM-013: fromWatchdogFault crash -> classifyFailure -> liveness_timeout/critical', () => {
    const sig = fromWatchdogFault('kiera', 'crash', { task_id: 1, agent: 'kiera' })
    const result = classifyFailure(sig)
    expect(result.failure_class).toBe('liveness_timeout')
    expect(result.severity).toBe('critical')
  })

  test('ATM-013: fromWatchdogFault timeout -> classifyFailure -> liveness_timeout/high', () => {
    const sig = fromWatchdogFault('sadie', 'timeout', { task_id: 2 })
    const result = classifyFailure(sig)
    expect(result.failure_class).toBe('liveness_timeout')
    expect(result.severity).toBe('high')
  })

  const blockedCases: { blockedOn: BlockedOn | null; expectedDomain: FailureDomain }[] = [
    { blockedOn: 'human', expectedDomain: 'human' },
    { blockedOn: 'external_api', expectedDomain: 'external_api' },
    { blockedOn: 'upstream_task', expectedDomain: 'upstream_task' },
    { blockedOn: 'agent', expectedDomain: 'agent' },
    { blockedOn: null, expectedDomain: 'unknown' },
  ]
  for (const { blockedOn, expectedDomain } of blockedCases) {
    test(`ATM-013: fromWatchdogBlocked(${blockedOn}) -> classifyFailure -> blocked_dependency/domain=${expectedDomain}`, () => {
      const sig = fromWatchdogBlocked(blockedOn, { task_id: 3, agent: 'boss' })
      const result = classifyFailure(sig)
      expect(result.failure_class).toBe('blocked_dependency')
      expect(result.domain).toBe(expectedDomain)
    })
  }

  test('ATM-013: fromWatchdogDeadSession -> classifyFailure -> liveness_timeout/critical/permanent', () => {
    const sig = fromWatchdogDeadSession({ task_id: 4, agent: 'steve' })
    const result = classifyFailure(sig)
    expect(result.failure_class).toBe('liveness_timeout')
    expect(result.severity).toBe('critical')
    expect(result.transience).toBe('permanent')
  })
})

describe('ATM-016-unit: fromEscalationBridgeAllPathsFailed (pure adapter half — integration lives in the escalation-integration file)', () => {
  test('ATM-016-unit: fromEscalationBridgeAllPathsFailed -> classifyFailure -> infrastructure_transient/critical', () => {
    const sig = fromEscalationBridgeAllPathsFailed('kiera', 1, 'MCP unavailable')
    const result = classifyFailure(sig)
    expect(result.failure_class).toBe('infrastructure_transient')
    expect(result.severity).toBe('critical')
    expect(result.agent).toBe('kiera')
  })
})

describe('ATM-018: fromAdversarialFinding (standalone, no production call site)', () => {
  test("ATM-018: fromAdversarialFinding('codex','correctness','HIGH',...) -> correctness_adversarial_finding/high", () => {
    const sig = fromAdversarialFinding('codex', 'correctness', 'HIGH', 'bug found')
    const result = classifyFailure(sig)
    expect(result.failure_class).toBe('correctness_adversarial_finding')
    expect(result.severity).toBe('high')
  })

  const contractScopeCategories = [
    'scope_conformance',
    'verifiability',
    'ears_conformance',
    'traceability',
    'classifier_rigor',
    'consumption_contract',
  ]
  for (const category of contractScopeCategories) {
    test(`ATM-018: fromAdversarialFinding(..., '${category}', ...) -> contract_scope_conformance`, () => {
      const sig = fromAdversarialFinding('codex', category, 'MEDIUM', 'x')
      const result = classifyFailure(sig)
      expect(result.failure_class).toBe('contract_scope_conformance')
    })
  }

  test("ATM-018: fromAdversarialFinding(..., 'zzz_unknown', ...) -> unknown", () => {
    const sig = fromAdversarialFinding('codex', 'zzz_unknown', 'HIGH', 'weird')
    const result = classifyFailure(sig)
    expect(result.failure_class).toBe('unknown')
  })

  test('ATM-018: fromAdversarialFinding never throws across a battery of malformed categories/hints', () => {
    const inputs = ['', 'CORRECTNESS', 'correctness ', 'made_up', 'SCOPE_CONFORMANCE']
    for (const category of inputs) {
      expect(() => classifyFailure(fromAdversarialFinding('codex', category, 'weird-hint', 'x'))).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// EPIC-06 (Stage 6): feature flag, flag-OFF parity, no-backfill discipline
// ---------------------------------------------------------------------------
// ATM-027 (flag seed default 0) is already covered above by the
// "ATM-027: fresh migrate() seeds failure_classification_enabled=0, read via
// isFeatureEnabled()" test in the ATM-019/ATM-027 persistence block (Stage 3)
// — see line ~778. Not duplicated here.
//
// ATM-028 consolidates the "flag OFF -> zero failure_classifications rows,
// everywhere" invariant across every wired call site. ATM-029 guards against
// any future migrate() backfill that would derive synthetic
// failure_classifications rows from pre-existing historical
// agent_sessions/tasks/audit_log data.

// ---------------------------------------------------------------------------
// ATM-028 / REQ-016 [P1] — flag-OFF parity across ALL wired call sites
// ---------------------------------------------------------------------------
describe('ATM-028: flag-OFF parity across ALL wired call sites (REQ-016)', () => {
  const TEST_DB = '/tmp/p6-persist-atm028.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    // Flag left at its migrate()-seeded default (OFF) for this whole describe block.
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-028: flag is OFF by construction (sanity precondition for the rest of this block)', () => {
    expect(taskDb.isFeatureEnabled('failure_classification_enabled')).toBe(false)
  })

  test('ATM-028: a direct persistFailureClassification(db, c) call with flag OFF returns null, row count stays 0', () => {
    const id = taskDb.run(db => persistFailureClassification(db, makeFailureClassification()))
    expect(id).toBeNull()
    const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number }).n)
    expect(count).toBe(0)
  })

  // Reference: the per-site flag-OFF BYTE-PARITY assertions — verify.ts's
  // summary.json output staying byte-identical, watchdog.ts's ESCALATION
  // string plus its agent_sessions/tasks mutations staying byte-identical,
  // and the escalation Telegram message staying byte-identical — are proven
  // in the Stage-5 integration suites:
  //   tests/failure-classification-watchdog-integration.test.ts
  //   tests/failure-classification-verify-integration.test.ts
  //   tests/failure-classification-escalation-integration.test.ts
  // This test is the CONSOLIDATED "0 rows across every wired site when OFF"
  // invariant: it drives the actual pure adapters wired at each of the 5
  // watchdog.ts sites (blocked, fault-crash x2, fault-timeout, dead-session)
  // plus the 3 verify.ts sites (verify_check, test_run, verify_idle_count)
  // through classifyFailure() -> persistFailureClassification(), exactly as
  // the live wiring does, and asserts the row count never leaves 0.
  test('ATM-028: driving every wired watchdog.ts + verify.ts adapter through classifyFailure -> persist with flag OFF yields 0 rows total', () => {
    const wiredSignals = [
      // watchdog.ts site 1 (line ~389): blocked_dependency
      fromWatchdogBlocked('human', { task_id: 100, agent: 'boss' }),
      // watchdog.ts site 2 (line ~588): fault crash (task-scoped)
      fromWatchdogFault('kiera', 'crash', { task_id: 101, agent: 'kiera' }),
      // watchdog.ts site 3 (line ~608): dead session
      fromWatchdogDeadSession({ task_id: 102, agent: 'steve' }),
      // watchdog.ts site 4 (line ~711): fault timeout
      fromWatchdogFault('sadie', 'timeout', { task_id: 103, agent: 'sadie' }),
      // watchdog.ts site 5 (line ~1017): fault crash (agent-only, no task_id)
      fromWatchdogFault('boss', 'crash', { agent: 'boss' }),
    ]

    for (const sig of wiredSignals) {
      const classification = classifyFailure(sig)
      const id = taskDb.run(db => persistFailureClassification(db, classification))
      expect(id).toBeNull()
    }

    // verify.ts's 3 sites — same fromX -> classifyFailure -> persist pattern,
    // using representative inputs that would otherwise yield a non-null signal.
    const verifyCheckInput = { id: 'SG-9', description: 'x', verified: false, evidence: 'missing' }
    const testRunInput = { tests_pass: false, test_output: 'boom' }
    const idleCountInput = { idle_count: IDLE_COUNT_STAGNATION_THRESHOLD }
    const verifyCheck = fromVerifyCheckResult(verifyCheckInput)
    const testRun = fromTestRun(testRunInput)
    const idleCount = fromIdleCount(idleCountInput)
    expect(verifyCheck).not.toBeNull()
    expect(testRun).not.toBeNull()
    expect(idleCount).not.toBeNull()

    for (const sig of [verifyCheck!, testRun!, idleCount!]) {
      const classification = classifyFailure(sig)
      const id = taskDb.run(db => persistFailureClassification(db, classification))
      expect(id).toBeNull()
    }

    const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number }).n)
    expect(count).toBe(0)
  })

  test('ATM-028: getFailureClassifications(db) returns [] after all flag-OFF operations above', () => {
    // Re-run a representative slice of the flag-OFF persist attempts against
    // this test's own taskDb instance (each test gets a fresh wiped DB via
    // beforeEach), then confirm the read accessor sees nothing.
    taskDb.run(db => persistFailureClassification(db, makeFailureClassification()))
    taskDb.run(db => persistFailureClassification(db, classifyFailure(fromWatchdogFault('kiera', 'crash', { task_id: 1, agent: 'kiera' }))))
    taskDb.run(db => persistFailureClassification(db, classifyFailure(fromWatchdogBlocked('human', { task_id: 2, agent: 'boss' }))))
    taskDb.run(db => persistFailureClassification(db, classifyFailure(fromWatchdogDeadSession({ task_id: 3, agent: 'steve' }))))

    const results = taskDb.run(db => getFailureClassifications(db))
    expect(results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATM-029 / REQ-017 [P3] — no retroactive backfill guardrail
// ---------------------------------------------------------------------------
describe('ATM-029: no retroactive backfill from historical fault/blocked data (REQ-017)', () => {
  const TEST_DB = '/tmp/p6-persist-atm029.db'

  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-029: pre-existing historical agent_sessions/tasks/audit_log fault data does NOT get swept into failure_classifications by migrate()', () => {
    wipeDbFile(TEST_DB)

    // Step 1: open a fresh TaskDB — this runs migrate() once, creating every
    // table (agent_sessions, tasks, audit_log, failure_classifications, ...).
    const firstOpen = new TaskDB(TEST_DB)

    // Step 2: simulate an EXISTING production DB that already has historical
    // fault/blocked data recorded BEFORE this feature ever existed — the kind
    // of data a naive backfill migration might try to sweep into
    // failure_classifications.
    firstOpen.run(db => {
      // A task that got blocked long before failure_classification_enabled
      // existed. from_agent === to_agent so the trg_require_supervision
      // trigger (which demands a supervisor_agent when they differ) doesn't
      // fire — irrelevant to what this test is proving.
      db.prepare(`
        INSERT INTO tasks (from_agent, to_agent, description, status, blocked_reason, blocked_on)
        VALUES ('boss', 'boss', 'historical task with a blocked reason', 'blocked', 'waiting on human review', 'human')
      `).run()

      // An agent_sessions row bearing historical crash/timeout fault data.
      db.prepare(`
        INSERT INTO agent_sessions (agent, state, last_fault_type, fault_count)
        VALUES ('kiera', 'unknown', 'crash', 3)
      `).run()
      db.prepare(`
        INSERT INTO agent_sessions (agent, state, last_fault_type, fault_count)
        VALUES ('sadie', 'unknown', 'timeout', 1)
      `).run()

      // audit_log rows describing historical faults, predating this feature.
      db.prepare(`
        INSERT INTO audit_log (agent, action, detail)
        VALUES ('kiera', 'fault_detected', '{"faultType":"crash"}')
      `).run()
      db.prepare(`
        INSERT INTO audit_log (agent, action, detail)
        VALUES ('boss', 'task_blocked', '{"blocked_on":"human"}')
      `).run()
    })

    // Sanity: the historical data landed as expected, and failure_classifications
    // is empty immediately after the FIRST migrate() too (no backfill on initial
    // creation either).
    const preReopenCount = firstOpen.run(db =>
      (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number }).n,
    )
    expect(preReopenCount).toBe(0)

    // Step 3: re-open the SAME db file — TaskDB's constructor re-runs
    // migrate() (proven idempotent by ATM-019's "re-running migrate() ... is
    // idempotent" test). If migrate() ever grew a backfill job that derives
    // failure_classifications rows from historical agent_sessions.last_fault_type,
    // tasks.blocked_reason/blocked_on, or audit_log fault/blocked entries, this
    // second migrate() pass is precisely where it would fire.
    let secondOpen: TaskDB
    expect(() => { secondOpen = new TaskDB(TEST_DB) }).not.toThrow()

    const postReopenCount = secondOpen!.run(db =>
      (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number }).n,
    )
    expect(postReopenCount).toBe(0)

    // And the read accessor agrees: nothing to see, forward-accumulation only.
    const rows = secondOpen!.run(db => getFailureClassifications(db))
    expect(rows).toEqual([])

    // Confirm the historical seed data really is still there (so this test
    // is proving "no backfill", not "table doesn't exist" / "insert silently
    // failed").
    const taskRow = secondOpen!.run(db =>
      db.prepare("SELECT blocked_reason, blocked_on FROM tasks WHERE description = 'historical task with a blocked reason'").get(),
    ) as { blocked_reason: string; blocked_on: string } | undefined
    expect(taskRow?.blocked_reason).toBe('waiting on human review')
    expect(taskRow?.blocked_on).toBe('human')

    const sessionRow = secondOpen!.run(db =>
      db.prepare("SELECT last_fault_type FROM agent_sessions WHERE agent = 'kiera'").get(),
    ) as { last_fault_type: string } | undefined
    expect(sessionRow?.last_fault_type).toBe('crash')
  })
})

// ---------------------------------------------------------------------------
// ATM-031 / REQ-019 [P1] — scope-bleed guardrail (P6 Stage 7 / EPIC-07)
//
// P6's stated boundary (specs/P6-spec.md) is: EPIC-01..06 add a NEW,
// additive failure-classification taxonomy/adapter/persistence/wiring
// surface, WITHOUT touching the pre-existing memory-integrity/ordering,
// agent-messages, or decision (critique) subsystems, and WITHOUT altering
// the pre-existing findings/artifacts table shapes in db.ts. This test
// proves that boundary held for the real diff, not just "the code looks
// like it doesn't touch those files" — it shells out to git (read-only) and
// checks the ACTUAL changed-file set and the ACTUAL db.ts diff hunks against
// the base commit the P6 work branched from.
// ---------------------------------------------------------------------------
describe('ATM-031: scope-bleed guardrail — diff vs base 5014d7f (REQ-019)', () => {
  const BASE_COMMIT = '5014d7f'
  // REPO resolves to the worktree root (this file lives in tests/, one level
  // down) — robust regardless of which directory `bun test` was invoked from.
  const REPO = join(import.meta.dir, '..')

  function gitDiffNameOnly(): string[] {
    let proc: ReturnType<typeof Bun.spawnSync>
    try {
      proc = Bun.spawnSync(['git', '-C', REPO, 'diff', '--name-only', BASE_COMMIT], {
        cwd: REPO,
      })
    } catch (err) {
      // Fail loudly — git being unavailable must not be mistaken for "no
      // diff" (which would silently pass this guardrail for the wrong
      // reason).
      throw new Error(`ATM-031: git is unavailable — cannot verify scope-bleed boundary: ${err}`)
    }
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr?.toString() ?? '(no stderr)'
      throw new Error(
        `ATM-031: 'git diff --name-only ${BASE_COMMIT}' exited ${proc.exitCode} — cannot verify scope-bleed ` +
        `boundary. Is ${BASE_COMMIT} a valid commit reachable from this worktree? stderr: ${stderr}`,
      )
    }
    // proc.stdout is typed `Buffer | undefined` by bun-types' generic
    // ReturnType inference here, but is always a Buffer in practice — this
    // call never overrides stdio, so it uses spawnSync's "pipe" default.
    // Guard defensively rather than assert, so an unexpected undefined
    // still fails loudly (empty diff) instead of throwing a TypeError.
    const out = (proc.stdout ?? Buffer.alloc(0)).toString().trim()
    return out.length === 0 ? [] : out.split('\n')
  }

  function gitDiffFile(relPath: string): string {
    let proc: ReturnType<typeof Bun.spawnSync>
    try {
      proc = Bun.spawnSync(['git', '-C', REPO, 'diff', BASE_COMMIT, '--', relPath], {
        cwd: REPO,
      })
    } catch (err) {
      throw new Error(`ATM-031: git is unavailable — cannot verify db.ts scope-bleed boundary: ${err}`)
    }
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr?.toString() ?? '(no stderr)'
      throw new Error(
        `ATM-031: 'git diff ${BASE_COMMIT} -- ${relPath}' exited ${proc.exitCode} — cannot verify scope-bleed ` +
        `boundary. stderr: ${stderr}`,
      )
    }
    return (proc.stdout ?? Buffer.alloc(0)).toString()
  }

  test('ATM-031(1): none of the protected memory/messages/decision files appear in the P6 changed-file set', () => {
    const PROTECTED_FILES = [
      'memory-integrity.ts',
      'memory-integrity-patterns.ts',
      'memory-ordering.ts',
      'agent-messages.ts',
      'agent-message-types.ts',
      'decision.ts',
    ]

    const changedFiles = gitDiffNameOnly()
    // Sanity precondition: the diff must be non-trivial (P6 unquestionably
    // touched SOMETHING vs the base commit) — otherwise a git misconfig that
    // makes gitDiffNameOnly() return [] would make this test pass for the
    // wrong reason (vacuous "0 protected files changed because 0 files
    // changed at all").
    expect(changedFiles.length).toBeGreaterThan(0)

    const violations = PROTECTED_FILES.filter(f => changedFiles.includes(f))
    if (violations.length > 0) {
      throw new Error(
        `ATM-031 violation: protected file(s) appear in the P6 diff vs ${BASE_COMMIT}: ${violations.join(', ')}\n` +
        `P6's BEGIN IMMEDIATE / critique-severity patterns must be re-implemented locally in the failure-` +
        `classification module, NOT imported from or by modifying decision.ts/memory-integrity.ts/memory-ordering.ts/` +
        `agent-messages.ts. Full changed-file set: ${changedFiles.join(', ')}`,
      )
    }
    expect(violations).toEqual([])
  })

  test('ATM-031(2): the findings/artifacts table DEFINITIONS in db.ts are unchanged in the P6 diff (only failure_classifications + flag-seed additions)', () => {
    const dbDiff = gitDiffFile('db.ts')
    // Sanity precondition: db.ts DID change (P6 added the failure_classifications
    // table + flag seed there — ATM-019/ATM-027) — a git misconfig returning
    // an empty diff must not be mistaken for "no findings/artifacts touch".
    expect(dbDiff.length).toBeGreaterThan(0)

    const diffLines = dbDiff.split('\n')
    const addedOrRemoved = diffLines.filter(l => (l.startsWith('+') || l.startsWith('-'))
      && !l.startsWith('+++') && !l.startsWith('---'))

    // Any added/removed line that touches a `findings` or `artifacts` CREATE
    // TABLE statement, or references those table names in a column/index
    // definition context, is a scope-bleed violation. Deliberately broad
    // (case-insensitive substring match on the table names) so a rename,
    // an added column, or an added/dropped index on either table is caught
    // — not just a literal "CREATE TABLE findings" line.
    const findingsOrArtifactsHits = addedOrRemoved.filter(l =>
      /\bfindings\b/i.test(l) || /\bartifacts\b/i.test(l),
    )

    if (findingsOrArtifactsHits.length > 0) {
      throw new Error(
        `ATM-031 violation: db.ts diff vs ${BASE_COMMIT} contains added/removed line(s) touching findings/artifacts:\n` +
        findingsOrArtifactsHits.map(l => `  ${l}`).join('\n') +
        `\nThe only db.ts additions in P6 should be the failure_classifications table + its indexes ` +
        `(ATM-019) and the failure_classification_enabled flag seed (ATM-027).`,
      )
    }
    expect(findingsOrArtifactsHits).toEqual([])

    // Codex round-2 fold (Finding 3 / REQ-019): the findings/artifacts scan
    // above is necessary but not sufficient — a P6 db.ts diff could also
    // bleed into the P4/P5 write-sequencing / memory-integrity surface
    // (write_sequence, agent_messages, memories.write_seq, withMemoryWriteTxn,
    // nextWriteSeq, sanitizeMemoryContent, source_type) without ever
    // mentioning "findings" or "artifacts". Assert no added/removed db.ts
    // line touches any of those protected P4/P5 symbols either.
    const PROTECTED_DB_SYMBOL_PATTERNS: RegExp[] = [
      /\bwrite_sequence\b/,
      /\bagent_messages\b/,
      /memories\.write_seq\b/,
      /\bwrite_seq\b/,
      /\bwithMemoryWriteTxn\b/,
      /\bnextWriteSeq\b/,
      /\bsanitizeMemoryContent\b/,
      /\bsource_type\b/,
    ]
    const protectedSymbolHits = addedOrRemoved.filter(l =>
      PROTECTED_DB_SYMBOL_PATTERNS.some(re => re.test(l)),
    )
    if (protectedSymbolHits.length > 0) {
      throw new Error(
        `ATM-031 violation: db.ts diff vs ${BASE_COMMIT} contains added/removed line(s) touching a protected ` +
        `P4/P5 symbol (write_sequence / agent_messages / memories.write_seq / write_seq / withMemoryWriteTxn / ` +
        `nextWriteSeq / sanitizeMemoryContent / source_type):\n` +
        protectedSymbolHits.map(l => `  ${l}`).join('\n') +
        `\nThe only db.ts additions in P6 should be the failure_classifications table + its indexes ` +
        `(ATM-019) and the failure_classification_enabled flag seed (ATM-027).`,
      )
    }
    expect(protectedSymbolHits).toEqual([])

    // Confirm the diff DOES contain the expected, in-scope addition (proves
    // this test is reading real diff content, not an empty/truncated one).
    expect(dbDiff).toMatch(/failure_classifications/)
  })

  test('ATM-031(3): verification/failure-classification.ts source contains no reward-shaped computation and no cross-family critique construction', () => {
    // Distinct from (and in addition to) ATM-025 above: ATM-025 is a
    // module-scope regex scan proving the module's OWN source is clean.
    // ATM-031(3) is the scope-bleed-specific restatement of that same
    // invariant, kept as an independent assertion so this describe block is
    // a self-contained, diff-anchored proof of REQ-019 that doesn't rely on
    // ATM-025 continuing to exist/pass elsewhere in this file.
    const modulePath = join(REPO, 'verification', 'failure-classification.ts')
    const source = readFileSync(modulePath, 'utf8')

    // (a) No numeric literal -1/0/1 returned or assigned to a `reward`-named
    // binding, and no `reward` identifier anywhere in the module at all —
    // the strongest form of "no reward-shaped computation crossed over from
    // the critique/decision family".
    expect(source).not.toMatch(/reward/i)

    // (b) No cross-family critique CONSTRUCTION. Strip the one known,
    // pre-existing type-only `CritiqueSeverity` import (ATM-004's
    // decision.ts distinctness guardrail — legitimate, unrelated to
    // building a critique) before scanning, then assert zero remaining
    // occurrences of the word.
    const withoutKnownTypeImport = source.replace(/CritiqueSeverity/g, '')
    expect(withoutKnownTypeImport).not.toMatch(/critique/i)
  })
})
