// verification/cross-family-critique.ts — P7 Cross-Family Critique module.
//
// STAGE 1 of build-p7/PLAN.md: EPIC-01 (Model-Family Taxonomy & Attribution)
// — the ModelFamily union + CROSS_FAMILY_TAXONOMY_VERSION +
// TAXONOMY_CHANGELOG + frozen ALL_MODEL_FAMILIES array (REQ-001), the pure
// table-driven resolveModelFamily() (REQ-002), and the pure
// resolveAgentDefaultFamily() (REQ-003).
//
// STAGE 2 (this addition, below): EPIC-02 (Cross-Family Critique Record &
// Evaluator Core) — the CrossFamilyCritique/CrossFamilyEvaluation record
// types, the closed 5-member CrossFamilyVerdict union (REQ-004), and the
// pure, deterministic, table-driven evaluateCrossFamily() (REQ-005/REQ-006).
//
// Later stages add the P6 read-only adapter (EPIC-03), persistence
// (EPIC-04), and the getCrossFamilyCritiques() P8 read contract (EPIC-05) —
// none of that is implemented here. See specs/P7-spec.md.

// decision.ts's CritiqueSeverity is imported as a TYPE ONLY (erased at
// compile time — zero runtime dependency) — REQ-004(a): referenced here
// exclusively as a typed INPUT FIELD on CrossFamilyCritique, never
// redefined, aliased, or re-exported.
import type { CritiqueSeverity } from '../decision'

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

// ---------------------------------------------------------------------------
// ATM-006 / REQ-004 [P1] — CrossFamilyCritique / CrossFamilyEvaluation /
// CrossFamilyVerdict (5-member closed union)
// ---------------------------------------------------------------------------

/**
 * Input record to evaluateCrossFamily(): an already-resolved producer/critic
 * family pair plus the critique's existing CritiqueSeverity (decision.ts:5),
 * referenced here as a TYPED INPUT FIELD only — read/passed through, never
 * redefined, aliased, or re-exported (REQ-004(a)).
 */
export interface CrossFamilyCritique {
  producer_family: ModelFamily
  critic_family: ModelFamily
  critic_severity: CritiqueSeverity | null
}

/** Output record produced by evaluateCrossFamily(). */
export interface CrossFamilyEvaluation {
  is_cross_family: boolean
  verdict: CrossFamilyVerdict
}

/**
 * The closed cross-family critique verdict union — a type DISTINCT from
 * decision.ts's CritiqueSeverity and from P6's FailureClass/FailureSeverity
 * (REQ-004(a)). See the ATM-007 guardrail test for the non-aliasing +
 * non-sentinel-disjointness proof; 'unknown' is a deliberate shared fallback
 * sentinel with FailureClass's own 'unknown' member, carved out of that
 * disjointness check per OQ-3 (a) / PLAN §8 AMENDMENT A1 — it is NOT evidence
 * of aliasing.
 */
export type CrossFamilyVerdict =
  | 'concur'
  | 'dissent'
  | 'block'
  | 'insufficient_same_family'
  | 'unknown'

// Runtime mirror of the CrossFamilyVerdict union, in the same order as
// declared above. `satisfies readonly CrossFamilyVerdict[]` plus the
// bidirectional exhaustiveness check below ensure this tuple and the
// CrossFamilyVerdict union can never silently drift apart — mirrors the
// ALL_MODEL_FAMILIES / ALL_FAILURE_CLASSES exhaustiveness-guard pattern used
// elsewhere in this file and in verification/failure-classification.ts.
const _crossFamilyVerdictsTuple = [
  'concur',
  'dissent',
  'block',
  'insufficient_same_family',
  'unknown',
] as const satisfies readonly CrossFamilyVerdict[]

type _CrossFamilyVerdictTupleMember = (typeof _crossFamilyVerdictsTuple)[number]
type _CrossFamilyVerdictExhaustive = [CrossFamilyVerdict] extends [_CrossFamilyVerdictTupleMember]
  ? [_CrossFamilyVerdictTupleMember] extends [CrossFamilyVerdict]
    ? true
    : ['ALL_CROSS_FAMILY_VERDICTS has member(s) not in the CrossFamilyVerdict union']
  : ['CrossFamilyVerdict union has member(s) missing from ALL_CROSS_FAMILY_VERDICTS']
const _crossFamilyVerdictExhaustive: _CrossFamilyVerdictExhaustive = true
void _crossFamilyVerdictExhaustive

export const ALL_CROSS_FAMILY_VERDICTS: readonly CrossFamilyVerdict[] = Object.freeze(
  _crossFamilyVerdictsTuple,
)

