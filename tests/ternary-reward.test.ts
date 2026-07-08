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
// This file grows in later P8 build stages (EPIC-02 onward) — do NOT
// add pure-evaluator tests here yet in Stage 1 (added in Stage 2).

import { describe, test, expect } from 'bun:test'
import taxonomySnapshot from './fixtures/ternary-reward-taxonomy.snapshot.json'
import {
  TernaryReward,
  TernaryRewardValue,
  ALL_TERNARY_REWARDS,
  TERNARY_REWARD_TAXONOMY_VERSION,
  TAXONOMY_CHANGELOG,
  TERNARY_REWARD_DECISION_TABLE,
  type TernaryRewardDecisionRow,
} from '../verification/ternary-reward'
import { ALL_FAILURE_CLASSES, ALL_FAILURE_SEVERITIES } from '../verification/failure-classification'
import { ALL_CROSS_FAMILY_VERDICTS } from '../verification/cross-family-critique'

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
