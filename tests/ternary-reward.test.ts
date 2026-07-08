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
// STAGE 3 (this addition, below): EPIC-03 (Consume P6+P7 read-contracts,
// read-only) — ATM-011 (aggregateCrossFamilyVerdict monotone precedence +
// is_cross_family anti-monoculture gate + defensive never-throw), ATM-012
// (worstMandatoryFailureSeverity precedence + never-throw), ATM-014
// (resolveTernaryRewardSignal runtime read-fault swallow), and ATM-015
// (import-scope guardrail: only the two read accessors + type-only reads,
// zero write symbols). ATM-013 (P6+P7 fixture-DB integration) lives in
// tests/ternary-reward-p6p7-integration.test.ts.
//
// This file grows in later P8 build stages (EPIC-04 onward) — do NOT
// add persistence/wiring tests here yet (later stages).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import taxonomySnapshot from './fixtures/ternary-reward-taxonomy.snapshot.json'
import { TaskDB } from '../db'
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
  aggregateCrossFamilyVerdict,
  worstMandatoryFailureSeverity,
  resolveTernaryRewardSignal,
  persistTernaryReward,
  hasTernaryReward,
  type TernaryRewardRecord,
} from '../verification/ternary-reward'
import { ALL_FAILURE_CLASSES, ALL_FAILURE_SEVERITIES } from '../verification/failure-classification'
import { ALL_CROSS_FAMILY_VERDICTS } from '../verification/cross-family-critique'
import type { PersistedCrossFamilyCritique } from '../verification/cross-family-critique'
import type { PersistedFailureClassification } from '../verification/failure-classification'

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

/** Inserts a real decisions row, returning its id (mirrors P7's insertDecision helper). */
function insertDecisionRow(db: Database, opts: { taskId?: number | null } = {}): number {
  const row = db
    .prepare(`
      INSERT INTO decisions (title, context, opened_by, task_id)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `)
    .get('p8 test decision', null, 'boss', opts.taskId === undefined ? null : opts.taskId) as { id: number }
  return row.id
}

/** Builds a TernaryRewardRecord with sane defaults, override-able per test. */
function makeRewardRecord(overrides: Partial<TernaryRewardRecord> = {}): TernaryRewardRecord {
  return {
    policy_version: 1,
    decision_id: null,
    task_id: null,
    subject_kind: 'decision',
    cross_family_verdict: null,
    failure_severity: null,
    failure_signal_available: false,
    reward: 0,
    ...overrides,
  }
}

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

// ===========================================================================
// STAGE 3 of build-p8/PLAN.md: EPIC-03 (Consume P6+P7 read-contracts,
// read-only) — ATM-011, ATM-012, ATM-014, ATM-015. ATM-013 (fixture-DB
// integration) lives in tests/ternary-reward-p6p7-integration.test.ts.
// ===========================================================================

/** Builds a PersistedCrossFamilyCritique row with sane defaults, override-able per test. */
function makeCritiqueRow(overrides: Partial<PersistedCrossFamilyCritique> = {}): PersistedCrossFamilyCritique {
  return {
    id: 1,
    decision_id: 10,
    critique_id: null,
    position_id: null,
    producer_agent: 'boss',
    producer_family: 'openai',
    critic_agent: 'steve',
    critic_family: 'anthropic',
    is_cross_family: true,
    verdict: 'concur',
    linked_failure_class: null,
    taxonomy_version: 1,
    created_at: '2026-07-08T00:00:00Z',
    ...overrides,
  }
}

/** Builds a PersistedFailureClassification row with sane defaults, override-able per test. */
function makeClassificationRow(
  overrides: Partial<PersistedFailureClassification> = {},
): PersistedFailureClassification {
  return {
    id: 1,
    taxonomy_version: 1,
    failure_class: 'verification_failure',
    severity: 'medium',
    transience: 'transient',
    domain: 'agent',
    signal_source: 'verify_check',
    source_ref: null,
    task_id: 55,
    agent: 'boss',
    summary: 'a test classification',
    raw_signal: null,
    created_at: '2026-07-08T00:00:00Z',
    ...overrides,
  } as PersistedFailureClassification
}

