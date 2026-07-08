// verification/ternary-reward.ts — P8 ternary rewards.
//
// GREENFIELD module. Terminal rung of the verification axis
// (P6 typed failure classification -> P7 cross-family critique -> P8
// ternary rewards). See PLAN.md / P8-spec.md for the full contract.
//
// P8 does NOT touch decision.ts, failure-classification.ts, or
// cross-family-critique.ts — see PLAN.md Overlap boundaries.
//
// EPIC-02 imports CrossFamilyVerdict/FailureSeverity as TYPE-ONLY (ATM-007)
// — these are TYPED INPUT FIELDS only (read/passed through, never
// redefined/aliased/re-exported). EPIC-03 additionally reads back the two
// upstream PERSISTED row types (also type-only) and VALUE-imports EXACTLY the
// two read accessors `getCrossFamilyCritiques`/`getFailureClassifications`
// (and NO write symbol — ATM-015/ATM-030). The type-only imports are kept in
// dedicated `import type` statements so ATM-007's type-only guardrail holds,
// while the two accessors come in via separate value imports.
import type { Database } from 'bun:sqlite'
import type { CrossFamilyVerdict, PersistedCrossFamilyCritique } from './cross-family-critique'
import { getCrossFamilyCritiques } from './cross-family-critique'
import type { FailureSeverity, PersistedFailureClassification } from './failure-classification'
import { getFailureClassifications } from './failure-classification'

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

// ---------------------------------------------------------------------------
// EPIC-03 / REQ-007, REQ-008, REQ-009 (ATM-011..015) — Read-only adapters
// that fold P7's raw per-critique rows and P6's raw per-classification rows
// into the single TernaryRewardSignal shape assignTernaryReward() consumes.
//
// The two folds (aggregateCrossFamilyVerdict / worstMandatoryFailureSeverity)
// are PURE — they take the ALREADY-READ arrays and never touch a db handle.
// The db threads ONLY through resolveTernaryRewardSignal() (the resolver the
// EPIC-04 finalize hook reuses), which calls the two accessors and swallows a
// RUNTIME call-throw per REQ-009(a). This module touches ZERO lines of
// cross-family-critique.ts / failure-classification.ts (ATM-015/ATM-030).
// ---------------------------------------------------------------------------

/**
 * ATM-011 / REQ-007 — Fold P7's per-critique rows into ONE cross-family
 * verdict by monotone precedence, CONSIDERING ONLY rows with
 * `is_cross_family === true` (the anti-monoculture gate: a same-family row
 * NEVER by itself drives a block/dissent/concur result). Precedence:
 * block > dissent > concur > insufficient_same_family > else 'unknown'.
 * Returns `null` IF the input is empty OR contains no cross-family row.
 * Defensively treats a non-array input as empty and SKIPS each
 * malformed/`null` row — NEVER throws (REQ-007(b)).
 */
export function aggregateCrossFamilyVerdict(
  critiques: PersistedCrossFamilyCritique[],
): CrossFamilyVerdict | null {
  try {
    if (!Array.isArray(critiques)) return null
    const considered = critiques.filter(
      (c) => !!c && typeof c === 'object' && (c as { is_cross_family?: unknown }).is_cross_family === true,
    )
    if (considered.length === 0) return null
    const verdicts = considered.map((c) => (c as { verdict?: unknown }).verdict)
    if (verdicts.includes('block')) return 'block'
    if (verdicts.includes('dissent')) return 'dissent'
    if (verdicts.includes('concur')) return 'concur'
    if (verdicts.includes('insufficient_same_family')) return 'insufficient_same_family'
    return 'unknown'
  } catch {
    return null
  }
}

/** Monotone severity ranking for worstMandatoryFailureSeverity(). Higher = worse. */
const _FAILURE_SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
})

/**
 * ATM-012 / REQ-008 — Return the WORST `severity` present among P6's
 * per-classification rows by the precedence `critical > high > medium > low`.
 * Returns `null` IF the input is empty or contains no recognized severity.
 * Defensively treats a non-array input as empty and SKIPS each
 * malformed/`null` row — NEVER throws (REQ-008(a)).
 */
