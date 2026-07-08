// tests/ternary-reward.test.ts — P8 TDD tests.
//
// STAGE 1 of build-p8/PLAN.md: EPIC-01 (Ternary Reward Vocabulary &
// Versioned Policy Taxonomy) ONLY — ATM-001 (canonical TernaryReward union +
// frozen TernaryRewardValue + frozen ALL_TERNARY_REWARDS), ATM-002
// (TERNARY_REWARD_TAXONOMY_VERSION + empty TAXONOMY_CHANGELOG at v1),
// ATM-003 (append-only version guardrail against a committed snapshot
// fixture, incl. a non-vacuous "bite" proof, mirrors P7's ATM-002 pattern),
// ATM-004 (numeric-vs-string distinctness vs CritiqueSeverity/FailureClass/
// FailureSeverity/CrossFamilyVerdict), and ATM-005 (never-mutate frozen guard).
//
// STAGE 2 (this addition, below): EPIC-02 (Pure Reward Evaluator Core) —
// ATM-006 (TernaryRewardSignal/TernaryRewardAssessment record types),
// ATM-007 (type-only-import guardrail for CrossFamilyVerdict/FailureSeverity),
// ATM-008 (table-driven assignTernaryReward() over all 5 decision-table rows
// + precedence-overlap + availability-guard cases), ATM-009 (purity +
// idempotency + source-level no-clock/no-random check), and ATM-010
// (40-case never-throw malformed fuzz guard).
//
// This file grows in later P8 build stages (EPIC-03 onward) — do NOT
// add read-adapter/persistence/wiring tests here yet (later stages).

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import taxonomySnapshot from './fixtures/ternary-reward-taxonomy.snapshot.json'
import {
  TernaryReward,
  TernaryRewardValue,
  ALL_TERNARY_REWARDS,
  TERNARY_REWARD_TAXONOMY_VERSION,
  TAXONOMY_CHANGELOG,
  TERNARY_REWARD_DECISION_TABLE,
  type TernaryRewardDecisionRow,
  assignTernaryReward,
  type TernaryRewardSignal,
  type TernaryRewardAssessment,
} from '../verification/ternary-reward'
import { ALL_FAILURE_CLASSES, ALL_FAILURE_SEVERITIES } from '../verification/failure-classification'
import { ALL_CROSS_FAMILY_VERDICTS } from '../verification/cross-family-critique'

const MODULE_SOURCE = readFileSync(join(import.meta.dir, '..', 'verification', 'ternary-reward.ts'), 'utf8')

