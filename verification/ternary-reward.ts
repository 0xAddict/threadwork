// verification/ternary-reward.ts — P8 ternary rewards.
//
// GREENFIELD module. Terminal rung of the verification axis
// (P6 typed failure classification -> P7 cross-family critique -> P8
// ternary rewards). See PLAN.md / P8-spec.md for the full contract.
//
// P8 does NOT touch decision.ts, failure-classification.ts, or
// cross-family-critique.ts — see PLAN.md Overlap boundaries.
//
// EPIC-02 (below) imports CrossFamilyVerdict/FailureSeverity as TYPE-ONLY
// (ATM-007) — these are TYPED INPUT FIELDS only (read/passed through, never
// redefined/aliased/re-exported). This module never imports a P6/P7 VALUE
// symbol at this stage (EPIC-03's read accessors are a later stage).
import type { CrossFamilyVerdict } from './cross-family-critique'
import type { FailureSeverity } from './failure-classification'

// ---------------------------------------------------------------------------
// EPIC-01 / REQ-001, REQ-002, REQ-003 (ATM-001..005) — TernaryReward
// vocabulary & versioned policy taxonomy.
// ---------------------------------------------------------------------------

/**
 * The closed, numeric ternary reward vocabulary.
 * -1 = negative, 0 = neutral, 1 = positive.
 *
 * DISTINCT from decision.ts's CritiqueSeverity (string union), P6's
 * FailureClass/FailureSeverity (string unions), and P7's CrossFamilyVerdict
 * (string union) — this module references those three as TYPED INPUT FIELDS
 * only (see TernaryRewardSignal, EPIC-02) and never redefines, aliases,
 * re-exports, or shares a literal-value set with any of them (REQ-003).
 */
export type TernaryReward = -1 | 0 | 1

/** Frozen named-value map mirroring TernaryReward (REQ-001). */
export const TernaryRewardValue = Object.freeze({
  NEGATIVE: -1,
  NEUTRAL: 0,
  POSITIVE: 1,
} as const)

/** Frozen runtime array mirroring the TernaryReward type-level union (REQ-001). */
export const ALL_TERNARY_REWARDS: readonly TernaryReward[] = Object.freeze([-1, 0, 1])

/**
 * Taxonomy schema version. Bump on ANY change to the TernaryReward member
 * set OR the TERNARY_REWARD_DECISION_TABLE mapping below (REQ-002(a)); pair
 * every bump with a new TAXONOMY_CHANGELOG entry.
 */
export const TERNARY_REWARD_TAXONOMY_VERSION: number = 1

/** Append-only changelog of taxonomy-version bumps. Empty at v1 (REQ-002). */
export const TAXONOMY_CHANGELOG: { version: number; change: string }[] = []

// ---------------------------------------------------------------------------
// EPIC-02 / REQ-005 (ATM-003, ATM-008) — the 5-row authoritative,
// precedence-ordered decision table, encoded as serializable DATA so it can
// be (a) pinned by the ATM-003 append-only snapshot guardrail (Stage 1) and
// (b) consumed directly by assignTernaryReward() (Stage 2) as the single
// table-driven source of truth — no duplicated literal precedence logic.
//
// Each row's `match` clause is a set of OPTIONAL field->allowed-values
// constraints; an omitted field is a wildcard (matches any value for that
// field). Rows are evaluated IN ARRAY ORDER; the FIRST row whose `match`
// clause is fully satisfied wins (REQ-005's precedence-ordered mandate).
// Row 5 has an empty `match` object — it matches unconditionally, the
// required terminal neutral default.
// ---------------------------------------------------------------------------

export interface TernaryRewardDecisionRow {
  readonly row: number
  readonly reward: TernaryReward
  readonly match: {
    readonly cross_family_verdict?: readonly (string | null)[]
    readonly failure_severity?: readonly (string | null)[]
    readonly failure_signal_available?: readonly boolean[]
  }
}

export const TERNARY_REWARD_DECISION_TABLE: readonly TernaryRewardDecisionRow[] = Object.freeze([
  Object.freeze({
    row: 1,
    reward: -1 as TernaryReward,
    match: Object.freeze({ cross_family_verdict: Object.freeze(['block']) }),
  }),
  Object.freeze({
    row: 2,
    reward: -1 as TernaryReward,
    match: Object.freeze({ failure_severity: Object.freeze(['critical', 'high']) }),
  }),
  Object.freeze({
    row: 3,
    reward: 1 as TernaryReward,
    match: Object.freeze({
      cross_family_verdict: Object.freeze(['concur']),
      failure_signal_available: Object.freeze([true]),
      failure_severity: Object.freeze([null, 'low']),
    }),
  }),
  Object.freeze({
    row: 4,
    reward: 0 as TernaryReward,
    match: Object.freeze({ cross_family_verdict: Object.freeze(['dissent']) }),
  }),
  Object.freeze({
    row: 5,
    reward: 0 as TernaryReward,
    match: Object.freeze({}),
  }),
])