// ---------------------------------------------------------------------------
// ATM-011 / REQ-007 [P1] — aggregateCrossFamilyVerdict()
// ---------------------------------------------------------------------------
describe('ATM-011: aggregateCrossFamilyVerdict()', () => {
  test('ATM-011: block precedence branch', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: true, verdict: 'concur' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'block' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'dissent' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBe('block')
  })

  test('ATM-011: dissent precedence branch (no block present)', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: true, verdict: 'concur' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'dissent' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'insufficient_same_family' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBe('dissent')
  })

  test('ATM-011: concur precedence branch (no block/dissent present)', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: true, verdict: 'concur' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'insufficient_same_family' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'unknown' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBe('concur')
  })

  test('ATM-011: insufficient_same_family precedence branch', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: true, verdict: 'insufficient_same_family' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'unknown' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBe('insufficient_same_family')
  })

  test('ATM-011: unknown-only cross-family input → unknown', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: true, verdict: 'unknown' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'unknown' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBe('unknown')
  })

  test('ATM-011: anti-monoculture — same-family-only block row → null (never block)', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: false, verdict: 'block' }),
      makeCritiqueRow({ is_cross_family: false, verdict: 'dissent' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBeNull()
  })

  test('ATM-011: MIXED same-family block + cross-family concur → concur (same-family block ignored)', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: false, verdict: 'block' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'concur' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBe('concur')
  })

  test('ATM-011: MIXED same-family block + cross-family dissent → dissent', () => {
    const rows = [
      makeCritiqueRow({ is_cross_family: false, verdict: 'block' }),
      makeCritiqueRow({ is_cross_family: true, verdict: 'dissent' }),
    ]
    expect(aggregateCrossFamilyVerdict(rows)).toBe('dissent')
  })

  test('ATM-011: empty array → null', () => {
    expect(aggregateCrossFamilyVerdict([])).toBeNull()
  })

  test('ATM-011: defensive fuzz — non-array inputs never throw, return null', () => {
    const fuzz: unknown[] = [null, undefined, 42, 'block', {}, true, NaN]
    for (const f of fuzz) {
      let caught: unknown = null
      let result: unknown
      try {
        result = aggregateCrossFamilyVerdict(f as unknown as PersistedCrossFamilyCritique[])
      } catch (err) {
        caught = err
      }
      expect(caught).toBeNull()
      expect(result).toBeNull()
    }
  })

  test('ATM-011: defensive fuzz — array with null/malformed/missing-field rows never throws', () => {
    const rows = [
      null,
      undefined,
      42,
      'block',
      {},
      { is_cross_family: 'yes', verdict: 'block' }, // non-boolean is_cross_family → skipped
      { verdict: 'block' }, // missing is_cross_family → skipped
      makeCritiqueRow({ is_cross_family: true, verdict: 'concur' }), // the only genuine cross-family row
    ] as unknown as PersistedCrossFamilyCritique[]
    let caught: unknown = null
    let result: unknown
    try {
      result = aggregateCrossFamilyVerdict(rows)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeNull()
    // only the one valid cross-family concur row is considered
    expect(result).toBe('concur')
  })

  test('ATM-011: array of ONLY malformed rows → null (none considered)', () => {
    const rows = [null, {}, { is_cross_family: false, verdict: 'block' }] as unknown as PersistedCrossFamilyCritique[]
    expect(aggregateCrossFamilyVerdict(rows)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ATM-012 / REQ-008 [P1] — worstMandatoryFailureSeverity()
// ---------------------------------------------------------------------------
describe('ATM-012: worstMandatoryFailureSeverity()', () => {
  test('ATM-012: mixed low/medium/high → high', () => {
    const rows = [
      makeClassificationRow({ severity: 'low' }),
      makeClassificationRow({ severity: 'medium' }),
      makeClassificationRow({ severity: 'high' }),
    ]
    expect(worstMandatoryFailureSeverity(rows)).toBe('high')
  })

  test('ATM-012: critical + anything → critical', () => {
    const rows = [
      makeClassificationRow({ severity: 'low' }),
      makeClassificationRow({ severity: 'critical' }),
      makeClassificationRow({ severity: 'high' }),
    ]
    expect(worstMandatoryFailureSeverity(rows)).toBe('critical')
  })

  test('ATM-012: single low → low', () => {
    expect(worstMandatoryFailureSeverity([makeClassificationRow({ severity: 'low' })])).toBe('low')
  })

  test('ATM-012: empty array → null', () => {
    expect(worstMandatoryFailureSeverity([])).toBeNull()
  })

  test('ATM-012: only unrecognized severity strings → null', () => {
    const rows = [
      makeClassificationRow({ severity: 'sev_future_v2' as unknown as PersistedFailureClassification['severity'] }),
      makeClassificationRow({ severity: 'bogus' as unknown as PersistedFailureClassification['severity'] }),
    ]
    expect(worstMandatoryFailureSeverity(rows)).toBeNull()
  })

  test('ATM-012: recognized severity survives alongside unrecognized ones', () => {
    const rows = [
      makeClassificationRow({ severity: 'bogus' as unknown as PersistedFailureClassification['severity'] }),
      makeClassificationRow({ severity: 'medium' }),
    ]
    expect(worstMandatoryFailureSeverity(rows)).toBe('medium')
  })

  test('ATM-012: defensive fuzz — non-array inputs never throw, return null', () => {
    const fuzz: unknown[] = [null, undefined, 42, 'high', {}, true]
    for (const f of fuzz) {
      let caught: unknown = null
      let result: unknown
      try {
        result = worstMandatoryFailureSeverity(f as unknown as PersistedFailureClassification[])
      } catch (err) {
        caught = err
      }
      expect(caught).toBeNull()
      expect(result).toBeNull()
    }
  })

  test('ATM-012: defensive fuzz — array with null/malformed rows never throws', () => {
    const rows = [
      null,
      undefined,
      42,
      {},
      { severity: 123 },
      makeClassificationRow({ severity: 'high' }),
    ] as unknown as PersistedFailureClassification[]
    let caught: unknown = null
    let result: unknown
    try {
      result = worstMandatoryFailureSeverity(rows)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeNull()
    expect(result).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// ATM-014 / REQ-009(a) [P1] — resolveTernaryRewardSignal() runtime read-fault
// swallow. A fake db whose `.prepare()` throws for a targeted table makes the
// REAL accessor (getCrossFamilyCritiques / getFailureClassifications) throw at
// CALL time (exactly REQ-009(a)'s "missing table / query error"); the resolver
// must swallow it and treat the failed source as absent — no propagation.
// ---------------------------------------------------------------------------
describe('ATM-014: resolveTernaryRewardSignal() runtime read-fault swallow', () => {
  function fakeDb(opts: {
    throwOnCritiques?: boolean
    throwOnClassifications?: boolean
    critiqueRows?: unknown[]
    classificationRows?: unknown[]
  }): Database {
    return {
      prepare(sql: string) {
        const isCritiques = sql.includes('cross_family_critiques')
        const isClassifications = sql.includes('failure_classifications')
        if (isCritiques && opts.throwOnCritiques) throw new Error('boom: cross_family_critiques read')
        if (isClassifications && opts.throwOnClassifications) throw new Error('boom: failure_classifications read')
        return {
          all: (..._p: unknown[]) =>
            isCritiques ? (opts.critiqueRows ?? []) : isClassifications ? (opts.classificationRows ?? []) : [],
          get: (..._p: unknown[]) => null,
          run: (..._p: unknown[]) => ({}),
        }
      },
    } as unknown as Database
  }

  test('ATM-014: cross-family read throws → verdict null, no propagation; assignTernaryReward still runs', () => {
    const db = fakeDb({ throwOnCritiques: true, classificationRows: [] })
    let signal: TernaryRewardSignal | undefined
    let caught: unknown = null
    try {
      signal = resolveTernaryRewardSignal(db, 10, 55)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeNull()
    expect(signal!.cross_family_verdict).toBeNull()
    // P6 read succeeded (zero rows) → available true, severity null.
    expect(signal!.failure_signal_available).toBe(true)
    expect(signal!.failure_severity).toBeNull()
    // evaluator still runs to completion on the resolved signal.
    expect(assignTernaryReward(signal!)).toEqual({ reward: 0, policy_version: 1 })
  })

  test('ATM-014: P6 read throws → failure_signal_available=false, severity null, no propagation', () => {
    const db = fakeDb({ throwOnClassifications: true, critiqueRows: [] })
    let signal: TernaryRewardSignal | undefined
    let caught: unknown = null
    try {
      signal = resolveTernaryRewardSignal(db, 10, 55)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeNull()
    expect(signal!.failure_signal_available).toBe(false)
    expect(signal!.failure_severity).toBeNull()
    expect(assignTernaryReward(signal!)).toEqual({ reward: 0, policy_version: 1 })
  })

  test('ATM-014: BOTH reads throw → both sources absent, no propagation', () => {
    const db = fakeDb({ throwOnCritiques: true, throwOnClassifications: true })
    let signal: TernaryRewardSignal | undefined
    let caught: unknown = null
    try {
      signal = resolveTernaryRewardSignal(db, 10, 55)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeNull()
    expect(signal).toEqual({
      cross_family_verdict: null,
      failure_severity: null,
      failure_signal_available: false,
    })
  })

  test('ATM-014: null taskId → P6 not read, failure_signal_available=false (UNKNOWN, never clean)', () => {
    const db = fakeDb({ critiqueRows: [] })
    const signal = resolveTernaryRewardSignal(db, 10, null)
    expect(signal.failure_signal_available).toBe(false)
    expect(signal.failure_severity).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ATM-015 / REQ-009(b) [P1] — import-scope guardrail
// ---------------------------------------------------------------------------
describe('ATM-015: import-scope guardrail (only the two read accessors + type-only reads)', () => {
  const importLines = MODULE_SOURCE.split('\n').filter((l) => /^\s*import\b/.test(l))

  test('ATM-015: value-imports getCrossFamilyCritiques from cross-family-critique.ts', () => {
    expect(MODULE_SOURCE).toMatch(
      /import\s*\{\s*getCrossFamilyCritiques\s*\}\s*from\s*['"]\.\/cross-family-critique['"]/,
    )
  })

  test('ATM-015: value-imports getFailureClassifications from failure-classification.ts', () => {
    expect(MODULE_SOURCE).toMatch(
      /import\s*\{\s*getFailureClassifications\s*\}\s*from\s*['"]\.\/failure-classification['"]/,
    )
  })

  test('ATM-015: NO P6/P7 write symbol is imported anywhere', () => {
    const WRITE_SYMBOLS = [
      'persistCrossFamilyCritique',
      'evaluateCrossFamily',
      'resolveModelFamily',
      'resolveAgentDefaultFamily',
      'classifyFailure',
      'persistFailureClassification',
    ]
    for (const line of importLines) {
      for (const sym of WRITE_SYMBOLS) {
        expect(line).not.toContain(sym)
      }
    }
  })

  test('ATM-015: the ONLY value symbols imported from the two upstream modules are the two accessors', () => {
    // Any import line referencing an upstream module must either be an
    // `import type` (type-only) line OR value-import exactly one accessor.
    const upstreamValueImports = importLines.filter(
      (l) =>
        (l.includes('./cross-family-critique') || l.includes('./failure-classification')) &&
        !/^\s*import\s+type\b/.test(l),
    )
    for (const line of upstreamValueImports) {
      const ok =
        /import\s*\{\s*getCrossFamilyCritiques\s*\}/.test(line) ||
        /import\s*\{\s*getFailureClassifications\s*\}/.test(line)
      expect(ok).toBe(true)
    }
  })
})

// ===========================================================================
// STAGE 4 of build-p8/PLAN.md: EPIC-04 (Persistence + read predicate + audit
// atomicity) — ATM-016, ATM-017, ATM-018, ATM-019, ATM-028 (+ the ATM-025
// flag-seed precondition). These use a REAL fixture TaskDB (bun:sqlite,
// migrate()'d in its constructor); all assertions live in this P8-OWNED file
// (NOT the shared tests/db.test.ts), mirroring how P7 kept its own db
// assertions in tests/cross-family-critique.test.ts.
// ===========================================================================

// ---------------------------------------------------------------------------
// ATM-016 / REQ-010 [P1] — ternary_rewards table + 3 indexes
// ---------------------------------------------------------------------------
describe('ATM-016: ternary_rewards table + indexes (REQ-010)', () => {
  const TEST_DB = '/tmp/p8-tr-atm016.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-016: ternary_rewards has exactly the documented columns', () => {
    const columns = taskDb.run((db) => db.prepare("PRAGMA table_info('ternary_rewards')").all()) as {
      name: string
    }[]
    const columnNames = columns.map((c) => c.name).sort()
    expect(columnNames).toEqual(
      [
        'id',
        'policy_version',
        'decision_id',
        'task_id',
        'subject_kind',
        'cross_family_verdict',
        'failure_severity',
        'failure_signal_available',
        'reward',
        'created_at',
      ].sort(),
    )
  })

  test('ATM-016: failure_signal_available is NOT NULL with NO SQL default (notnull=1, dflt_value=NULL)', () => {
    const columns = taskDb.run((db) => db.prepare("PRAGMA table_info('ternary_rewards')").all()) as {
      name: string
      notnull: number
      dflt_value: string | null
    }[]
    const col = columns.find((c) => c.name === 'failure_signal_available')
    expect(col).toBeDefined()
    expect(col!.notnull).toBe(1)
    expect(col!.dflt_value).toBeNull()
  })

  test('ATM-016: reward column carries a CHECK constraint (reward IN (-1,0,1))', () => {
    const sql = taskDb.run(
      (db) =>
        (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ternary_rewards'").get() as {
          sql: string
        }).sql,
    )
    expect(sql).toMatch(/CHECK\s*\(\s*reward\s+IN\s*\(\s*-1\s*,\s*0\s*,\s*1\s*\)\s*\)/i)
  })

  test('ATM-016: 3 indexes exist covering decision_id, reward, and created_at', () => {
    const indexes = taskDb.run((db) => db.prepare("PRAGMA index_list('ternary_rewards')").all()) as {
      name: string
    }[]
    const coveredColumns = new Set<string>()
    for (const idx of indexes) {
      const infoRows = taskDb.run((db) => db.prepare(`PRAGMA index_info('${idx.name}')`).all()) as { name: string }[]
      for (const row of infoRows) coveredColumns.add(row.name)
    }
    expect(coveredColumns.has('decision_id')).toBe(true)
    expect(coveredColumns.has('reward')).toBe(true)
    expect(coveredColumns.has('created_at')).toBe(true)
  })

  test('ATM-016: existing decision/P6/P7 table schemas are UNCHANGED by this additive edit', () => {
    const cols = (name: string) =>
      (taskDb.run((db) => db.prepare(`PRAGMA table_info('${name}')`).all()) as { name: string }[]).map((c) => c.name)

    expect(cols('decisions')).toEqual([
      'id',
      'title',
      'context',
      'opened_by',
      'status',
      'finalized_by',
      'outcome',
      'outcome_rationale',
      'expires_at',
      'memory_id',
      'task_id',
      'created_at',
      'updated_at',
      'finalized_at',
    ])
    expect(cols('decision_positions')).toEqual([
      'id',
      'decision_id',
      'agent',
      'position',
      'rationale',
      'evidence',
      'created_at',
    ])
    expect(cols('decision_critiques')).toEqual([
      'id',
      'decision_id',
      'position_id',
      'agent',
      'critique',
      'severity',
      'created_at',
    ])
    expect(cols('cross_family_critiques')).toEqual([
      'id',
      'taxonomy_version',
      'decision_id',
      'critique_id',
      'position_id',
      'producer_agent',
      'producer_family',
      'critic_agent',
      'critic_family',
      'is_cross_family',
      'verdict',
      'linked_failure_class',
      'created_at',
    ])
    expect(cols('failure_classifications')).toEqual([
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
    ])
  })

  test('ATM-025 (flag-seed precondition): ternary_reward_enabled defaults to 0 (OFF) on fresh migrate()', () => {
    expect(taskDb.isFeatureEnabled('ternary_reward_enabled')).toBe(false)
    const row = taskDb.run(
      (db) => db.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'ternary_reward_enabled'").get(),
    ) as { enabled: number } | null
    expect(row).not.toBeNull()
    expect(row!.enabled).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-017 / REQ-011 [P1] — persistTernaryReward()
// ---------------------------------------------------------------------------
describe('ATM-017: persistTernaryReward() (REQ-011)', () => {
  const TEST_DB = '/tmp/p8-tr-atm017.db'
  let taskDb: TaskDB
  let decisionId: number

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('ternary_reward_enabled', true)
    decisionId = taskDb.run((db) => insertDecisionRow(db, { taskId: 501 }))
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-017: 3 sequential inserts → 3 rows, strictly increasing ids, created_at populated, full round-trip', () => {
    const ids: (number | null)[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(
        taskDb.run((db) =>
          persistTernaryReward(
            db,
            makeRewardRecord({
              decision_id: decisionId,
              task_id: 501,
              reward: (i - 1) as TernaryReward, // -1, 0, 1
              cross_family_verdict: 'concur',
              failure_severity: 'low',
              failure_signal_available: true,
            }),
          ),
        ),
      )
    }
    expect(ids.every((id) => typeof id === 'number')).toBe(true)
    expect((ids[1] as number) > (ids[0] as number)).toBe(true)
    expect((ids[2] as number) > (ids[1] as number)).toBe(true)

    const rows = taskDb.run((db) =>
      db.prepare('SELECT * FROM ternary_rewards ORDER BY id ASC').all(),
    ) as Record<string, unknown>[]
    expect(rows.length).toBe(3)
    for (const r of rows) {
      expect(r.created_at).toBeTruthy()
      expect(r.subject_kind).toBe('decision')
      expect(r.decision_id).toBe(decisionId)
      expect(r.policy_version).toBe(1)
    }
  })

  test('ATM-017: failure_signal_available is persisted EXPLICITLY as 1 (true) and 0 (false)', () => {
    taskDb.run((db) =>
      persistTernaryReward(db, makeRewardRecord({ decision_id: decisionId, failure_signal_available: true, reward: 1, cross_family_verdict: 'concur' })),
    )
    taskDb.run((db) =>
      persistTernaryReward(db, makeRewardRecord({ decision_id: decisionId, failure_signal_available: false, reward: 0 })),
    )
    const rows = taskDb.run((db) =>
      db.prepare('SELECT failure_signal_available FROM ternary_rewards ORDER BY id ASC').all(),
    ) as { failure_signal_available: number }[]
    expect(rows[0].failure_signal_available).toBe(1)
    expect(rows[1].failure_signal_available).toBe(0)
  })

  test('ATM-017: source-level — persistTernaryReward uses a LOCAL BEGIN IMMEDIATE, imports NO memory-ordering symbol, and populates failure_signal_available explicitly', () => {
    expect(MODULE_SOURCE).toMatch(/db\.prepare\(\s*['"]BEGIN IMMEDIATE['"]\s*\)\.run\(\)/)
    expect(MODULE_SOURCE).not.toContain('memory-ordering')
    expect(MODULE_SOURCE).not.toContain('withMemoryWriteTxn')
    expect(MODULE_SOURCE).not.toContain('nextWriteSeq')
    // explicit 0/1 coercion at the insert site, not a DB default
    expect(MODULE_SOURCE).toMatch(/record\.failure_signal_available\s*\?\s*1\s*:\s*0/)
  })
})

// ---------------------------------------------------------------------------
// ATM-018 / REQ-011(a) [P1] — flag gate
// ---------------------------------------------------------------------------
describe('ATM-018: persistTernaryReward() flag gate (REQ-011(a))', () => {
  const TEST_DB = '/tmp/p8-tr-atm018.db'
  let taskDb: TaskDB
  let decisionId: number

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    decisionId = taskDb.run((db) => insertDecisionRow(db, { taskId: 601 }))
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-018: flag OFF → returns null, no row inserted, no transaction', () => {
    // flag defaults to 0 (OFF) — do NOT enable.
    const id = taskDb.run((db) => persistTernaryReward(db, makeRewardRecord({ decision_id: decisionId })))
    expect(id).toBeNull()
    const count = taskDb.run(
      (db) => (db.prepare('SELECT count(*) AS n FROM ternary_rewards').get() as { n: number }).n,
    )
    expect(count).toBe(0)
  })

  test('ATM-018: flag ON → row inserted, non-null id returned', () => {
    taskDb.setFeatureFlag('ternary_reward_enabled', true)
    const id = taskDb.run((db) => persistTernaryReward(db, makeRewardRecord({ decision_id: decisionId, reward: -1, cross_family_verdict: 'block' })))
    expect(id).not.toBeNull()
    expect(typeof id).toBe('number')
    const count = taskDb.run(
      (db) => (db.prepare('SELECT count(*) AS n FROM ternary_rewards').get() as { n: number }).n,
    )
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ATM-019 / REQ-012 [P1] — hasTernaryReward()
// ---------------------------------------------------------------------------
describe('ATM-019: hasTernaryReward() (REQ-012)', () => {
  const TEST_DB = '/tmp/p8-tr-atm019.db'
  let taskDb: TaskDB
  let decisionId: number
  let otherDecisionId: number

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('ternary_reward_enabled', true)
    decisionId = taskDb.run((db) => insertDecisionRow(db, { taskId: 700 }))
    otherDecisionId = taskDb.run((db) => insertDecisionRow(db, { taskId: 701 }))
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-019: 0 rows → false; own row → true; other decision row → still false; non-existent → false', () => {
    expect(taskDb.run((db) => hasTernaryReward(db, decisionId))).toBe(false)

    taskDb.run((db) => persistTernaryReward(db, makeRewardRecord({ decision_id: decisionId, reward: 1, cross_family_verdict: 'concur', failure_signal_available: true, failure_severity: 'low' })))
    expect(taskDb.run((db) => hasTernaryReward(db, decisionId))).toBe(true)

    // a row for a DIFFERENT decision does not flip our decision's predicate
    expect(taskDb.run((db) => hasTernaryReward(db, otherDecisionId))).toBe(false)

    // a non-existent decisionId → false, no throw
    expect(taskDb.run((db) => hasTernaryReward(db, 999999))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ATM-028 / REQ-019 [P2] — audit atomicity, two-direction fault injection
// ---------------------------------------------------------------------------
describe('ATM-028: audit atomicity, two-direction fault injection (REQ-019)', () => {
  const TEST_DB = '/tmp/p8-tr-atm028.db'
  let taskDb: TaskDB
  let decisionId: number

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('ternary_reward_enabled', true)
    decisionId = taskDb.run((db) => insertDecisionRow(db, { taskId: 950 }))
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-028 (a) happy path: exactly ONE audit_log row action=ternary_reward_assigned, detail carries all 5 fields', () => {
    const id = taskDb.run((db) =>
      persistTernaryReward(
        db,
        makeRewardRecord({
          decision_id: decisionId,
          task_id: 950,
          reward: -1,
          cross_family_verdict: 'block',
          failure_severity: 'high',
          failure_signal_available: true,
        }),
      ),
    )
    expect(id).not.toBeNull()

    const auditRows = taskDb.run((db) =>
      db.prepare("SELECT * FROM audit_log WHERE action = 'ternary_reward_assigned'").all(),
    ) as Record<string, unknown>[]
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].task_id).toBe(950)

    const detail = JSON.parse(auditRows[0].detail as string)
    expect(detail.decision_id).toBe(decisionId)
    expect(detail.reward).toBe(-1)
    expect(detail.cross_family_verdict).toBe('block')
    expect(detail.failure_severity).toBe('high')
    expect(detail.failure_signal_available).toBe(true)
  })

  test('ATM-028 (b) audit direction: forcing the AUDIT insert to throw rolls back the ternary_rewards row too (0 rows), persist rethrows', () => {
    taskDb.run((db) => db.exec('ALTER TABLE audit_log RENAME TO audit_log_atm028_bak'))
    try {
      let threw = false
      try {
        taskDb.run((db) => persistTernaryReward(db, makeRewardRecord({ decision_id: decisionId, reward: 1, cross_family_verdict: 'concur', failure_signal_available: true })))
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      const count = taskDb.run(
        (db) => (db.prepare('SELECT count(*) AS n FROM ternary_rewards').get() as { n: number }).n,
      )
      expect(count).toBe(0)
    } finally {
      taskDb.run((db) => db.exec('ALTER TABLE audit_log_atm028_bak RENAME TO audit_log'))
    }
  })

  test('ATM-028 (b) ternary direction: forcing the ternary_rewards insert to throw leaves NO audit_log row', () => {
    taskDb.run((db) => db.exec('ALTER TABLE ternary_rewards RENAME TO ternary_rewards_atm028_bak'))
    try {
      let threw = false
      try {
        taskDb.run((db) => persistTernaryReward(db, makeRewardRecord({ decision_id: decisionId, reward: 1, cross_family_verdict: 'concur', failure_signal_available: true })))
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    } finally {
      taskDb.run((db) => db.exec('ALTER TABLE ternary_rewards_atm028_bak RENAME TO ternary_rewards'))
    }

    const auditRows = taskDb.run((db) =>
      db.prepare("SELECT * FROM audit_log WHERE action = 'ternary_reward_assigned'").all(),
    ) as Record<string, unknown>[]
    expect(auditRows.length).toBe(0)
  })
})
