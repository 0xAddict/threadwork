// tests/cross-family-critique.test.ts — P7 TDD tests.
//
// STAGE 1 of build-p7/PLAN.md: EPIC-01 (Model-Family Taxonomy & Attribution)
// ONLY — ATM-001 (canonical versioned ModelFamily), ATM-002 (append-only
// version guardrail against a committed snapshot fixture, incl. a
// non-vacuous "bite" proof), ATM-003 (table-driven resolveModelFamily()),
// ATM-004 (unknown-fallback + never-throw fuzz guard), and ATM-005
// (resolveAgentDefaultFamily() with the empty-default-registry contract).
//
// STAGE 4 (this addition, below): EPIC-04 persistence half — ATM-016
// (cross_family_critiques table + indexes), ATM-017/ATM-018
// (persistCrossFamilyCritique(), incl. the flag gate), ATM-019
// (hasCrossFamilyCritique() / requiresCrossFamilyReview() read predicates),
// and ATM-028 (audit atomicity, two-direction fault injection). The
// critique_position wiring hook (REQ-013) is a LATER stage — not tested
// here.
//
// This file grows across later P7 build stages (EPIC-05..EPIC-07) — do NOT
// add getCrossFamilyCritiques()/critique_position-wiring tests here yet
// (later stages).

import { describe, test, expect, spyOn, afterEach, beforeEach } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { TaskDB } from '../db'
import taxonomySnapshot from './fixtures/cross-family-taxonomy-snapshot.v1.json'
import {
  type ModelFamily,
  CROSS_FAMILY_TAXONOMY_VERSION,
  TAXONOMY_CHANGELOG,
  ALL_MODEL_FAMILIES,
  resolveModelFamily,
  resolveAgentDefaultFamily,
  type CrossFamilyCritique,
  type CrossFamilyEvaluation,
  type CrossFamilyVerdict,
  ALL_CROSS_FAMILY_VERDICTS,
  evaluateCrossFamily,
  isCrossFamilyReviewMandatory,
  getMandatoryCrossFamilyReviewClassifications,
  annotateWithFailureClass,
  type CrossFamilyCritiqueRecord,
  persistCrossFamilyCritique,
  hasCrossFamilyCritique,
  requiresCrossFamilyReview,
} from '../verification/cross-family-critique'
import {
  ALL_FAILURE_CLASSES,
  ALL_FAILURE_SEVERITIES,
  persistFailureClassification,
  type FailureClassification,
  type PersistedFailureClassification,
} from '../verification/failure-classification'
// Namespace import used ONLY so ATM-013 can spyOn() the live ESM binding of
// getFailureClassifications (the exact pattern proven in
// tests/memory-ordering.test.ts's "namespace + spyOn" mechanism note) — the
// module under test (cross-family-critique.ts) imports getFailureClassifications
// by name, and Bun's spyOn on this namespace object patches that same live
// binding, so the throw is observed through the real call site.
import * as failureClassificationModule from '../verification/failure-classification'

