// tests/cross-family-critique.test.ts — P7 TDD tests.
//
// STAGE 1 of build-p7/PLAN.md: EPIC-01 (Model-Family Taxonomy & Attribution)
// ONLY — ATM-001 (canonical versioned ModelFamily), ATM-002 (append-only
// version guardrail against a committed snapshot fixture, incl. a
// non-vacuous "bite" proof), ATM-003 (table-driven resolveModelFamily()),
// ATM-004 (unknown-fallback + never-throw fuzz guard), and ATM-005
// (resolveAgentDefaultFamily() with the empty-default-registry contract).
//
// This file grows across later P7 build stages (EPIC-02..EPIC-07) — for now
// it holds ONLY EPIC-01 tests. Do NOT add evaluateCrossFamily / P6 adapter /
// persistence / getCrossFamilyCritiques tests here yet (later stages).

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
} from '../verification/cross-family-critique'
import { ALL_FAILURE_CLASSES, ALL_FAILURE_SEVERITIES } from '../verification/failure-classification'

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
