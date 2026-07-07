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