// ---------------------------------------------------------------------------
// EPIC-02 / REQ-004, REQ-005, REQ-006 (ATM-006..010) — Pure reward
// evaluator core.
// ---------------------------------------------------------------------------

/**
 * Resolved input signal for `assignTernaryReward()`. `cross_family_verdict`
 * and `failure_severity` reference P7's `CrossFamilyVerdict` and P6's
 * `FailureSeverity` as TYPED INPUT FIELDS ONLY (REQ-004(a)) — widened to
 * `| string | null` for forward-compat pass-through, exactly as P7's own
 * `CrossFamilyCritique.critic_severity` types decision.ts's `CritiqueSeverity`.
 *
 * `failure_signal_available` disambiguates the two meanings of a `null`
 * `failure_severity`: `true` after a successful P6 read (including zero
 * rows -> "read OK, no mandatory failure"); `false` when the read errored or
 * the subject has no `task_id` (-> severity UNKNOWN, NEVER treated as clean)
 * (REQ-004(b)).
 */
export interface TernaryRewardSignal {
  cross_family_verdict: CrossFamilyVerdict | string | null
  failure_severity: FailureSeverity | string | null
  failure_signal_available: boolean
}

/** Output of `assignTernaryReward()` — the assigned reward plus the policy version that produced it. */
export interface TernaryRewardAssessment {
  reward: TernaryReward
  policy_version: number
}

/**
 * Match a single decision-table row against a normalized, defensively-typed
 * signal. An omitted `match` field is a wildcard. Never throws (all
 * comparisons are simple `Array.prototype.includes` membership checks).
 */
function rowMatches(
  row: TernaryRewardDecisionRow,
  verdict: unknown,
  severity: unknown,
  available: boolean,
): boolean {
  const m = row.match
  if (m.cross_family_verdict !== undefined) {
    if (!(m.cross_family_verdict as readonly unknown[]).includes(verdict)) return false
  }
  if (m.failure_severity !== undefined) {
    if (!(m.failure_severity as readonly unknown[]).includes(severity)) return false
  }
  if (m.failure_signal_available !== undefined) {
    if (!(m.failure_signal_available as readonly unknown[]).includes(available)) return false
  }
  return true
}

/**
 * assignTernaryReward() — the single chokepoint mapping a resolved
 * `TernaryRewardSignal` to a `TernaryRewardAssessment` via the 5-row
 * authoritative, precedence-ordered (first-match-wins)
 * TERNARY_REWARD_DECISION_TABLE (REQ-005). PURE, deterministic,
 * idempotent (REQ-006): no I/O, no randomness, no wall-clock read, no side
 * effects. NEVER throws — any malformed/missing/unexpected-type field
 * (including a non-object input) resolves to the row-5 neutral fallback
 * `{reward: 0, policy_version: TERNARY_REWARD_TAXONOMY_VERSION}`
 * (REQ-006(a)). A missing/non-boolean `failure_signal_available` is treated
 * as `false` — NEVER as a clean signal — so row 3's `+1` can only ever fire
 * when the caller explicitly asserts a successfully-read signal.
 */
export function assignTernaryReward(signal: TernaryRewardSignal): TernaryRewardAssessment {
  try {
    const raw: unknown = signal
    if (raw === null || typeof raw !== 'object') {
      return { reward: 0, policy_version: TERNARY_REWARD_TAXONOMY_VERSION }
    }
    const s = raw as Record<string, unknown>
    const verdict = 'cross_family_verdict' in s ? s.cross_family_verdict : undefined
    const severity = 'failure_severity' in s ? s.failure_severity : undefined
    const available = typeof s.failure_signal_available === 'boolean' ? s.failure_signal_available : false

    for (const row of TERNARY_REWARD_DECISION_TABLE) {
      if (rowMatches(row, verdict, severity, available)) {
        return { reward: row.reward, policy_version: TERNARY_REWARD_TAXONOMY_VERSION }
      }
    }
    // Unreachable in practice (row 5's empty match is an unconditional
    // catch-all) — kept as a structural never-throw backstop.
    return { reward: 0, policy_version: TERNARY_REWARD_TAXONOMY_VERSION }
  } catch {
    return { reward: 0, policy_version: TERNARY_REWARD_TAXONOMY_VERSION }
  }
}
