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
import taxonomySnapshot from './fixtures/cross-family-taxonomy-snapshot.v1.json'
import {
  type ModelFamily,
  CROSS_FAMILY_TAXONOMY_VERSION,
  TAXONOMY_CHANGELOG,
  ALL_MODEL_FAMILIES,
  resolveModelFamily,
  resolveAgentDefaultFamily,
} from '../verification/cross-family-critique'

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
    ' ',
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
