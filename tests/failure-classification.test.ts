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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  type FailureClassification,
  type RawFailureSignal,
  IDLE_COUNT_STAGNATION_THRESHOLD,
  classifyFailure,
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

/**
 * Builds exactly 50 programmatically-generated malformed inputs: missing
 * fields, wrong types, null/undefined, nested-object garbage, and objects
 * with a circular reference (one AS the signal itself, one embedded as a
 * `raw_signal`-named field on the malformed input, one nested inside).
 *
 * Every entry is deliberately constructed to land on the row-16 (or row-15,
 * still failure_class==='unknown') fallback: recognized sources that map
 * unconditionally elsewhere (verify_check, test_run, watchdog_dead_session,
 * escalation_bridge_all_paths_failed) and watchdog_blocked (which always
 * resolves to blocked_dependency, even for legacy/null blocked_on) are
 * deliberately excluded so the "each produces unknown" invariant holds.
 */
function buildAtm009MalformedInputs(): unknown[] {
  const inputs: unknown[] = []

  // Top-level non-object / nullish / primitive signals (9).
  inputs.push(null)
  inputs.push(undefined)
  inputs.push(42)
  inputs.push('just a string')
  inputs.push(true)
  inputs.push(false)
  inputs.push([])
  inputs.push([1, 2, 3])
  inputs.push({})

  // Missing / wrong-type `source` (6).
  inputs.push({ source: undefined })
  inputs.push({ source: null })
  inputs.push({ source: 123 })
  inputs.push({ source: {} })
  inputs.push({ source: [] })
  inputs.push({ source: true })

  // watchdog_fault with malformed/unrecognized faultType (4).
  inputs.push({ source: 'watchdog_fault' })
  inputs.push({ source: 'watchdog_fault', faultType: 123 })
  inputs.push({ source: 'watchdog_fault', faultType: null })
  inputs.push({ source: 'watchdog_fault', faultType: 'segfault' })

  // verify_idle_count with malformed/below-threshold idle_count (5).
  inputs.push({ source: 'verify_idle_count' })
  inputs.push({ source: 'verify_idle_count', idle_count: 'three' })
  inputs.push({ source: 'verify_idle_count', idle_count: -1 })
  inputs.push({ source: 'verify_idle_count', idle_count: Number.NaN })
  inputs.push({ source: 'verify_idle_count', idle_count: null })

  // adversarial_finding with malformed/unrecognized category (4).
  inputs.push({ source: 'adversarial_finding' })
  inputs.push({ source: 'adversarial_finding', category: 123 })
  inputs.push({ source: 'adversarial_finding', category: 'made_up_category' })
  inputs.push({ source: 'adversarial_finding', category: null, severityHint: 999 })

  // manual with malformed fields — always unknown regardless of shape (3).
  inputs.push({ source: 'manual' })
  inputs.push({ source: 'manual', task_id: 'nope', agent: 42, summary: {} })
  inputs.push({ source: 'manual', task_id: null, agent: null, summary: null })

  // Nested-object garbage with unrecognized sources (16).
  for (let i = 0; i < 16; i++) {
    inputs.push({
      source: `garbage_source_${i}`,
      nested: { a: { b: { c: [i, 'x', null, undefined] } } },
      task_id: i % 2 === 0 ? `id-${i}` : i,
      agent: i,
      summary: i % 3 === 0 ? null : { weird: true },
      extra: new Array(3).fill({ deep: { deeper: 'x' } }),
    })
  }

  // Circular references (3): AS the signal itself, embedded as a
  // `raw_signal`-named field, and nested one level deep.
  const circAsSignal: Record<string, unknown> = { source: 'circular_as_signal_source' }
  circAsSignal.self = circAsSignal
  inputs.push(circAsSignal)

  const circViaField: Record<string, unknown> = { source: 'circular_via_field_source' }
  circViaField.raw_signal = circViaField
  inputs.push(circViaField)

  const circNested: Record<string, unknown> = { source: 'manual' }
  circNested.nested = { parent: circNested }
  inputs.push(circNested)

  return inputs
}

describe('ATM-009: never-throw fuzz — 50 malformed inputs incl. circular refs', () => {
  test('ATM-009: exactly 50 malformed inputs are generated', () => {
    expect(buildAtm009MalformedInputs().length).toBe(50)
  })

  test('ATM-009: all 50 malformed inputs classify to a valid unknown-class FailureClassification with zero exceptions', () => {
    const inputs = buildAtm009MalformedInputs()
    let thrown = 0
    const thrownDetails: string[] = []
    const nonUnknown: { index: number; failure_class: string }[] = []

    inputs.forEach((input, index) => {
      try {
        const result = classifyFailure(input as any)
        expect(typeof result).toBe('object')
        expect(result).not.toBeNull()
        if (result.failure_class !== 'unknown') {
          nonUnknown.push({ index, failure_class: result.failure_class })
        }
      } catch (err) {
        thrown++
        thrownDetails.push(`index ${index}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    expect(thrownDetails).toEqual([])
    expect(thrown).toBe(0)
    expect(nonUnknown).toEqual([])
  })
})