export function worstMandatoryFailureSeverity(
  classifications: PersistedFailureClassification[],
): FailureSeverity | null {
  try {
    if (!Array.isArray(classifications)) return null
    let worst: FailureSeverity | null = null
    let worstRank = 0
    for (const c of classifications) {
      if (!c || typeof c !== 'object') continue
      const sev = (c as { severity?: unknown }).severity
      const rank = typeof sev === 'string' ? _FAILURE_SEVERITY_RANK[sev] : undefined
      if (rank !== undefined && rank > worstRank) {
        worstRank = rank
        worst = sev as FailureSeverity
      }
    }
    return worst
  } catch {
    return null
  }
}

/**
 * ATM-014 / REQ-009(a) — Resolve the aggregate TernaryRewardSignal for a
 * finalized decision by reading P7's cross-family critiques (keyed on
 * `decisionId`) and, IFF `taskId` is non-null, P6's failure classifications
 * (keyed on `taskId`). This is the small resolver the EPIC-04 finalize hook
 * (Stage 6) reuses.
 *
 * A RUNTIME throw from either accessor is CAUGHT and the failed source is
 * treated as ABSENT (REQ-009(a)): a cross-family read-throw → verdict `null`;
 * a P6 read-throw OR a null `taskId` → `failure_signal_available = false`,
 * `failure_severity = null` (severity UNKNOWN, NEVER treated as clean, so the
 * downstream evaluator can never award a spurious `+1`). A SUCCESSFUL P6 read
 * (INCLUDING zero rows) sets `failure_signal_available = true`. Never throws.
 */
export function resolveTernaryRewardSignal(
  db: Database,
  decisionId: number,
  taskId: number | null,
): TernaryRewardSignal {
  let cross_family_verdict: CrossFamilyVerdict | string | null = null
  try {
    cross_family_verdict = aggregateCrossFamilyVerdict(getCrossFamilyCritiques(db, { decisionId }))
  } catch {
    cross_family_verdict = null
  }

  let failure_signal_available = false
  let failure_severity: FailureSeverity | string | null = null
  if (taskId !== null && taskId !== undefined) {
    try {
      const classifications = getFailureClassifications(db, { taskId })
      failure_signal_available = true
      failure_severity = worstMandatoryFailureSeverity(classifications)
    } catch {
      failure_signal_available = false
      failure_severity = null
    }
  }

  return { cross_family_verdict, failure_severity, failure_signal_available }
}

// ---------------------------------------------------------------------------
// EPIC-04 / REQ-010, REQ-011, REQ-012, REQ-019 (ATM-016..019, ATM-028) —
// Persistence, read predicate & audit atomicity.
//
// The `ternary_rewards` table + `ternary_reward_enabled` flag are created in
// TaskDB.migrate() (db.ts, additive). persistTernaryReward() mirrors P7's
// persistCrossFamilyCritique() EXACTLY: flag-gate BEFORE any transaction, a
// LOCAL `BEGIN IMMEDIATE` wrapping the row INSERT + the audit INSERT (so the
// two are all-or-nothing), ROLLBACK+rethrow on any throw, and ZERO import of
// any P5 write-ordering symbol (its write-transaction wrapper or its sequence
// minter).
// ---------------------------------------------------------------------------

/**
 * The write payload for persistTernaryReward(). `failure_signal_available` is
 * a boolean here and is persisted EXPLICITLY as `0`/`1` (the column carries no
 * SQL DEFAULT — REQ-010/REQ-011(b)). `reward` is CHECK-constrained to
 * `{-1,0,1}` at the DB level.
 */
export interface TernaryRewardRecord {
  policy_version: number
  decision_id: number | null
  task_id: number | null
  subject_kind: string
  cross_family_verdict: string | null
  failure_severity: string | null
  failure_signal_available: boolean
  reward: TernaryReward
}