// ---------------------------------------------------------------------------
// ATM-008/009/010 / REQ-005/REQ-006 [P1/P2] — evaluateCrossFamily()
// ---------------------------------------------------------------------------

/** The 3 valid CritiqueSeverity literal values, used for defensive runtime validation. */
const _VALID_CRITIQUE_SEVERITIES: ReadonlySet<string> = new Set(['observation', 'concern', 'blocker'])

function _isKnownModelFamily(value: unknown): value is ModelFamily {
  return typeof value === 'string' && (ALL_MODEL_FAMILIES as readonly string[]).includes(value)
}

function _isValidCritiqueSeverity(value: unknown): value is CritiqueSeverity {
  return typeof value === 'string' && _VALID_CRITIQUE_SEVERITIES.has(value)
}

/** The single, unconditional fallback result for any malformed/unrecognized input (REQ-006(a)). */
const _UNKNOWN_FALLBACK: CrossFamilyEvaluation = Object.freeze({
  is_cross_family: false,
  verdict: 'unknown',
})

/**
 * The single chokepoint computing whether a critique is cross-family and
 * what its verdict is — a deterministic, PURE, table-driven mapping over the
 * 9-row authoritative decision table (REQ-005). `is_cross_family` is `true`
 * IFF `critic_family !== producer_family && critic_family !== 'unknown' &&
 * producer_family !== 'unknown'`. NO I/O, NO randomness, NO wall-clock read
 * (no Date/Date.now/performance.now/Math.random), NO side effects.
 *
 * IDEMPOTENT + referentially transparent (REQ-006): two calls with
 * byte-identical input produce byte-identical output. NEVER throws
 * (REQ-006(a)): any malformed, missing, or unexpected-type field (a
 * producer_family/critic_family outside ModelFamily, a non-object input,
 * null/undefined, a circular-reference object, etc.) falls back to
 * `{is_cross_family: false, verdict: 'unknown'}`.
 */
export function evaluateCrossFamily(input: CrossFamilyCritique): CrossFamilyEvaluation {
  try {
    if (input === null || typeof input !== 'object') {
      return _UNKNOWN_FALLBACK
    }

    const raw = input as { producer_family?: unknown; critic_family?: unknown; critic_severity?: unknown }
    const producerFamilyRaw = raw.producer_family
    const criticFamilyRaw = raw.critic_family
    const criticSeverityRaw = raw.critic_severity

    if (!_isKnownModelFamily(producerFamilyRaw) || !_isKnownModelFamily(criticFamilyRaw)) {
      return _UNKNOWN_FALLBACK
    }
    const producerFamily: ModelFamily = producerFamilyRaw
    const criticFamily: ModelFamily = criticFamilyRaw

    const isCrossFamily =
      criticFamily !== producerFamily && criticFamily !== 'unknown' && producerFamily !== 'unknown'

    if (!isCrossFamily) {
      // Row 1: both KNOWN and the SAME family -> 'insufficient_same_family'.
      // Rows 2-4: either side is 'unknown' -> 'unknown'. (If neither side is
      // 'unknown' and they're not cross-family, they must be equal — row 1.)
      if (producerFamily !== 'unknown' && criticFamily !== 'unknown' && producerFamily === criticFamily) {
        return { is_cross_family: false, verdict: 'insufficient_same_family' }
      }
      return { is_cross_family: false, verdict: 'unknown' }
    }

    // is_cross_family === true from here on (rows 5-9).
    if (criticSeverityRaw === null || criticSeverityRaw === undefined) {
      // Row 8: severity null/missing -> 'unknown'.
      return { is_cross_family: true, verdict: 'unknown' }
    }
    if (!_isValidCritiqueSeverity(criticSeverityRaw)) {
      // Row 9: malformed/invalid severity string (or any other bad type) -> 'unknown'.
      return { is_cross_family: true, verdict: 'unknown' }
    }
    switch (criticSeverityRaw) {
      case 'blocker':
        return { is_cross_family: true, verdict: 'block' } // Row 5
      case 'concern':
        return { is_cross_family: true, verdict: 'dissent' } // Row 6
      case 'observation':
        return { is_cross_family: true, verdict: 'concur' } // Row 7
    }
    // Unreachable given _isValidCritiqueSeverity's narrowing above; kept as an
    // explicit defensive fallback so the function always returns and TS's
    // control-flow analysis sees a terminating statement on every path.
    return { is_cross_family: true, verdict: 'unknown' }
  } catch {
    // Defensive catch-all: any unexpected throw (e.g. a hostile getter on a
    // malformed input) falls back to the same unknown result, never
    // propagating (REQ-006(a)).
    return _UNKNOWN_FALLBACK
  }
}
