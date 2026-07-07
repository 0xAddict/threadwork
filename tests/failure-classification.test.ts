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

import { describe, test, expect } from 'bun:test'
import type { CritiqueSeverity } from '../decision'
import type { BlockedOn } from '../db'
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