// ---------------------------------------------------------------------------
// ATM-001 / REQ-001 [P1] — Canonical versioned ModelFamily
// ---------------------------------------------------------------------------
describe('ATM-001: canonical versioned ModelFamily', () => {
  const EXPECTED_FAMILIES: ModelFamily[] = [
    'anthropic',
    'openai',
    'google',
    'meta',
    'xai',
    'deepseek',
    'mistral',
    'unknown',
  ]

  test('ATM-001: ALL_MODEL_FAMILIES has exactly 8 entries matching the literal set verbatim (in order)', () => {
    expect(ALL_MODEL_FAMILIES.length).toBe(8)
    expect([...ALL_MODEL_FAMILIES]).toEqual(EXPECTED_FAMILIES)
  })

  test('ATM-001: CROSS_FAMILY_TAXONOMY_VERSION === 1', () => {
    expect(CROSS_FAMILY_TAXONOMY_VERSION).toBe(1)
  })

  test('ATM-001: ALL_MODEL_FAMILIES is frozen', () => {
    expect(Object.isFrozen(ALL_MODEL_FAMILIES)).toBe(true)
  })

  test('ATM-001: TAXONOMY_CHANGELOG is empty at v1', () => {
    expect(TAXONOMY_CHANGELOG).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATM-002 / REQ-001(a) [P2] — Append-only version guardrail
// ---------------------------------------------------------------------------
describe('ATM-002: append-only version guardrail', () => {
  type TaxonomySnapshot = { taxonomy_version: number; families: string[] }
  const snapshot = taxonomySnapshot as TaxonomySnapshot

  test('ATM-002: committed snapshot deep-equals the live ALL_MODEL_FAMILIES + CROSS_FAMILY_TAXONOMY_VERSION', () => {
    expect(snapshot.taxonomy_version).toBe(CROSS_FAMILY_TAXONOMY_VERSION)
    expect(snapshot.families).toEqual([...ALL_MODEL_FAMILIES])
  })

  test('ATM-002: changelog length matches version, and last entry (if any) matches current version', () => {
    expect(TAXONOMY_CHANGELOG.length).toBe(CROSS_FAMILY_TAXONOMY_VERSION - 1)
    if (CROSS_FAMILY_TAXONOMY_VERSION > 1) {
      expect(TAXONOMY_CHANGELOG[TAXONOMY_CHANGELOG.length - 1]?.version).toBe(CROSS_FAMILY_TAXONOMY_VERSION)
    }
  })

  // --- Non-vacuous "bite" proof -------------------------------------------
  //
  // The two assertions above only prove the CURRENT state matches the
  // snapshot. That alone doesn't prove the guardrail would actually REJECT a
  // bad change. This helper reimplements the guardrail's decision rule
  // (family-set changed => version bump AND matching changelog entry
  // required, with append-only additions NOT exempt) and we drive it with a
  // simulated "someone appended a family without bumping the version" case
  // to prove the rule actually bites.
  function validateTaxonomyRevision(
    baselineFamilies: readonly string[],
    baselineVersion: number,
    candidateFamilies: readonly string[],
    candidateVersion: number,
    candidateChangelog: readonly { version: number; change: string }[],
  ): { ok: boolean; reason?: string } {
    const familiesChanged = JSON.stringify(baselineFamilies) !== JSON.stringify(candidateFamilies)
    if (!familiesChanged) {
      return { ok: true }
    }
    // Family set changed (even append-only) — a version bump is mandatory.
    if (candidateVersion <= baselineVersion) {
      return { ok: false, reason: 'family set changed without a CROSS_FAMILY_TAXONOMY_VERSION bump' }
    }
    // ...and a matching changelog entry for the new version is mandatory too.
    const hasMatchingEntry = candidateChangelog.some((e) => e.version === candidateVersion)
    if (!hasMatchingEntry) {
      return { ok: false, reason: 'family set changed without a matching TAXONOMY_CHANGELOG entry' }
    }
    return { ok: true }
  }

  test('ATM-002 bite-proof: the real snapshot vs live state passes validation', () => {
    const result = validateTaxonomyRevision(
      snapshot.families,
      snapshot.taxonomy_version,
      [...ALL_MODEL_FAMILIES],
      CROSS_FAMILY_TAXONOMY_VERSION,
      TAXONOMY_CHANGELOG,
    )
    expect(result.ok).toBe(true)
  })

  test('ATM-002 bite-proof: an APPEND-ONLY addition without a version bump is REJECTED (not exempt)', () => {
    const mutatedFamilies = [...snapshot.families, 'perplexity']
    const result = validateTaxonomyRevision(
      snapshot.families,
      snapshot.taxonomy_version,
      mutatedFamilies,
      snapshot.taxonomy_version, // version NOT bumped
      [], // no changelog entry
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/version bump/i)
  })

  test('ATM-002 bite-proof: a version bump WITHOUT a matching changelog entry is still REJECTED', () => {
    const mutatedFamilies = [...snapshot.families, 'perplexity']
    const result = validateTaxonomyRevision(
      snapshot.families,
      snapshot.taxonomy_version,
      mutatedFamilies,
      snapshot.taxonomy_version + 1, // bumped...
      [], // ...but no matching changelog entry
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/TAXONOMY_CHANGELOG entry/)
  })

  test('ATM-002 bite-proof: a version bump WITH a matching changelog entry is ACCEPTED', () => {
    const mutatedFamilies = [...snapshot.families, 'perplexity']
    const nextVersion = snapshot.taxonomy_version + 1
    const result = validateTaxonomyRevision(
      snapshot.families,
      snapshot.taxonomy_version,
      mutatedFamilies,
      nextVersion,
      [{ version: nextVersion, change: 'append perplexity family' }],
    )
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ATM-003 / REQ-002 [P1] — Table-driven resolveModelFamily()
// ---------------------------------------------------------------------------
describe('ATM-003: table-driven resolveModelFamily()', () => {
  const cases: [string, ModelFamily][] = [
    ['claude-opus-4-6', 'anthropic'],
    ['us.anthropic.claude-3-sonnet', 'anthropic'],
    ['gpt-5.5', 'openai'],
    ['o4-mini', 'openai'],
    ['codex-latest', 'openai'],
    ['gemini-2.5-pro', 'google'],
    ['llama-3.3-70b', 'meta'],
    ['grok-4', 'xai'],
    ['deepseek-v3', 'deepseek'],
    ['mistral-large', 'mistral'],
  ]

  for (const [modelId, expected] of cases) {
    test(`ATM-003: resolveModelFamily('${modelId}') === '${expected}'`, () => {
      expect(resolveModelFamily(modelId)).toBe(expected)
    })
  }
})

// ---------------------------------------------------------------------------
// ATM-004 / REQ-002(a) [P2] — unknown fallback + never-throw fuzz guard
// ---------------------------------------------------------------------------
describe('ATM-004: unknown fallback + never-throw fuzz guard', () => {
  test("ATM-004: resolveModelFamily(null) === 'unknown'", () => {
    expect(resolveModelFamily(null)).toBe('unknown')
  })

  test("ATM-004: resolveModelFamily(undefined) === 'unknown'", () => {
    expect(resolveModelFamily(undefined)).toBe('unknown')
  })

  test("ATM-004: resolveModelFamily('') === 'unknown'", () => {
    expect(resolveModelFamily('')).toBe('unknown')
  })

  test("ATM-004: resolveModelFamily('totally-unrecognized-vendor-x9') === 'unknown'", () => {
    expect(resolveModelFamily('totally-unrecognized-vendor-x9')).toBe('unknown')
  })

  test('ATM-004: null/undefined/empty/non-matching inputs never throw', () => {
    expect(() => resolveModelFamily(null)).not.toThrow()
    expect(() => resolveModelFamily(undefined)).not.toThrow()
    expect(() => resolveModelFamily('')).not.toThrow()
    expect(() => resolveModelFamily('totally-unrecognized-vendor-x9')).not.toThrow()
  })

  // 30-case fuzz corpus: malformed strings, numbers-as-strings, unicode
  // garbage, near-miss case variants, control chars, injection-shaped
  // strings — every one of these SHALL resolve to 'unknown' with zero
  // exceptions.
  const fuzzCorpus: string[] = [
    '12345',
    '0',
    '-1',
    '3.14159',
    'NaN',
    'undefined',
    'null',
    '   ',
    '\n\t',
    '🚀🔥💀',
    '日本語テスト',
    'اختبار عربي',
    'a'.repeat(1000),
    'CLAUDE-OPUS', // wrong case — case-sensitive table, must NOT match
    'Claude-3', // wrong case
    'GPT-4', // wrong case
    'openai-gpt-4', // does not START WITH gpt-
    'my-claude-clone', // does not START WITH claude-
    ' claude-opus', // leading whitespace defeats prefix match
    'claude', // no trailing dash/segment
    'gpt', // no trailing dash/segment
    'gemini', // no trailing dash/segment
    '<script>alert(1)</script>',
    '{"a":1}',
    'null\0byte',
    '\x00\x01\x02',
    'ANTHROPIC.CLAUDE', // wrong case
    'META-LLAMA', // wrong case
    '../../etc/passwd',
    'SELECT * FROM users',
  ]

  test(`ATM-004: 30-case fuzz corpus — every non-matching input resolves to 'unknown', zero exceptions`, () => {
    expect(fuzzCorpus.length).toBe(30)
    for (const input of fuzzCorpus) {
      let result: ModelFamily | undefined
      expect(() => {
        result = resolveModelFamily(input)
      }).not.toThrow()
      expect(result).toBe('unknown')
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-005 / REQ-003 [P2] — resolveAgentDefaultFamily()
// ---------------------------------------------------------------------------
describe('ATM-005: resolveAgentDefaultFamily()', () => {
  test("ATM-005(a): no registry argument -> resolveAgentDefaultFamily('boss') === 'unknown' (no hidden built-in map)", () => {
    expect(resolveAgentDefaultFamily('boss')).toBe('unknown')
  })

  test("ATM-005(a): no registry argument -> resolveAgentDefaultFamily('steve'/'sadie'/'kiera') === 'unknown' too", () => {
    expect(resolveAgentDefaultFamily('steve')).toBe('unknown')
    expect(resolveAgentDefaultFamily('sadie')).toBe('unknown')
    expect(resolveAgentDefaultFamily('kiera')).toBe('unknown')
  })

  test("ATM-005(b): explicit registry={boss:'anthropic'} -> ('boss') === 'anthropic', ('steve') === 'unknown'", () => {
    const registry: Readonly<Record<string, ModelFamily>> = { boss: 'anthropic' }
    expect(resolveAgentDefaultFamily('boss', registry)).toBe('anthropic')
    expect(resolveAgentDefaultFamily('steve', registry)).toBe('unknown')
  })

  test('ATM-005: never throws, incl. for empty/garbage agent names and an empty explicit registry', () => {
    expect(() => resolveAgentDefaultFamily('')).not.toThrow()
    expect(resolveAgentDefaultFamily('')).toBe('unknown')
    expect(() => resolveAgentDefaultFamily('__proto__')).not.toThrow()
    expect(resolveAgentDefaultFamily('__proto__')).toBe('unknown')
    expect(() => resolveAgentDefaultFamily('boss', {})).not.toThrow()
    expect(resolveAgentDefaultFamily('boss', {})).toBe('unknown')
  })
})

// ===========================================================================
// STAGE 2 of build-p7/PLAN.md: EPIC-02 (Cross-Family Critique Record &
// Evaluator Core) — ATM-006..ATM-010. Do NOT add EPIC-03+ tests here yet
// (later stages).
// ===========================================================================

const MODULE_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'verification', 'cross-family-critique.ts'),
  'utf8',
)
const DECISION_SOURCE = readFileSync(join(import.meta.dir, '..', 'decision.ts'), 'utf8')
const FAILURE_CLASSIFICATION_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'verification', 'failure-classification.ts'),
  'utf8',
)

// ---------------------------------------------------------------------------
// ATM-006 / REQ-004 [P1] — CrossFamilyCritique / CrossFamilyEvaluation /
// CrossFamilyVerdict (5-member closed union)
// ---------------------------------------------------------------------------
describe('ATM-006: CrossFamilyCritique / CrossFamilyEvaluation / CrossFamilyVerdict', () => {
  const KNOWN_FAMILIES: ModelFamily[] = [
    'anthropic',
    'openai',
    'google',
    'meta',
    'xai',
    'deepseek',
    'mistral',
    'unknown',
  ]

  test('ATM-006: one literal CrossFamilyCritique per family pairing type-checks and round-trips through JSON', () => {
    for (const producer_family of KNOWN_FAMILIES) {
      for (const critic_family of KNOWN_FAMILIES) {
        const literal: CrossFamilyCritique = {
          producer_family,
          critic_family,
          critic_severity: 'observation',
        }
        const roundTripped = JSON.parse(JSON.stringify(literal)) as CrossFamilyCritique
        expect(roundTripped).toEqual(literal)
      }
    }
  })

  test('ATM-006: a CrossFamilyEvaluation literal type-checks and round-trips through JSON', () => {
    const literal: CrossFamilyEvaluation = { is_cross_family: true, verdict: 'block' }
    const roundTripped = JSON.parse(JSON.stringify(literal)) as CrossFamilyEvaluation
    expect(roundTripped).toEqual(literal)
  })

  test('ATM-006: ALL_CROSS_FAMILY_VERDICTS has exactly 5 entries matching the literal set verbatim (in order)', () => {
    const EXPECTED_VERDICTS: CrossFamilyVerdict[] = [
      'concur',
      'dissent',
      'block',
      'insufficient_same_family',
      'unknown',
    ]
    expect(ALL_CROSS_FAMILY_VERDICTS.length).toBe(5)
    expect([...ALL_CROSS_FAMILY_VERDICTS]).toEqual(EXPECTED_VERDICTS)
  })

  test('ATM-006: ALL_CROSS_FAMILY_VERDICTS is frozen', () => {
    expect(Object.isFrozen(ALL_CROSS_FAMILY_VERDICTS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ATM-007 / REQ-004(a) [P2] — Distinctness guardrail
//
// OQ-3 (a) / PLAN §8 AMENDMENT A1: the LOCKED spec's ATM-007 literally
// demands "ZERO overlap as a Set" between CrossFamilyVerdict and
// FailureClass/FailureSeverity, but that is UNSATISFIABLE against shipped
// P6: P6's FailureClass includes 'unknown' and CrossFamilyVerdict also
// includes 'unknown' — both use it as an INDEPENDENT FALLBACK SENTINEL, not
// as evidence of aliasing. Boss ruled: re-scope the verifier to prove (i)
// DISTINCT-TYPE / NO-ALIASING via a source-level check, and (ii)
// NON-SENTINEL DISJOINTNESS — the Set difference after removing the shared
// 'unknown' sentinel must be empty. 'unknown' is a deliberate shared
// fallback sentinel, carved out of the disjointness check; the guardrail
// proves no type-ALIASING + non-sentinel disjointness.
// ---------------------------------------------------------------------------
describe('ATM-007: distinctness guardrail (OQ-3 (a) / PLAN §8 AMENDMENT A1)', () => {
  test('ATM-007(i): CrossFamilyVerdict is declared as its OWN literal union in cross-family-critique.ts', () => {
    expect(MODULE_SOURCE).toMatch(
      /export type CrossFamilyVerdict\s*=\s*\n?\s*\|?\s*'concur'/,
    )
  })

  test('ATM-007(i): CrossFamilyVerdict is NOT declared as an alias of CritiqueSeverity/FailureClass/FailureSeverity', () => {
    expect(MODULE_SOURCE).not.toMatch(/type\s+CrossFamilyVerdict\s*=\s*CritiqueSeverity\s*[;\n]/)
    expect(MODULE_SOURCE).not.toMatch(/type\s+CrossFamilyVerdict\s*=\s*FailureClass\s*[;\n]/)
    expect(MODULE_SOURCE).not.toMatch(/type\s+CrossFamilyVerdict\s*=\s*FailureSeverity\s*[;\n]/)
  })

  test('ATM-007(i): CrossFamilyVerdict is NOT re-exported from decision.ts or failure-classification.ts', () => {
    expect(DECISION_SOURCE).not.toMatch(/CrossFamilyVerdict/)
    expect(FAILURE_CLASSIFICATION_SOURCE).not.toMatch(/CrossFamilyVerdict/)
  })

  test('ATM-007(ii): non-sentinel disjointness — (ALL_CROSS_FAMILY_VERDICTS \\ {unknown}) has ZERO intersection with CritiqueSeverity values ∪ ALL_FAILURE_CLASSES ∪ ALL_FAILURE_SEVERITIES', () => {
    // CritiqueSeverity's literal values, hardcoded here since decision.ts
    // exports CritiqueSeverity as a TYPE with no runtime array.
    const CRITIQUE_SEVERITY_VALUES = ['observation', 'concern', 'blocker']

    const verdictsMinusSentinel = new Set(ALL_CROSS_FAMILY_VERDICTS)
    verdictsMinusSentinel.delete('unknown')

    const otherUniverse = new Set<string>([
      ...CRITIQUE_SEVERITY_VALUES,
      ...ALL_FAILURE_CLASSES,
      ...ALL_FAILURE_SEVERITIES,
    ])

    const intersection = [...verdictsMinusSentinel].filter((v) => otherUniverse.has(v))
    expect(intersection).toEqual([])
  })

  test('ATM-007(ii): the shared "unknown" sentinel IS present on both sides (proving the carve-out is non-vacuous)', () => {
    expect(ALL_CROSS_FAMILY_VERDICTS).toContain('unknown')
    expect(ALL_FAILURE_CLASSES).toContain('unknown')
  })
})

// ---------------------------------------------------------------------------
// ATM-008 / REQ-005 [P1] — evaluateCrossFamily(): 9-row authoritative
// decision table
// ---------------------------------------------------------------------------
describe('ATM-008: evaluateCrossFamily() — 9-row authoritative decision table', () => {
  test('row 1: same known family (X===Y, X!=unknown) -> {false, insufficient_same_family}', () => {
    const result = evaluateCrossFamily({
      producer_family: 'anthropic',
      critic_family: 'anthropic',
      critic_severity: 'blocker',
    })
    expect(result).toEqual({ is_cross_family: false, verdict: 'insufficient_same_family' })
  })

  test("row 2: producer 'unknown', critic known Y -> {false, unknown}", () => {
    const result = evaluateCrossFamily({
      producer_family: 'unknown',
      critic_family: 'openai',
      critic_severity: 'blocker',
    })
    expect(result).toEqual({ is_cross_family: false, verdict: 'unknown' })
  })

  test("row 3: producer known X, critic 'unknown' -> {false, unknown}", () => {
    const result = evaluateCrossFamily({
      producer_family: 'anthropic',
      critic_family: 'unknown',
      critic_severity: 'blocker',
    })
    expect(result).toEqual({ is_cross_family: false, verdict: 'unknown' })
  })

  test("row 4: both 'unknown' -> {false, unknown}", () => {
    const result = evaluateCrossFamily({
      producer_family: 'unknown',
      critic_family: 'unknown',
      critic_severity: 'blocker',
    })
    expect(result).toEqual({ is_cross_family: false, verdict: 'unknown' })
  })

  test("row 5: cross-family, severity='blocker' -> {true, block}", () => {
    const result = evaluateCrossFamily({
      producer_family: 'anthropic',
      critic_family: 'openai',
      critic_severity: 'blocker',
    })
    expect(result).toEqual({ is_cross_family: true, verdict: 'block' })
  })

  test("row 6: cross-family, severity='concern' -> {true, dissent}", () => {
    const result = evaluateCrossFamily({
      producer_family: 'anthropic',
      critic_family: 'openai',
      critic_severity: 'concern',
    })
    expect(result).toEqual({ is_cross_family: true, verdict: 'dissent' })
  })

  test("row 7: cross-family, severity='observation' -> {true, concur}", () => {
    const result = evaluateCrossFamily({
      producer_family: 'anthropic',
      critic_family: 'openai',
      critic_severity: 'observation',
    })
    expect(result).toEqual({ is_cross_family: true, verdict: 'concur' })
  })

  test('row 8: cross-family, severity=null (missing) -> {true, unknown}', () => {
    const result = evaluateCrossFamily({
      producer_family: 'anthropic',
      critic_family: 'openai',
      critic_severity: null,
    })
    expect(result).toEqual({ is_cross_family: true, verdict: 'unknown' })
  })

  test('row 9: cross-family, severity=malformed/invalid string -> {true, unknown}', () => {
    const result = evaluateCrossFamily({
      producer_family: 'anthropic',
      critic_family: 'openai',
      critic_severity: 'not-a-real-severity' as unknown as CrossFamilyCritique['critic_severity'],
    })
    expect(result).toEqual({ is_cross_family: true, verdict: 'unknown' })
  })

  test('is_cross_family formula sanity: true IFF critic!=producer AND neither is unknown, across ALL family pairs', () => {
    const FAMILIES: ModelFamily[] = [
      'anthropic',
      'openai',
      'google',
      'meta',
      'xai',
      'deepseek',
      'mistral',
      'unknown',
    ]
    for (const producer_family of FAMILIES) {
      for (const critic_family of FAMILIES) {
        const expected = critic_family !== producer_family && critic_family !== 'unknown' && producer_family !== 'unknown'
        const result = evaluateCrossFamily({ producer_family, critic_family, critic_severity: 'blocker' })
        expect(result.is_cross_family).toBe(expected)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-009 / REQ-006 [P1] — Purity + idempotency proof
// ---------------------------------------------------------------------------
describe('ATM-009: purity + idempotency proof', () => {
  test('two calls with byte-identical input produce a full deep-equal result', () => {
    const input: CrossFamilyCritique = {
      producer_family: 'anthropic',
      critic_family: 'openai',
      critic_severity: 'concern',
    }
    const first = evaluateCrossFamily(input)
    const second = evaluateCrossFamily(input)
    expect(first).toEqual(second)
    expect(first).toEqual({ is_cross_family: true, verdict: 'dissent' })
  })

  test('source-level check: evaluateCrossFamily body contains no Date/Date.now/performance.now/datetime(/Math.random', () => {
    const match = MODULE_SOURCE.match(
      /export function evaluateCrossFamily\([\s\S]*?\n\}\n/,
    )
    expect(match).not.toBeNull()
    const body = match ? match[0] : ''
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toMatch(/\bDate\.now\b/)
    expect(body).not.toMatch(/\bnew Date\b/)
    expect(body).not.toMatch(/\bperformance\.now\b/)
    expect(body).not.toMatch(/datetime\(/)
    expect(body).not.toMatch(/Math\.random/)
  })
})

// ---------------------------------------------------------------------------
// ATM-010 / REQ-006(a) [P2] — Never-throw fuzz guard
// ---------------------------------------------------------------------------
describe('ATM-010: never-throw fuzz guard — malformed/missing/unexpected-type inputs', () => {
  // A circular-reference object with NO producer_family/critic_family keys at
  // all — self-referential, so it also proves no infinite loop/stack
  // overflow, while still deterministically resolving to the unknown
  // fallback (producer_family/critic_family are simply absent -> invalid).
  function makeCircular(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    return obj
  }

  // Every entry below is malformed strictly per REQ-006(a): either the whole
  // input is not a plain object, or producer_family/critic_family is missing,
  // wrong-typed, or a string outside the closed 8-member ModelFamily set.
  // Each therefore has exactly ONE deterministic outcome: {false, 'unknown'}.
  const malformedInputs: unknown[] = [
    null, // 1
    undefined, // 2
    {}, // 3 — no producer_family/critic_family at all
    [], // 4 — array, not a critique record
    'a string', // 5 — not an object
    42, // 6 — not an object
    true, // 7 — not an object
    false, // 8 — not an object
    { producer_family: 'anthropic' }, // 9 — missing critic_family entirely
    { critic_family: 'openai' }, // 10 — missing producer_family entirely
    { producer_family: 123, critic_family: 'openai', critic_severity: 'blocker' }, // 11 — wrong type
    { producer_family: 'anthropic', critic_family: 123, critic_severity: 'blocker' }, // 12 — wrong type
    { producer_family: null, critic_family: 'openai', critic_severity: 'blocker' }, // 13
    { producer_family: 'anthropic', critic_family: null, critic_severity: 'blocker' }, // 14
    { producer_family: undefined, critic_family: 'openai', critic_severity: 'blocker' }, // 15
    { producer_family: 'anthropic', critic_family: undefined, critic_severity: 'blocker' }, // 16
    { producer_family: 'openai-vendor-x', critic_family: 'openai', critic_severity: 'blocker' }, // 17 — outside 8-member set
    { producer_family: 'ANTHROPIC', critic_family: 'openai', critic_severity: 'blocker' }, // 18 — wrong case
    { producer_family: 'anthropic', critic_family: 'grok', critic_severity: 'blocker' }, // 19 — 'grok' not 'xai'
    { producer_family: 'anthropic', critic_family: 'GROK', critic_severity: 'blocker' }, // 20 — wrong case
    { producer_family: [], critic_family: 'openai', critic_severity: 'blocker' }, // 21
    { producer_family: {}, critic_family: 'openai', critic_severity: 'blocker' }, // 22
    { producer_family: 'anthropic', critic_family: [], critic_severity: 'blocker' }, // 23
    { producer_family: 'anthropic', critic_family: {}, critic_severity: 'blocker' }, // 24
    { producer_family: '', critic_family: 'openai', critic_severity: 'blocker' }, // 25 — empty string
    { producer_family: 'anthropic', critic_family: '', critic_severity: 'blocker' }, // 26 — empty string
    { producer_family: ' anthropic', critic_family: 'openai', critic_severity: 'blocker' }, // 27 — leading space
    { producer_family: 'anthropic', critic_family: 'openai ', critic_severity: 'blocker' }, // 28 — trailing space
    { producer_family: 'anthropic-2', critic_family: 'openai', critic_severity: 'blocker' }, // 29 — near-miss suffix
    { producer_family: 'anthropic', critic_family: 'openai2', critic_severity: 'blocker' }, // 30 — near-miss suffix
    'not-an-object-at-all', // 31
    0, // 32
    -1, // 33
    NaN, // 34
    Symbol('x'), // 35 — typeof 'symbol', not 'object'
    () => {}, // 36 — typeof 'function', not 'object'
    new Date(), // 37 — object but no producer_family/critic_family
    /regex/, // 38 — object but no producer_family/critic_family
    new Map(), // 39 — object but no producer_family/critic_family
    makeCircular(), // 40 — circular self-reference, no producer_family/critic_family
  ]

  test('40 programmatically-generated malformed inputs each -> {is_cross_family:false, verdict:"unknown"}, zero exceptions across all 40', () => {
    expect(malformedInputs.length).toBe(40)
    let exceptions = 0
    for (const input of malformedInputs) {
      let result: CrossFamilyEvaluation | undefined
      try {
        result = evaluateCrossFamily(input as unknown as CrossFamilyCritique)
      } catch {
        exceptions++
        continue
      }
      expect(result).toEqual({ is_cross_family: false, verdict: 'unknown' })
    }
    expect(exceptions).toBe(0)
  })

  test('never-throw is also proven via expect(...).not.toThrow() per input', () => {
    for (const input of malformedInputs) {
      expect(() => evaluateCrossFamily(input as unknown as CrossFamilyCritique)).not.toThrow()
    }
  })
})

// ===========================================================================
// STAGE 3 of build-p7/PLAN.md: EPIC-03 (Consume P6 Failure Classifications,
// read-only) — ATM-011..ATM-015. Do NOT add EPIC-04+ tests here yet (later
// stages). See tests/cross-family-critique-p6-integration.test.ts for
// ATM-012's fixture-DB integration test.
// ===========================================================================

/** Builds a well-formed synthetic PersistedFailureClassification, override-able per test. */
function makePersistedClassification(
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
    source_ref: 'chk-1',
    task_id: 1,
    agent: 'boss',
    summary: 'a synthetic classification',
    raw_signal: { source: 'verify_check', checkResultId: 'chk-1' },
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ATM-011 / REQ-007 [P1] — isCrossFamilyReviewMandatory()
// ---------------------------------------------------------------------------
describe('ATM-011: isCrossFamilyReviewMandatory() (REQ-007)', () => {
  test("failure_class='correctness_adversarial_finding' -> true", () => {
    const c = makePersistedClassification({ failure_class: 'correctness_adversarial_finding', severity: 'low' })
    expect(isCrossFamilyReviewMandatory(c)).toBe(true)
  })

  test("severity='high' -> true", () => {
    const c = makePersistedClassification({ failure_class: 'test_failure', severity: 'high' })
    expect(isCrossFamilyReviewMandatory(c)).toBe(true)
  })

  test("severity='critical' -> true", () => {
    const c = makePersistedClassification({ failure_class: 'test_failure', severity: 'critical' })
    expect(isCrossFamilyReviewMandatory(c)).toBe(true)
  })

  test("severity='medium' + failure_class='verification_failure' -> false", () => {
    const c = makePersistedClassification({ failure_class: 'verification_failure', severity: 'medium' })
    expect(isCrossFamilyReviewMandatory(c)).toBe(false)
  })

  test("severity='low' (non-adversarial failure_class) -> false", () => {
    const c = makePersistedClassification({ failure_class: 'blocked_dependency', severity: 'low' })
    expect(isCrossFamilyReviewMandatory(c)).toBe(false)
  })

  test('never throws for a well-formed input', () => {
    expect(() => isCrossFamilyReviewMandatory(makePersistedClassification())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ATM-013 / REQ-008(a) [P1] — Error-swallow fault injection
// ---------------------------------------------------------------------------
describe('ATM-013: getMandatoryCrossFamilyReviewClassifications() error-swallow (REQ-008(a))', () => {
  let throwSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    throwSpy?.mockRestore()
    throwSpy = undefined
  })

  test('getFailureClassifications() throwing -> returns [], no exception propagates', () => {
    throwSpy = spyOn(failureClassificationModule, 'getFailureClassifications').mockImplementation(() => {
      throw new Error('simulated P6 read failure')
    })

    const fakeDb = {} as Database
    let result: PersistedFailureClassification[] | undefined
    expect(() => {
      result = getMandatoryCrossFamilyReviewClassifications(fakeDb)
    }).not.toThrow()
    expect(result).toEqual([])
    expect(throwSpy).toHaveBeenCalled()
  })

  test('getFailureClassifications() throwing (with a filter argument) -> still returns [], no exception propagates', () => {
    throwSpy = spyOn(failureClassificationModule, 'getFailureClassifications').mockImplementation(() => {
      throw new Error('simulated P6 read failure')
    })

    const fakeDb = {} as Database
    const result = getMandatoryCrossFamilyReviewClassifications(fakeDb, { taskId: 42 })
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATM-014 / REQ-009 [P2] — annotateWithFailureClass()
// ---------------------------------------------------------------------------
describe('ATM-014: annotateWithFailureClass() (REQ-009)', () => {
  test('(a) 2-element input, first row failure_class=correctness_adversarial_finding -> returns that exact string', () => {
    const classifications = [
      makePersistedClassification({ id: 1, failure_class: 'correctness_adversarial_finding' }),
      makePersistedClassification({ id: 2, failure_class: 'test_failure' }),
    ]
    expect(annotateWithFailureClass(classifications)).toBe('correctness_adversarial_finding')
  })

  test('(b) first row has an UNRECOGNIZED failure_class -> returns it UNCHANGED, not coerced to unknown', () => {
    const classifications = [
      makePersistedClassification({ id: 1, failure_class: 'future_class_v2' }),
      makePersistedClassification({ id: 2, failure_class: 'test_failure' }),
    ]
    expect(annotateWithFailureClass(classifications)).toBe('future_class_v2')
  })

  test('(c) empty array input -> returns null', () => {
    expect(annotateWithFailureClass([])).toBeNull()
  })

  test('never throws', () => {
    expect(() => annotateWithFailureClass([])).not.toThrow()
    expect(() => annotateWithFailureClass([makePersistedClassification()])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ATM-015 / REQ-008 [P1] — Scope-guard: EPIC-03 imports ONLY
// getFailureClassifications (+ read types) from P6; zero lines of
// failure-classification.ts are edited by P7.
// ---------------------------------------------------------------------------
describe('ATM-015: EPIC-03 scope-guard (source-grep based)', () => {
  test('the ONLY value imported from ./failure-classification in cross-family-critique.ts is getFailureClassifications', () => {
    // Matches every `import { ... } from './failure-classification'` (value
    // import) statement and every `import type { ... } from
    // './failure-classification'` (type-only import) statement separately,
    // so a value import accidentally smuggling in a second symbol is caught.
    const valueImportMatches = [
      ...MODULE_SOURCE.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/failure-classification'/gm),
    ]
    expect(valueImportMatches.length).toBe(1)
    const importedValueNames = valueImportMatches[0]![1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    expect(importedValueNames).toEqual(['getFailureClassifications'])
  })

  test('the type-only import from ./failure-classification carries exactly FailureClass, FailureSeverity, PersistedFailureClassification', () => {
    const typeImportMatches = [
      ...MODULE_SOURCE.matchAll(/^import\s+type\s*\{([^}]*)\}\s*from\s*'\.\/failure-classification'/gm),
    ]
    expect(typeImportMatches.length).toBe(1)
    const importedTypeNames = typeImportMatches[0]![1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort()
    expect(importedTypeNames).toEqual(['FailureClass', 'FailureSeverity', 'PersistedFailureClassification'].sort())
  })

  test('cross-family-critique.ts does NOT define or re-export classifyFailure or persistFailureClassification (P6 write-path symbols)', () => {
    expect(MODULE_SOURCE).not.toMatch(/\bclassifyFailure\b/)
    expect(MODULE_SOURCE).not.toMatch(/\bpersistFailureClassification\b/)
  })

  test('cross-family-critique.ts imports no other value symbol from failure-classification.ts beyond getFailureClassifications', () => {
    // Every import line whose source is './failure-classification' must
    // either be a `import type { ... }` line, or a bare `import {
    // getFailureClassifications } from './failure-classification'` value
    // line — nothing else.
    const allImportLines = MODULE_SOURCE
      .split('\n')
      .filter((line) => line.includes("from './failure-classification'"))
    expect(allImportLines.length).toBe(2)
    const valueLines = allImportLines.filter((line) => !line.trim().startsWith('import type'))
    expect(valueLines.length).toBe(1)
    expect(valueLines[0]).toMatch(/^import\s*\{\s*getFailureClassifications\s*\}\s*from/)
  })

  test('failure-classification.ts itself has zero P7 touch: no CrossFamily* symbol appears in it (diff-scan proxy)', () => {
    expect(FAILURE_CLASSIFICATION_SOURCE).not.toMatch(/CrossFamily/)
    expect(FAILURE_CLASSIFICATION_SOURCE).not.toMatch(/isCrossFamilyReviewMandatory/)
    expect(FAILURE_CLASSIFICATION_SOURCE).not.toMatch(/getMandatoryCrossFamilyReviewClassifications/)
    expect(FAILURE_CLASSIFICATION_SOURCE).not.toMatch(/annotateWithFailureClass/)
  })
})

// ===========================================================================
// STAGE 4 of build-p7/PLAN.md: EPIC-04 (Critique State-Machine Integration,
// persistence half) — ATM-016 (table+indexes), ATM-017/ATM-018
// (persistCrossFamilyCritique(), incl. flag gate), ATM-019
// (hasCrossFamilyCritique() / requiresCrossFamilyReview() read predicates),
// and ATM-028 (audit atomicity, two-direction fault injection). The
// critique_position wiring hook (REQ-013) is a LATER stage — not tested
// here.
// ===========================================================================

/** Removes a sqlite db file plus its -shm/-wal sidecars, tolerating "doesn't exist". */
function wipeDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch { /* doesn't exist yet */ }
  }
}

/**
 * Inserts a decisions row DIRECTLY (bypassing DecisionDB, which requires a
 * MemoryDB collaborator this test file has no reason to construct) so the
 * cross_family_critiques FK + task_id lookups this stage's persist/read
 * functions depend on have something real to resolve against. Mirrors the
 * house pattern (tests/cross-family-critique-p6-integration.test.ts inserts
 * failure_classifications rows via P6's own persist function; here we insert
 * the decisions row directly since DecisionDB isn't in scope for this stage).
 */
function insertDecision(db: Database, opts: { taskId?: number | null; openedBy?: string; title?: string } = {}): number {
  const row = db
    .prepare(`
      INSERT INTO decisions (title, context, opened_by, task_id)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `)
    .get(
      opts.title ?? 'test decision',
      null,
      opts.openedBy ?? 'boss',
      opts.taskId === undefined ? null : opts.taskId,
    ) as { id: number }
  return row.id
}

/** Builds a CrossFamilyCritiqueRecord literal with sane defaults, override-able per test. */
function makeCrossFamilyCritiqueRecord(overrides: Partial<CrossFamilyCritiqueRecord> = {}): CrossFamilyCritiqueRecord {
  return {
    decision_id: 1,
    critique_id: null,
    position_id: null,
    producer_agent: 'boss',
    producer_family: 'openai',
    critic_agent: 'steve',
    critic_family: 'anthropic',
    is_cross_family: true,
    verdict: 'block',
    linked_failure_class: null,
    ...overrides,
  }
}

/** Builds a FailureClassification literal with sane defaults. Mirrors
 * tests/failure-classification.test.ts's own makeFailureClassification()
 * helper — duplicated locally so this file has no test-time coupling to
 * that file. */
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
// ATM-016 / REQ-010 [P1] — cross_family_critiques table + 3 indexes
// ---------------------------------------------------------------------------
describe('ATM-016: cross_family_critiques table + indexes (REQ-010)', () => {
  const TEST_DB = '/tmp/p7-cfc-atm016.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-016: cross_family_critiques has exactly the documented columns', () => {
    const columns = taskDb.run(db => db.prepare("PRAGMA table_info('cross_family_critiques')").all()) as { name: string }[]
    const columnNames = columns.map(c => c.name).sort()
    expect(columnNames).toEqual(
      [
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
      ].sort()
    )
  })

  test('ATM-016: 3 indexes exist covering decision_id, verdict, and created_at', () => {
    const indexes = taskDb.run(db => db.prepare("PRAGMA index_list('cross_family_critiques')").all()) as { name: string }[]
    expect(indexes.length).toBeGreaterThanOrEqual(3)

    const coveredColumns = new Set<string>()
    for (const idx of indexes) {
      const infoRows = taskDb.run(db => db.prepare(`PRAGMA index_info('${idx.name}')`).all()) as { name: string }[]
      for (const row of infoRows) coveredColumns.add(row.name)
    }
    expect(coveredColumns.has('decision_id')).toBe(true)
    expect(coveredColumns.has('verdict')).toBe(true)
    expect(coveredColumns.has('created_at')).toBe(true)
  })

  test('ATM-016: decisions/decision_positions/decision_critiques PRAGMA table_info are unchanged by this edit', () => {
    const decisionsCols = (
      taskDb.run(db => db.prepare("PRAGMA table_info('decisions')").all()) as { name: string }[]
    ).map(c => c.name)
    expect(decisionsCols).toEqual([
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

    const positionsCols = (
      taskDb.run(db => db.prepare("PRAGMA table_info('decision_positions')").all()) as { name: string }[]
    ).map(c => c.name)
    expect(positionsCols).toEqual(['id', 'decision_id', 'agent', 'position', 'rationale', 'evidence', 'created_at'])

    const critiquesCols = (
      taskDb.run(db => db.prepare("PRAGMA table_info('decision_critiques')").all()) as { name: string }[]
    ).map(c => c.name)
    expect(critiquesCols).toEqual(['id', 'decision_id', 'position_id', 'agent', 'critique', 'severity', 'created_at'])
  })

  test('ATM-016: re-running migrate() (fresh TaskDB against the same file) is idempotent — no error, same schema', () => {
    expect(() => new TaskDB(TEST_DB)).not.toThrow()
    const columns = taskDb.run(db => db.prepare("PRAGMA table_info('cross_family_critiques')").all()) as { name: string }[]
    expect(columns.length).toBe(13)
  })

  test('ATM-016 (flag-seed precondition): cross_family_critique_enabled defaults to 0 (OFF) on fresh migrate()', () => {
    expect(taskDb.isFeatureEnabled('cross_family_critique_enabled')).toBe(false)
    const row = taskDb.run(db => db.prepare(
      "SELECT enabled FROM feature_flags WHERE flag_name = 'cross_family_critique_enabled'"
    ).get()) as { enabled: number } | null
    expect(row).not.toBeNull()
    expect(row!.enabled).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-017 / REQ-011 [P1] — persistCrossFamilyCritique()
// ---------------------------------------------------------------------------
describe('ATM-017: persistCrossFamilyCritique() (REQ-011)', () => {
  const TEST_DB = '/tmp/p7-cfc-atm017.db'
  let taskDb: TaskDB
  let decisionId: number

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('cross_family_critique_enabled', true)
    decisionId = taskDb.run(db => insertDecision(db, { taskId: 501 }))
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-017: 3 sequential inserts (flag ON) -> 3 rows, strictly increasing ids, created_at populated, every field round-trips', () => {
    const records: CrossFamilyCritiqueRecord[] = [
      makeCrossFamilyCritiqueRecord({
        decision_id: decisionId,
        critique_id: 10,
        producer_agent: 'a1',
        producer_family: 'openai',
        critic_agent: 'c1',
        critic_family: 'anthropic',
        is_cross_family: true,
        verdict: 'block',
        linked_failure_class: 'correctness_adversarial_finding',
      }),
      makeCrossFamilyCritiqueRecord({
        decision_id: decisionId,
        critique_id: 11,
        position_id: 5,
        producer_agent: 'a2',
        producer_family: 'anthropic',
        critic_agent: 'c2',
        critic_family: 'anthropic',
        is_cross_family: false,
        verdict: 'insufficient_same_family',
        linked_failure_class: null,
      }),
      makeCrossFamilyCritiqueRecord({
        decision_id: decisionId,
        critique_id: null,
        producer_agent: 'a3',
        producer_family: 'unknown',
        critic_agent: 'c3',
        critic_family: 'unknown',
        is_cross_family: false,
        verdict: 'unknown',
        linked_failure_class: null,
      }),
    ]

    const ids: number[] = []
    for (const record of records) {
      const id = taskDb.run(db => persistCrossFamilyCritique(db, record))
      expect(id).not.toBeNull()
      ids.push(id as number)
    }

    expect(ids[1]).toBeGreaterThan(ids[0]!)
    expect(ids[2]).toBeGreaterThan(ids[1]!)

    const rows = taskDb.run(db => db.prepare('SELECT * FROM cross_family_critiques ORDER BY id ASC').all()) as any[]
    expect(rows.length).toBe(3)

    rows.forEach((row, i) => {
      const record = records[i]!
      expect(row.id).toBe(ids[i])
      expect(typeof row.created_at).toBe('string')
      expect(row.created_at.length).toBeGreaterThan(0)
      expect(row.taxonomy_version).toBe(CROSS_FAMILY_TAXONOMY_VERSION)
      expect(row.decision_id).toBe(record.decision_id)
      expect(row.critique_id).toBe(record.critique_id)
      expect(row.position_id).toBe(record.position_id)
      expect(row.producer_agent).toBe(record.producer_agent)
      expect(row.producer_family).toBe(record.producer_family)
      expect(row.critic_agent).toBe(record.critic_agent)
      expect(row.critic_family).toBe(record.critic_family)
      expect(row.is_cross_family).toBe(record.is_cross_family ? 1 : 0)
      expect(row.verdict).toBe(record.verdict)
      expect(row.linked_failure_class).toBe(record.linked_failure_class)
    })
  })

  test('ATM-017: source-level — persistCrossFamilyCritique uses a LOCAL BEGIN IMMEDIATE, and the module imports no memory-ordering.ts symbol', () => {
    const modulePath = join(import.meta.dir, '..', 'verification', 'cross-family-critique.ts')
    const source = readFileSync(modulePath, 'utf8')

    const marker = 'export function persistCrossFamilyCritique'
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
// ATM-018 / REQ-011(a) [P1] — flag gate
// ---------------------------------------------------------------------------
describe('ATM-018: flag gate (REQ-011(a))', () => {
  const TEST_DB = '/tmp/p7-cfc-atm018.db'
  let taskDb: TaskDB
  let decisionId: number

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    decisionId = taskDb.run(db => insertDecision(db, { taskId: 502 }))
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-018: flag OFF (default) -> persist returns null, row count stays 0, and no BEGIN IMMEDIATE transaction is ever prepared', () => {
    expect(taskDb.isFeatureEnabled('cross_family_critique_enabled')).toBe(false)

    let sawBeginImmediate = false
    taskDb.run(db => {
      const spy = spyOn(db, 'prepare')
      const id = persistCrossFamilyCritique(db, makeCrossFamilyCritiqueRecord({ decision_id: decisionId }))
      expect(id).toBeNull()
      sawBeginImmediate = spy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('BEGIN IMMEDIATE'))
      spy.mockRestore()
    })
    expect(sawBeginImmediate).toBe(false)

    const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM cross_family_critiques').get() as { n: number }).n)
    expect(count).toBe(0)
  })

  test('ATM-018: flag ON -> row inserted, non-null numeric id returned', () => {
    taskDb.setFeatureFlag('cross_family_critique_enabled', true)
    const id = taskDb.run(db => persistCrossFamilyCritique(db, makeCrossFamilyCritiqueRecord({ decision_id: decisionId })))
    expect(id).not.toBeNull()
    expect(typeof id).toBe('number')

    const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM cross_family_critiques').get() as { n: number }).n)
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ATM-019 / REQ-012 [P1] — hasCrossFamilyCritique() / requiresCrossFamilyReview()
// ---------------------------------------------------------------------------
describe('ATM-019: hasCrossFamilyCritique() / requiresCrossFamilyReview() read predicates (REQ-012)', () => {
  const TEST_DB = '/tmp/p7-cfc-atm019.db'
  let taskDb: TaskDB

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('cross_family_critique_enabled', true)
    taskDb.setFeatureFlag('failure_classification_enabled', true)
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('(a) [Codex #1] hasCrossFamilyCritique: 0 rows -> false; is_cross_family=0 row -> STILL false; is_cross_family=1 row -> true', () => {
    const decisionId = taskDb.run(db => insertDecision(db, { taskId: 900 }))

    expect(taskDb.run(db => hasCrossFamilyCritique(db, decisionId))).toBe(false)

    taskDb.run(db =>
      persistCrossFamilyCritique(
        db,
        makeCrossFamilyCritiqueRecord({
          decision_id: decisionId,
          is_cross_family: false,
          verdict: 'insufficient_same_family',
          producer_family: 'anthropic',
          critic_family: 'anthropic',
        }),
      ),
    )
    expect(taskDb.run(db => hasCrossFamilyCritique(db, decisionId))).toBe(false)

    taskDb.run(db =>
      persistCrossFamilyCritique(
        db,
        makeCrossFamilyCritiqueRecord({
          decision_id: decisionId,
          is_cross_family: true,
          verdict: 'block',
          producer_family: 'openai',
          critic_family: 'anthropic',
        }),
      ),
    )
    expect(taskDb.run(db => hasCrossFamilyCritique(db, decisionId))).toBe(true)
  })

  test('(b) [Codex #2] requiresCrossFamilyReview: mandatory classification + 0 qualifying rows -> true; after an is_cross_family=1 persist -> false', () => {
    const TASK_ID = 901
    const decisionId = taskDb.run(db => insertDecision(db, { taskId: TASK_ID }))

    taskDb.run(db =>
      persistFailureClassification(
        db,
        makeFailureClassification({ task_id: TASK_ID, failure_class: 'correctness_adversarial_finding', severity: 'high' }),
      ),
    )

    expect(taskDb.run(db => requiresCrossFamilyReview(db, decisionId))).toBe(true)

    taskDb.run(db =>
      persistCrossFamilyCritique(
        db,
        makeCrossFamilyCritiqueRecord({
          decision_id: decisionId,
          is_cross_family: true,
          verdict: 'block',
          producer_family: 'openai',
          critic_family: 'anthropic',
        }),
      ),
    )

    expect(taskDb.run(db => requiresCrossFamilyReview(db, decisionId))).toBe(false)
  })

  test('(b) requiresCrossFamilyReview: persisting an is_cross_family=0 row does NOT flip it to false (still true)', () => {
    const TASK_ID = 902
    const decisionId = taskDb.run(db => insertDecision(db, { taskId: TASK_ID }))

    taskDb.run(db =>
      persistFailureClassification(
        db,
        makeFailureClassification({ task_id: TASK_ID, failure_class: 'unknown', severity: 'critical' }),
      ),
    )

    expect(taskDb.run(db => requiresCrossFamilyReview(db, decisionId))).toBe(true)

    taskDb.run(db =>
      persistCrossFamilyCritique(
        db,
        makeCrossFamilyCritiqueRecord({
          decision_id: decisionId,
          is_cross_family: false,
          verdict: 'insufficient_same_family',
          producer_family: 'anthropic',
          critic_family: 'anthropic',
        }),
      ),
    )

    expect(taskDb.run(db => requiresCrossFamilyReview(db, decisionId))).toBe(true)
  })

  test('(c) requiresCrossFamilyReview: decision with task_id=null -> false, no throw', () => {
    const decisionId = taskDb.run(db => insertDecision(db, { taskId: null }))
    expect(() => taskDb.run(db => requiresCrossFamilyReview(db, decisionId))).not.toThrow()
    expect(taskDb.run(db => requiresCrossFamilyReview(db, decisionId))).toBe(false)
  })

  test('(d) [Codex iter-2 LOW] non-existent decisionId -> both predicates false, no throw', () => {
    const NON_EXISTENT_ID = 999999
    expect(() => taskDb.run(db => hasCrossFamilyCritique(db, NON_EXISTENT_ID))).not.toThrow()
    expect(taskDb.run(db => hasCrossFamilyCritique(db, NON_EXISTENT_ID))).toBe(false)
    expect(() => taskDb.run(db => requiresCrossFamilyReview(db, NON_EXISTENT_ID))).not.toThrow()
    expect(taskDb.run(db => requiresCrossFamilyReview(db, NON_EXISTENT_ID))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ATM-028 / REQ-019 [P2] — audit atomicity, two-direction fault injection
// ---------------------------------------------------------------------------
describe('ATM-028: audit atomicity, two-direction fault injection (REQ-019)', () => {
  const TEST_DB = '/tmp/p7-cfc-atm028.db'
  let taskDb: TaskDB
  let decisionId: number

  beforeEach(() => {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('cross_family_critique_enabled', true)
    decisionId = taskDb.run(db => insertDecision(db, { taskId: 950 }))
  })
  afterEach(() => wipeDbFile(TEST_DB))

  test('(a) happy path: persisting a record produces exactly ONE audit_log row action=cross_family_critique_recorded, detail contains decision_id/producer_family/critic_family/verdict', () => {
    const record = makeCrossFamilyCritiqueRecord({
      decision_id: decisionId,
      producer_family: 'openai',
      critic_family: 'anthropic',
      verdict: 'block',
      critic_agent: 'steve',
    })
    const id = taskDb.run(db => persistCrossFamilyCritique(db, record))
    expect(id).not.toBeNull()

    const auditRows = taskDb.run(db =>
      db.prepare("SELECT * FROM audit_log WHERE action = 'cross_family_critique_recorded'").all(),
    ) as any[]
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].agent).toBe('steve')
    expect(auditRows[0].task_id).toBe(950)

    const detail = JSON.parse(auditRows[0].detail)
    expect(detail.decision_id).toBe(decisionId)
    expect(detail.producer_family).toBe('openai')
    expect(detail.critic_family).toBe('anthropic')
    expect(detail.verdict).toBe('block')
  })

  test('(b) fault-injection (audit direction): forcing the AUDIT insert to throw (audit_log renamed away) rolls back the cross_family_critiques row too — 0 rows, persist rethrows', () => {
    taskDb.run(db => db.exec('ALTER TABLE audit_log RENAME TO audit_log_atm028_bak'))
    try {
      let threw = false
      let thrownErr: unknown = null
      try {
        taskDb.run(db => persistCrossFamilyCritique(db, makeCrossFamilyCritiqueRecord({ decision_id: decisionId })))
      } catch (err) {
        threw = true
        thrownErr = err
      }
      expect(threw).toBe(true)
      expect(thrownErr).not.toBeNull()

      const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM cross_family_critiques').get() as { n: number }).n)
      expect(count).toBe(0)
    } finally {
      taskDb.run(db => db.exec('ALTER TABLE audit_log_atm028_bak RENAME TO audit_log'))
    }
  })

  test('(b) fault-injection (cross_family_critiques direction): forcing the INSERT to throw (cross_family_critiques renamed away) leaves NO audit_log row with action=cross_family_critique_recorded', () => {
    taskDb.run(db => db.exec('ALTER TABLE cross_family_critiques RENAME TO cross_family_critiques_atm028_bak'))
    try {
      let threw = false
      try {
        taskDb.run(db => persistCrossFamilyCritique(db, makeCrossFamilyCritiqueRecord({ decision_id: decisionId })))
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    } finally {
      taskDb.run(db => db.exec('ALTER TABLE cross_family_critiques_atm028_bak RENAME TO cross_family_critiques'))
    }

    const auditRows = taskDb.run(db =>
      db.prepare("SELECT * FROM audit_log WHERE action = 'cross_family_critique_recorded'").all(),
    ) as any[]
    expect(auditRows.length).toBe(0)
  })
})