/**
 * ATM-017/ATM-018/ATM-028 / REQ-011/REQ-019 — Persists a TernaryRewardRecord
 * as a durable row in ternary_rewards (migrate()'d in db.ts), plus a matching
 * audit_log row (action='ternary_reward_assigned') — both inside ONE LOCAL
 * `BEGIN IMMEDIATE` transaction, so a failure on either write rolls back both
 * (ATM-028 two-direction fault injection). Gated on the ternary_reward_enabled
 * feature flag (REQ-011(a)): when the flag row is missing or `enabled` is not
 * exactly 1, this returns null WITHOUT opening any transaction or inserting any
 * row.
 *
 * Takes a raw `db: Database` handle (mirrors P6/P7's own persist fns). The
 * `failure_signal_available` boolean is written EXPLICITLY as `0`/`1`
 * (REQ-011(b)); the column has no SQL DEFAULT. This module imports NO P5
 * write-ordering symbol — build-order independence from P5 is structural.
 */
export function persistTernaryReward(db: Database, record: TernaryRewardRecord): number | null {
  // REQ-011(a): flag gate, checked BEFORE any transaction is opened.
  const flagRow = db
    .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'ternary_reward_enabled'")
    .get() as { enabled: number } | null
  if (!flagRow || flagRow.enabled !== 1) {
    return null
  }

  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const inserted = db
      .prepare(`
        INSERT INTO ternary_rewards (
          policy_version, decision_id, task_id, subject_kind,
          cross_family_verdict, failure_severity, failure_signal_available, reward
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .get(
        record.policy_version,
        record.decision_id,
        record.task_id,
        record.subject_kind,
        record.cross_family_verdict,
        record.failure_severity,
        record.failure_signal_available ? 1 : 0, // EXPLICIT 0/1 — no DB default (REQ-011(b))
        record.reward,
      ) as { id: number }

    // REQ-019/ATM-028: audit row, same local transaction, all-or-nothing with
    // the insert above. action is DISTINCT from finalize_decision's own
    // 'decision_finalized' row. detail records the full reward provenance.
    const detail = {
      decision_id: record.decision_id,
      reward: record.reward,
      cross_family_verdict: record.cross_family_verdict,
      failure_severity: record.failure_severity,
      failure_signal_available: record.failure_signal_available,
    }
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, task_id)
      VALUES (?, ?, ?, ?)
    `).run('system', 'ternary_reward_assigned', JSON.stringify(detail), record.task_id)

    db.prepare('COMMIT').run()
    return inserted.id
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    } catch {}
    throw err
  }
}

/**
 * ATM-019 / REQ-012 — READ-ONLY predicate: does this decision have >=1
 * recorded ternary reward? Returns `true` IFF a ternary_rewards row exists for
 * `decisionId`, `false` otherwise (INCLUDING for a non-existent decisionId).
 * Mutates no table, and NEVER throws — any unexpected error is swallowed to
 * `false`.
 */
