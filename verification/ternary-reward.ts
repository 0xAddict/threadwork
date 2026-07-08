// verification/ternary-reward.ts — P8 ternary rewards.
//
// GREENFIELD module. Terminal rung of the verification axis
// (P6 typed failure classification -> P7 cross-family critique -> P8
// ternary rewards). See PLAN.md / P8-spec.md for the full contract.
//
// P8 does NOT touch decision.ts, failure-classification.ts, or
// cross-family-critique.ts — see PLAN.md Overlap boundaries.

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