// ---------------------------------------------------------------------------
// ATM-001 / REQ-001 [P1] — TernaryReward union, frozen TernaryRewardValue,
// frozen ALL_TERNARY_REWARDS
// ---------------------------------------------------------------------------
describe('ATM-001: TernaryReward vocabulary', () => {
  test('ATM-001: ALL_TERNARY_REWARDS deep-equals [-1, 0, 1] (in order)', () => {
    expect([...ALL_TERNARY_REWARDS]).toEqual([-1, 0, 1])
  })

  test('ATM-001: ALL_TERNARY_REWARDS is frozen', () => {
    expect(Object.isFrozen(ALL_TERNARY_REWARDS)).toBe(true)
  })

  test('ATM-001: TernaryRewardValue is frozen', () => {
    expect(Object.isFrozen(TernaryRewardValue)).toBe(true)
  })

  test('ATM-001: TernaryRewardValue.NEGATIVE === -1, .NEUTRAL === 0, .POSITIVE === 1', () => {
    expect(TernaryRewardValue.NEGATIVE).toBe(-1)
    expect(TernaryRewardValue.NEUTRAL).toBe(0)
    expect(TernaryRewardValue.POSITIVE).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ATM-002 / REQ-002 [P1] — TERNARY_REWARD_TAXONOMY_VERSION + TAXONOMY_CHANGELOG
// ---------------------------------------------------------------------------
describe('ATM-002: taxonomy version + changelog', () => {
  test('ATM-002: TERNARY_REWARD_TAXONOMY_VERSION === 1', () => {
    expect(TERNARY_REWARD_TAXONOMY_VERSION).toBe(1)
  })

  test('ATM-002: TAXONOMY_CHANGELOG is empty at v1', () => {
    expect(TAXONOMY_CHANGELOG).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATM-003 / REQ-002(a) [P2] — Append-only version guardrail (snapshot)
// ---------------------------------------------------------------------------
describe('ATM-003: append-only snapshot guardrail', () => {
  type TaxonomySnapshot = {
    version: number
    rewards: TernaryReward[]
    decisionTable: TernaryRewardDecisionRow[]
  }
  const snapshot = taxonomySnapshot as unknown as TaxonomySnapshot

  test('ATM-003: committed snapshot deep-equals live ALL_TERNARY_REWARDS + TERNARY_REWARD_TAXONOMY_VERSION', () => {
    expect(snapshot.version).toBe(TERNARY_REWARD_TAXONOMY_VERSION)
    expect(snapshot.rewards).toEqual([...ALL_TERNARY_REWARDS])
  })

  test('ATM-003: committed snapshot deep-equals live TERNARY_REWARD_DECISION_TABLE', () => {
    expect(snapshot.decisionTable).toEqual(JSON.parse(JSON.stringify(TERNARY_REWARD_DECISION_TABLE)))
  })

  test('ATM-003: changelog length matches version, and last entry (if any) matches current version', () => {
    expect(TAXONOMY_CHANGELOG.length).toBe(TERNARY_REWARD_TAXONOMY_VERSION - 1)
    if (TERNARY_REWARD_TAXONOMY_VERSION > 1) {
      expect(TAXONOMY_CHANGELOG[TAXONOMY_CHANGELOG.length - 1]?.version).toBe(TERNARY_REWARD_TAXONOMY_VERSION)
    }
  })

  // --- Non-vacuous "bite" proof -------------------------------------------
  //
  // The assertions above only prove the CURRENT state matches the snapshot.
  // That alone doesn't prove the guardrail would actually REJECT a bad
  // change. This helper reimplements the guardrail's decision rule (reward
  // set OR decision-table mapping changed => version bump AND matching
  // changelog entry required, with append-only additions NOT exempt) and we
  // drive it with simulated "someone changed the mapping without bumping the
  // version" cases to prove the rule actually bites — mirrors P7's
  // ATM-002 bite-proof pattern (tests/cross-family-critique.test.ts).
  function validateTaxonomyRevision(
    baselineRewards: readonly TernaryReward[],
    baselineTable: readonly TernaryRewardDecisionRow[],
    baselineVersion: number,
    candidateRewards: readonly TernaryReward[],
    candidateTable: readonly TernaryRewardDecisionRow[],
    candidateVersion: number,
    candidateChangelog: readonly { version: number; change: string }[],
  ): { ok: boolean; reason?: string } {
    const rewardsChanged = JSON.stringify(baselineRewards) !== JSON.stringify(candidateRewards)
    const tableChanged = JSON.stringify(baselineTable) !== JSON.stringify(candidateTable)
    if (!rewardsChanged && !tableChanged) {
      return { ok: true }
    }
    if (candidateVersion <= baselineVersion) {
      return {
        ok: false,
        reason: 'reward set or decision-table mapping changed without a TERNARY_REWARD_TAXONOMY_VERSION bump',
      }
    }
    const hasMatchingEntry = candidateChangelog.some((e) => e.version === candidateVersion)
    if (!hasMatchingEntry) {
      return {
        ok: false,
        reason: 'reward set or decision-table mapping changed without a matching TAXONOMY_CHANGELOG entry',
      }
    }
    return { ok: true }
  }

  test('ATM-003 bite-proof: the real snapshot vs live state passes validation', () => {
    const result = validateTaxonomyRevision(
      snapshot.rewards,
      snapshot.decisionTable,
      snapshot.version,
      [...ALL_TERNARY_REWARDS],
      JSON.parse(JSON.stringify(TERNARY_REWARD_DECISION_TABLE)),
      TERNARY_REWARD_TAXONOMY_VERSION,
      TAXONOMY_CHANGELOG,
    )
    expect(result.ok).toBe(true)
  })

  test('ATM-003 bite-proof: a decision-table change WITHOUT a version bump is REJECTED (not exempt)', () => {
    const mutatedTable = snapshot.decisionTable.map((r) =>
      r.row === 5 ? { ...r, reward: 1 as TernaryReward } : r,
    )
    const result = validateTaxonomyRevision(
      snapshot.rewards,
      snapshot.decisionTable,
      snapshot.version,
      snapshot.rewards,
      mutatedTable,
      snapshot.version, // version NOT bumped
      [], // no changelog entry
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/version bump/i)
  })

  test('ATM-003 bite-proof: a reward-set change WITH a version bump but NO matching changelog entry is still REJECTED', () => {
    const mutatedRewards = [...snapshot.rewards, 2 as TernaryReward]
    const result = validateTaxonomyRevision(
      snapshot.rewards,
      snapshot.decisionTable,
      snapshot.version,
      mutatedRewards,
      snapshot.decisionTable,
      snapshot.version + 1, // bumped...
      [], // ...but no matching changelog entry
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/TAXONOMY_CHANGELOG entry/)
  })

  test('ATM-003 bite-proof: a decision-table change WITH a version bump AND a matching changelog entry is ACCEPTED', () => {
    const mutatedTable = snapshot.decisionTable.map((r) =>
      r.row === 5 ? { ...r, reward: 1 as TernaryReward } : r,
    )
    const nextVersion = snapshot.version + 1
    const result = validateTaxonomyRevision(
      snapshot.rewards,
      snapshot.decisionTable,
      snapshot.version,
      snapshot.rewards,
      mutatedTable,
      nextVersion,
      [{ version: nextVersion, change: 'row 5 default reward changed from 0 to 1' }],
    )
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ATM-004 / REQ-003 [P2] — Distinctness guardrail (numeric vs string sets)
// ---------------------------------------------------------------------------
describe('ATM-004: distinctness guardrail', () => {
  // decision.ts exports CritiqueSeverity as a TYPE only — no runtime array
  // exists (grep-confirmed absent; PLAN.md §2 "minor build-note"). Mirrors
  // cross-family-critique.ts:269's own local _VALID_CRITIQUE_SEVERITIES set.
  const CRITIQUE_SEVERITIES: readonly string[] = ['observation', 'concern', 'blocker']

  test('ATM-004: ALL_TERNARY_REWARDS has zero overlap with CritiqueSeverity set', () => {
    const rewardSet = new Set<unknown>(ALL_TERNARY_REWARDS)
    const overlap = CRITIQUE_SEVERITIES.filter((v) => rewardSet.has(v))
    expect(overlap).toEqual([])
  })

  test('ATM-004: ALL_TERNARY_REWARDS has zero overlap with ALL_FAILURE_CLASSES', () => {
    const rewardSet = new Set<unknown>(ALL_TERNARY_REWARDS)
    const overlap = ALL_FAILURE_CLASSES.filter((v) => rewardSet.has(v))
    expect(overlap).toEqual([])
  })

  test('ATM-004: ALL_TERNARY_REWARDS has zero overlap with ALL_FAILURE_SEVERITIES', () => {
    const rewardSet = new Set<unknown>(ALL_TERNARY_REWARDS)
    const overlap = ALL_FAILURE_SEVERITIES.filter((v) => rewardSet.has(v))
    expect(overlap).toEqual([])
  })

  test('ATM-004: ALL_TERNARY_REWARDS has zero overlap with ALL_CROSS_FAMILY_VERDICTS', () => {
    const rewardSet = new Set<unknown>(ALL_TERNARY_REWARDS)
    const overlap = ALL_CROSS_FAMILY_VERDICTS.filter((v) => rewardSet.has(v))
    expect(overlap).toEqual([])
  })

  test('ATM-004: every ALL_TERNARY_REWARDS member is typeof "number"; every comparison-set member is typeof "string"', () => {
    for (const r of ALL_TERNARY_REWARDS) {
      expect(typeof r).toBe('number')
    }
    for (const v of [...CRITIQUE_SEVERITIES, ...ALL_FAILURE_CLASSES, ...ALL_FAILURE_SEVERITIES, ...ALL_CROSS_FAMILY_VERDICTS]) {
      expect(typeof v).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-005 / REQ-001 [P2] — Never-mutate frozen-object guard
// ---------------------------------------------------------------------------
describe('ATM-005: never-mutate frozen guard', () => {
  test('ATM-005: mutating TernaryRewardValue.NEGATIVE is a no-op or throws; value unchanged', () => {
    let threw = false
    try {
      // @ts-expect-error intentional mutation attempt on a frozen readonly object
      TernaryRewardValue.NEGATIVE = 99
    } catch {
      threw = true
    }
    expect(TernaryRewardValue.NEGATIVE).toBe(-1)
    expect(typeof threw).toBe('boolean')
  })

  test('ATM-005: pushing onto ALL_TERNARY_REWARDS is a no-op or throws; array unchanged', () => {
    const before = [...ALL_TERNARY_REWARDS]
    let threw = false
    try {
      // @ts-expect-error intentional mutation attempt on a frozen readonly array
      ALL_TERNARY_REWARDS.push(2)
    } catch {
      threw = true
    }
    expect([...ALL_TERNARY_REWARDS]).toEqual(before)
    expect(typeof threw).toBe('boolean')
  })
})

// ===========================================================================
// STAGE 2 of build-p8/PLAN.md: EPIC-02 (Pure Reward Evaluator Core) —
// ATM-006..ATM-010. Do NOT add EPIC-03+ tests here yet (later stages).
// ===========================================================================

// ---------------------------------------------------------------------------
// ATM-006 / REQ-004 [P1] — TernaryRewardSignal / TernaryRewardAssessment
// record types
// ---------------------------------------------------------------------------
describe('ATM-006: TernaryRewardSignal / TernaryRewardAssessment record types', () => {
  // One literal TernaryRewardSignal per decision-table row.
  const rowSignals: TernaryRewardSignal[] = [
    { cross_family_verdict: 'block', failure_severity: 'critical', failure_signal_available: true }, // row 1
    { cross_family_verdict: null, failure_severity: 'high', failure_signal_available: true }, // row 2
    { cross_family_verdict: 'concur', failure_severity: 'low', failure_signal_available: true }, // row 3
    { cross_family_verdict: 'dissent', failure_severity: null, failure_signal_available: false }, // row 4
    { cross_family_verdict: 'unknown', failure_severity: 'medium', failure_signal_available: true }, // row 5
  ]

  test('ATM-006: one TernaryRewardSignal per decision-table row type-checks and round-trips through JSON', () => {
    for (const signal of rowSignals) {
      const roundTripped = JSON.parse(JSON.stringify(signal)) as TernaryRewardSignal
      expect(roundTripped).toEqual(signal)
    }
  })

  test('ATM-006: a constructed TernaryRewardAssessment round-trips with reward constrained to ALL_TERNARY_REWARDS', () => {
    for (const reward of ALL_TERNARY_REWARDS) {
      const assessment: TernaryRewardAssessment = { reward, policy_version: TERNARY_REWARD_TAXONOMY_VERSION }
      const roundTripped = JSON.parse(JSON.stringify(assessment)) as TernaryRewardAssessment
      expect(roundTripped).toEqual(assessment)
      expect(ALL_TERNARY_REWARDS).toContain(assessment.reward)
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-007 / REQ-004(a) [P2] — Type-only-import guardrail
// ---------------------------------------------------------------------------
describe('ATM-007: type-only-import guardrail', () => {
  test('ATM-007: CrossFamilyVerdict is imported TYPE-ONLY from cross-family-critique.ts', () => {
    expect(MODULE_SOURCE).toMatch(
      /import\s+type\s*\{[^}]*\bCrossFamilyVerdict\b[^}]*\}\s*from\s*['"]\.\/cross-family-critique['"]/,
    )
  })

  test('ATM-007: FailureSeverity is imported TYPE-ONLY from failure-classification.ts', () => {
    expect(MODULE_SOURCE).toMatch(
      /import\s+type\s*\{[^}]*\bFailureSeverity\b[^}]*\}\s*from\s*['"]\.\/failure-classification['"]/,
    )
  })

  test('ATM-007: neither symbol is pulled in via a non-type-only (value) import statement', () => {
    const valueImportLines = MODULE_SOURCE
      .split('\n')
      .filter((line) => /^\s*import\s*\{/.test(line) && !/^\s*import\s+type\s*\{/.test(line))
    for (const line of valueImportLines) {
      expect(line).not.toMatch(/\bCrossFamilyVerdict\b/)
      expect(line).not.toMatch(/\bFailureSeverity\b/)
    }
  })

  test('ATM-007: neither symbol is re-exported or aliased under a new name', () => {
    expect(MODULE_SOURCE).not.toMatch(/export\s*\{[^}]*\bCrossFamilyVerdict\b/)
    expect(MODULE_SOURCE).not.toMatch(/export\s*\{[^}]*\bFailureSeverity\b/)
    expect(MODULE_SOURCE).not.toMatch(/export\s+type\s*\{[^}]*\bCrossFamilyVerdict\b/)
    expect(MODULE_SOURCE).not.toMatch(/export\s+type\s*\{[^}]*\bFailureSeverity\b/)
    expect(MODULE_SOURCE).not.toMatch(/\bas\s+CrossFamilyVerdict\w+/)
    expect(MODULE_SOURCE).not.toMatch(/\bas\s+FailureSeverity\w+/)
  })
})

// ---------------------------------------------------------------------------
// ATM-008 / REQ-005 [P1] — Table-driven assignTernaryReward()
// ---------------------------------------------------------------------------
describe('ATM-008: table-driven assignTernaryReward()', () => {
  const cases: { label: string; signal: TernaryRewardSignal; expected: TernaryReward }[] = [
    // --- one case per decision-table row (baseline) ------------------------
    {
      label: 'row 1 baseline: block verdict dominates',
      signal: { cross_family_verdict: 'block', failure_severity: null, failure_signal_available: false },
      expected: -1,
    },
    {
      label: 'row 2 baseline: high severity',
      signal: { cross_family_verdict: null, failure_severity: 'high', failure_signal_available: true },
      expected: -1,
    },
    {
      label: 'row 2 baseline: critical severity',
      signal: { cross_family_verdict: null, failure_severity: 'critical', failure_signal_available: true },
      expected: -1,
    },
    {
      label: 'row 3 baseline: concur + available + null severity',
      signal: { cross_family_verdict: 'concur', failure_severity: null, failure_signal_available: true },
      expected: 1,
    },
    {
      label: 'row 4 baseline: dissent is neutral',
      signal: { cross_family_verdict: 'dissent', failure_severity: null, failure_signal_available: false },
      expected: 0,
    },
    {
      label: 'row 5 baseline: unknown verdict + medium severity falls to default',
      signal: { cross_family_verdict: 'unknown', failure_severity: 'medium', failure_signal_available: true },
      expected: 0,
    },
    {
      label: 'row 5 baseline: insufficient_same_family falls to default',
      signal: { cross_family_verdict: 'insufficient_same_family', failure_severity: null, failure_signal_available: false },
      expected: 0,
    },

    // --- genuine-overlap precedence cases (first-match-wins) --------------
    {
      label: 'precedence: block+critical -> row 1 wins over row 2',
      signal: { cross_family_verdict: 'block', failure_severity: 'critical', failure_signal_available: true },
      expected: -1,
    },
    {
      label: 'precedence: dissent+high -> row 2 wins over row 4 (DIFFERENT outcomes)',
      signal: { cross_family_verdict: 'dissent', failure_severity: 'high', failure_signal_available: true },
      expected: -1,
    },
    {
      label: 'precedence: dissent+critical -> row 2 wins over row 4',
      signal: { cross_family_verdict: 'dissent', failure_severity: 'critical', failure_signal_available: true },
      expected: -1,
    },
    {
      label: 'precedence: dissent+medium -> row 4 wins over row 5',
      signal: { cross_family_verdict: 'dissent', failure_severity: 'medium', failure_signal_available: true },
      expected: 0,
    },

    // --- availability-guard cases: an UNKNOWN P6 signal NEVER earns +1 ----
    {
      label: 'availability-guard: concur+null severity+available -> row 3 fires (+1)',
      signal: { cross_family_verdict: 'concur', failure_severity: null, failure_signal_available: true },
      expected: 1,
    },
    {
      label: 'availability-guard: concur+low severity+available -> row 3 fires (+1)',
      signal: { cross_family_verdict: 'concur', failure_severity: 'low', failure_signal_available: true },
      expected: 1,
    },
    {
      label: 'availability-guard: concur+null severity+UNAVAILABLE -> row 3 BLOCKED, NEVER +1',
      signal: { cross_family_verdict: 'concur', failure_severity: null, failure_signal_available: false },
      expected: 0,
    },
    {
      label: 'availability-guard: concur+high severity+available -> row 2 fires, row 3 excluded by severity',
      signal: { cross_family_verdict: 'concur', failure_severity: 'high', failure_signal_available: true },
      expected: -1,
    },
  ]

  for (const { label, signal, expected } of cases) {
    test(`ATM-008: ${label}`, () => {
      const result = assignTernaryReward(signal)
      expect(result).toEqual({ reward: expected, policy_version: TERNARY_REWARD_TAXONOMY_VERSION })
    })
  }
})

// ---------------------------------------------------------------------------
// ATM-009 / REQ-006 [P1] — Purity + idempotency
// ---------------------------------------------------------------------------
describe('ATM-009: purity + idempotency', () => {
  test('ATM-009: two calls with byte-identical input produce a full deep-equal result', () => {
    const signal: TernaryRewardSignal = {
      cross_family_verdict: 'concur',
      failure_severity: 'low',
      failure_signal_available: true,
    }
    const r1 = assignTernaryReward(signal)
    const r2 = assignTernaryReward(signal)
    expect(r1).toEqual(r2)
    expect(r1).toEqual({ reward: 1, policy_version: 1 })
  })

  test('ATM-009: source-level check — the module contains no Date/Date.now/performance.now/Math.random call', () => {
    expect(MODULE_SOURCE).not.toMatch(/\bDate\.now\s*\(/)
    expect(MODULE_SOURCE).not.toMatch(/\bnew\s+Date\s*\(/)
    expect(MODULE_SOURCE).not.toMatch(/\bperformance\.now\s*\(/)
    expect(MODULE_SOURCE).not.toMatch(/\bMath\.random\s*\(/)
    expect(MODULE_SOURCE).not.toMatch(/\bdatetime\s*\(/)
  })
})

// ---------------------------------------------------------------------------
// ATM-010 / REQ-006(a) [P2] — Never-throw malformed fuzz guard (40 cases)
// ---------------------------------------------------------------------------
describe('ATM-010: never-throw fuzz guard (40 malformed inputs)', () => {
  function makeThrowingGetter(): unknown {
    const obj: Record<string, unknown> = {}
    Object.defineProperty(obj, 'cross_family_verdict', {
      get() {
        throw new Error('boom')
      },
      enumerable: true,
    })
    return obj
  }

  function makeCircular(): unknown {
    const circ: Record<string, unknown> = { cross_family_verdict: 'concur', failure_severity: null }
    circ.self = circ
    return circ
  }

  class UnrelatedClass {
    x = 1
  }

  const cases: { label: string; input: unknown }[] = [
    { label: 'null', input: null },
    { label: 'undefined', input: undefined },
    { label: 'number', input: 42 },
    { label: 'string', input: 'concur' },
    { label: 'boolean true', input: true },
    { label: 'boolean false', input: false },
    { label: 'NaN', input: NaN },
    { label: 'empty array', input: [] },
    { label: 'empty object', input: {} },
    // NOTE: these two deliberately use an out-of-set value on the ONE present
    // field — a present-but-recognized value (e.g. cross_family_verdict:
    // 'block' alone) would CORRECTLY match row 1 regardless of the other
    // missing fields (row 1's match clause only constrains
    // cross_family_verdict) and legitimately resolve to -1, which is correct
    // table-driven behavior, not a malformed-input case.
    { label: 'only cross_family_verdict present (out-of-set value)', input: { cross_family_verdict: 'unmatched_verdict_value' } },
    { label: 'only failure_severity present (out-of-set value)', input: { failure_severity: 'unmatched_severity_value' } },
    { label: 'only failure_signal_available present', input: { failure_signal_available: true } },
    {
      label: 'wrong-type verdict (number)',
      input: { cross_family_verdict: 123, failure_severity: 'low', failure_signal_available: true },
    },
    {
      label: 'wrong-type severity (number)',
      input: { cross_family_verdict: 'concur', failure_severity: 123, failure_signal_available: true },
    },
    {
      label: 'wrong-type avail (string "yes")',
      input: { cross_family_verdict: 'concur', failure_severity: 'low', failure_signal_available: 'yes' },
    },
    {
      label: 'wrong-type avail (number 1)',
      input: { cross_family_verdict: 'concur', failure_severity: 'low', failure_signal_available: 1 },
    },
    {
      label: 'out-of-set verdict + out-of-set severity',
      input: { cross_family_verdict: 'bogus_verdict', failure_severity: 'bogus_severity', failure_signal_available: true },
    },
    {
      label: 'out-of-set verdict only',
      input: { cross_family_verdict: 'not_a_real_verdict', failure_severity: null, failure_signal_available: true },
    },
    {
      label: 'out-of-set severity only',
      input: { cross_family_verdict: 'concur', failure_severity: 'not_a_real_severity', failure_signal_available: true },
    },
    {
      label: 'PRESERVED TEST TARGET: concur+null severity, avail OMITTED (MUST be 0, never +1)',
      input: { cross_family_verdict: 'concur', failure_severity: null },
    },
    {
      label: 'PRESERVED TEST TARGET: concur+low severity, avail OMITTED (MUST be 0, never +1)',
      input: { cross_family_verdict: 'concur', failure_severity: 'low' },
    },
    {
      label: 'concur+undefined severity, avail true',
      input: { cross_family_verdict: 'concur', failure_severity: undefined, failure_signal_available: true },
    },
    {
      label: 'null verdict, null severity, avail true',
      input: { cross_family_verdict: null, failure_severity: null, failure_signal_available: true },
    },
    {
      label: 'null verdict, null severity, avail false',
      input: { cross_family_verdict: null, failure_severity: null, failure_signal_available: false },
    },
    {
      label: 'extra unknown fields alongside an out-of-set core shape',
      input: {
        cross_family_verdict: 'not_a_real_verdict',
        failure_severity: 'not_a_real_severity',
        failure_signal_available: true,
        extra_junk: { a: 1 },
      },
    },
    {
      label: 'nested object as verdict value',
      input: { cross_family_verdict: { nested: true }, failure_severity: 'low', failure_signal_available: true },
    },
    {
      label: 'array as severity value',
      input: { cross_family_verdict: 'concur', failure_severity: ['high'], failure_signal_available: true },
    },
    {
      label: 'function as verdict value',
      input: { cross_family_verdict: () => 'block', failure_severity: 'low', failure_signal_available: true },
    },
    { label: 'Date instance as the whole signal', input: new Date() },
    { label: 'Map instance as the whole signal', input: new Map([['cross_family_verdict', 'block']]) },
    { label: 'Set instance as the whole signal', input: new Set(['block']) },
    {
      label: 'symbol as severity value',
      input: { cross_family_verdict: 'concur', failure_severity: Symbol('x'), failure_signal_available: true },
    },
    { label: 'throwing getter on cross_family_verdict', input: makeThrowingGetter() },
    { label: 'circular reference object', input: makeCircular() },
    {
      label: 'deeply nested malformed values on every field',
      input: {
        cross_family_verdict: { a: { b: { c: 'deep' } } },
        failure_severity: { x: 1 },
        failure_signal_available: { y: 2 },
      },
    },
    {
      label: 'negative-number severity',
      input: { cross_family_verdict: 'concur', failure_severity: -1, failure_signal_available: true },
    },
    {
      label: 'empty-string verdict and severity',
      input: { cross_family_verdict: '', failure_severity: '', failure_signal_available: true },
    },
    {
      label: 'whitespace-only verdict',
      input: { cross_family_verdict: '   ', failure_severity: 'low', failure_signal_available: true },
    },
    {
      label: 'avail explicitly null',
      input: { cross_family_verdict: 'concur', failure_severity: 'low', failure_signal_available: null },
    },
    { label: 'unrelated class instance without the expected shape', input: new UnrelatedClass() },
  ]

  test(`ATM-010: at least 40 malformed cases are exercised`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(40)
  })

  for (const { label, input } of cases) {
    test(`ATM-010: malformed input (${label}) never throws, resolves to {reward:0, policy_version:1}`, () => {
      let result: TernaryRewardAssessment | undefined
      let caught: unknown = null
      try {
        result = assignTernaryReward(input as unknown as TernaryRewardSignal)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeNull()
      expect(result).toEqual({ reward: 0, policy_version: 1 })
    })
  }
})