export function hasTernaryReward(db: Database, decisionId: number): boolean {
  try {
    const row = db
      .prepare('SELECT 1 AS present FROM ternary_rewards WHERE decision_id = ? LIMIT 1')
      .get(decisionId) as { present: number } | null
    return row !== null && row !== undefined
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// EPIC-05 / REQ-014, REQ-015 (ATM-022..024) — P-downstream read accessor.
//
// The single, stable, READ-ONLY boundary a future consumer builds on. Mirrors
// getCrossFamilyCritiques()/getFailureClassifications() EXACTLY: a dynamic
// WHERE-clause builder, `SELECT * ... ORDER BY id ASC`, a row-map, and
// forward-compat pass-through of unrecognized verdict/severity strings + a
// newer policy_version. Defines the accessor + its return SHAPE only — computes
// NO reward and exposes no write path beyond EPIC-04's persistTernaryReward()
// (ATM-023). The stored failure_signal_available INTEGER (0/1) is coerced to a
// real boolean (REQ-014).
// ---------------------------------------------------------------------------

/**
 * A durable ternary_rewards row, as read back by getTernaryRewards() — the
 * STABLE contract boundary a future consumer shall consume (REQ-014).
 * `cross_family_verdict`/`failure_severity` are `string | null` (forward-compat
 * widening — a row from a newer taxonomy carrying an unrecognized value still
 * deserializes without loss, REQ-015). `reward` is CHECK-constrained to
 * `{-1,0,1}` at the DB level, so it is typed as the closed `TernaryReward`.
 * `failure_signal_available` is surfaced as a real boolean (the column is
 * INTEGER 1/0).
 */
export type PersistedTernaryReward = {
  id: number
  policy_version: number
  decision_id: number | null
  task_id: number | null
  subject_kind: string
  cross_family_verdict: string | null
  failure_severity: string | null
  failure_signal_available: boolean
  reward: TernaryReward
  created_at: string
}

/**
 * ATM-022/ATM-024 / REQ-014/REQ-015 — Reads durable ternary_rewards rows back
 * out, in ascending `id` order, optionally narrowed by `decisionId` / `reward`
 * / a `created_at` floor (`since`, inclusive). READ-ONLY (SELECT only — never
 * INSERT/UPDATE/DELETE) and performs NO scoring/aggregation/reward computation
 * of its own (ATM-023): a pass-through accessor over what persistTernaryReward()
 * already wrote.
 *
 * `cross_family_verdict` / `failure_severity` / `policy_version` are copied
 * through AS-IS with no validation/coercion — REQ-015: a row with an
 * unrecognized verdict/severity OR a newer `policy_version` is still returned
 * UNCHANGED (never thrown, never dropped, never coerced). The ONLY coercion is
 * `failure_signal_available` INTEGER (`0`/`1`) → `boolean` (REQ-014).
 */
export function getTernaryRewards(
  db: Database,
  filter?: { decisionId?: number; reward?: TernaryReward; since?: string },
): PersistedTernaryReward[] {
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (filter?.decisionId !== undefined) {
    clauses.push('decision_id = ?')
    params.push(filter.decisionId)
  }
  if (filter?.reward !== undefined) {
    clauses.push('reward = ?')
    params.push(filter.reward)
  }
  if (filter?.since !== undefined) {
    clauses.push('created_at >= ?')
    params.push(filter.since)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM ternary_rewards ${where} ORDER BY id ASC`).all(...params) as any[]

  return rows.map(
    (row): PersistedTernaryReward => ({
      id: row.id,
      policy_version: row.policy_version,
      decision_id: row.decision_id,
      task_id: row.task_id,
      subject_kind: row.subject_kind,
      cross_family_verdict: row.cross_family_verdict,
      failure_severity: row.failure_severity,
      failure_signal_available: row.failure_signal_available === 1,
      reward: row.reward,
      created_at: row.created_at,
    }),
  )
}

// ---------------------------------------------------------------------------
// EPIC-04 wiring orchestrator (REQ-013 / ATM-020) — the single exported entry
// point the finalize_decision hook calls, keeping server.ts's additive
// footprint to one import + one flag-gated inner-try/catch call site.
// ---------------------------------------------------------------------------

/**
 * assessAndPersistTernaryRewardForDecision() — resolve the aggregate signal
 * for a just-finalized decision (P7 cross-family verdict + P6 worst failure
 * severity, with the availability guard), assign the reward, and persist it.
 * Reuses resolveTernaryRewardSignal() (which swallows RUNTIME read-throws per
 * REQ-009(a)), assignTernaryReward() (never-throws), and persistTernaryReward()
 * (flag-gated + locally atomic).
 *
 * This function is NOT self-swallowing: a persistence-layer throw propagates to
 * the CALLER, which is the finalize_decision handler's OWN inner try/catch
 * (server.ts). That inner catch — with the ternary_reward_enabled flag-read
 * ALSO inside it — is what guarantees a throw here NEVER reaches the handler's
 * pre-existing OUTER catch and NEVER flips the finalize success response
 * (OQ-3 / REQ-013(a)). Callers MUST invoke this only from inside that swallow.
 */
export function assessAndPersistTernaryRewardForDecision(
  rawDb: Database,
  decision: { id: number; task_id: number | null },
): number | null {
  const signal = resolveTernaryRewardSignal(rawDb, decision.id, decision.task_id)
  const assessment = assignTernaryReward(signal)
  return persistTernaryReward(rawDb, {
    policy_version: assessment.policy_version,
    decision_id: decision.id,
    task_id: decision.task_id,
    subject_kind: 'decision',
    cross_family_verdict: signal.cross_family_verdict,
    failure_severity: signal.failure_severity,
    failure_signal_available: signal.failure_signal_available,
    reward: assessment.reward,
  })
}
