// verification/cross-family-critique.ts — P7 Cross-Family Critique module.
//
// STAGE 1 of build-p7/PLAN.md: EPIC-01 (Model-Family Taxonomy & Attribution)
// ONLY — the ModelFamily union + CROSS_FAMILY_TAXONOMY_VERSION +
// TAXONOMY_CHANGELOG + frozen ALL_MODEL_FAMILIES array (REQ-001), the pure
// table-driven resolveModelFamily() (REQ-002), and the pure
// resolveAgentDefaultFamily() (REQ-003). Later stages add
// evaluateCrossFamily() (EPIC-02), the P6 read-only adapter (EPIC-03),
// persistence (EPIC-04), and the getCrossFamilyCritiques() P8 read contract
// (EPIC-05) — none of that is implemented here. See specs/P7-spec.md.

// ---------------------------------------------------------------------------
// ATM-001 / REQ-001 [P1] — Canonical versioned ModelFamily
// ---------------------------------------------------------------------------

/**
 * The canonical, closed-but-extensible model-family taxonomy. Append-only:
 * see TAXONOMY_CHANGELOG and the ATM-002 guardrail — ANY change to this
 * member set, including an append-only addition, requires bumping
 * CROSS_FAMILY_TAXONOMY_VERSION and adding a matching TAXONOMY_CHANGELOG
 * entry (a rename/removal additionally requires a documented migration note
 * in that same changelog entry).
 */
export type ModelFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'meta'
  | 'xai'
  | 'deepseek'
  | 'mistral'
  | 'unknown'

/**
 * Taxonomy schema version. Bump on ANY change to the ModelFamily member set
 * (append-only additions are NOT exempt) and add a matching
 * TAXONOMY_CHANGELOG entry. Enforced by the ATM-002 guardrail test against
 * tests/fixtures/cross-family-taxonomy-snapshot.v1.json.
 */
export const CROSS_FAMILY_TAXONOMY_VERSION: number = 1

/** Append-only changelog of taxonomy version bumps. Empty at v1. */
export const TAXONOMY_CHANGELOG: { version: number; change: string }[] = []

// Runtime mirror of the ModelFamily union, in the same order as declared
// above. `satisfies readonly ModelFamily[]` plus the bidirectional
// exhaustiveness check below ensure this tuple and the ModelFamily union can
// never silently drift apart — adding a member to one without the other
// breaks `_modelFamilyExhaustive`'s assignment at compile time (G1). Mirrors
// verification/failure-classification.ts's ALL_FAILURE_CLASSES pattern
// (lines ~58-84 there).
const _modelFamiliesTuple = [
  'anthropic',
  'openai',
  'google',
  'meta',
  'xai',
  'deepseek',
  'mistral',
  'unknown',
] as const satisfies readonly ModelFamily[]

type _ModelFamilyTupleMember = (typeof _modelFamiliesTuple)[number]
type _ModelFamilyExhaustive = [ModelFamily] extends [_ModelFamilyTupleMember]
  ? [_ModelFamilyTupleMember] extends [ModelFamily]
    ? true
    : ['ALL_MODEL_FAMILIES has member(s) not in the ModelFamily union']
  : ['ModelFamily union has member(s) missing from ALL_MODEL_FAMILIES']
const _modelFamilyExhaustive: _ModelFamilyExhaustive = true
void _modelFamilyExhaustive

export const ALL_MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze(_modelFamiliesTuple)

// ---------------------------------------------------------------------------
// ATM-003/004 / REQ-002 [P1/P2] — resolveModelFamily()
// ---------------------------------------------------------------------------

/** One row of the table-driven prefix/pattern match resolveModelFamily() encodes. */
interface _FamilyRule {
  test: (modelId: string) => boolean
  family: ModelFamily
}

const _FAMILY_RULES: readonly _FamilyRule[] = [
  {
    test: (m) => m.startsWith('claude-') || m.startsWith('anthropic.') || m.startsWith('us.anthropic.'),
    family: 'anthropic',
  },
  {
    test: (m) =>
      m.startsWith('gpt-') ||
      m.startsWith('o3') ||
      m.startsWith('o4') ||
      m.startsWith('codex') ||
      m.startsWith('chatgpt'),
    family: 'openai',
  },
  { test: (m) => m.startsWith('gemini-'), family: 'google' },
  { test: (m) => m.startsWith('llama-') || m.startsWith('meta-llama'), family: 'meta' },
  { test: (m) => m.startsWith('grok-'), family: 'xai' },
  { test: (m) => m.startsWith('deepseek-'), family: 'deepseek' },
  { test: (m) => m.startsWith('mistral-') || m.startsWith('mixtral-'), family: 'mistral' },
]

/**
 * Pure, synchronous, table-driven resolver from a raw model identifier to its
 * ModelFamily — REQ-002's authoritative mapping: `claude-*`/`anthropic.*`/
 * `us.anthropic.*` -> 'anthropic'; `gpt-*`/`o3*`/`o4*`/`codex*`/`chatgpt*` ->
 * 'openai'; `gemini-*` -> 'google'; `llama-*`/`meta-llama*` -> 'meta';
 * `grok-*` -> 'xai'; `deepseek-*` -> 'deepseek'; `mistral-*`/`mixtral-*` ->
 * 'mistral'. NO I/O, NO Date/Date.now/performance.now/Math.random, NO side
 * effects. null/undefined/empty-string/non-matching input -> 'unknown', and
 * this function NEVER throws.
 */
export function resolveModelFamily(modelId: string | null | undefined): ModelFamily {
  if (typeof modelId !== 'string' || modelId.length === 0) return 'unknown'
  for (const rule of _FAMILY_RULES) {
    try {
      if (rule.test(modelId)) return rule.family
    } catch {
      // Defensive only — no rule above can actually throw on a string input.
      // Never propagate: fall through to the next rule / unknown fallback.
    }
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// ATM-005 / REQ-003 [P2] — resolveAgentDefaultFamily()
// ---------------------------------------------------------------------------

/**
 * The default registry used when resolveAgentDefaultFamily() is called with
 * no explicit `registry` argument: a FROZEN EMPTY object, NOT a hidden
 * built-in agent->family map — so absent explicit configuration, every agent
 * name resolves to 'unknown'.
 */
const _EMPTY_AGENT_FAMILY_REGISTRY: Readonly<Record<string, ModelFamily>> = Object.freeze({})

/**
 * Pure resolver from an agent name to its default ModelFamily via an
 * explicit registry. Returns `registry[agent]` when that key is present on
 * the effective registry. Absent a `registry` argument, defaults to the
 * frozen EMPTY registry above (no hidden built-in map). Returns 'unknown'
 * when `agent` is not a key of the effective registry. Never throws.
 */
export function resolveAgentDefaultFamily(
  agent: string,
  registry?: Readonly<Record<string, ModelFamily>>,
): ModelFamily {
  const effective = registry ?? _EMPTY_AGENT_FAMILY_REGISTRY
  if (effective != null && Object.prototype.hasOwnProperty.call(effective, agent)) {
    const value = effective[agent]
    if (value !== undefined) return value
  }
  return 'unknown'
}
