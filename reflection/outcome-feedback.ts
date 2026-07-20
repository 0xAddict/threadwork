// reflection/outcome-feedback.ts — EPIC-PF1 outcome-feedback loop (PF-spec.md,
// ~/.claude/state/p4-p8-fanout/specs/PF-spec.md, REQ-PF1-01..11 / ATM-PF1-01..11).
//
// PK-PF1-2 (ATM-PF1-03/04): pure core. recordExpectedOutcome() /
// persistOutcomeExpectation() (LOCAL BEGIN IMMEDIATE) and the pure
// diffOutcome() comparator. Later PF1 packets (per
// ~/.claude/state/pf-build/PHASE1-PLAN.md section (b)) add: reflect() /
// distillSharedPattern() / supersedeSharedPattern() (PK-PF1-3), and the
// additive, flag-gated, try/catch-swallowed wiring into debrief.ts's
// post-summarise step and the claim/delegation path — 4 sites per boss's
// OQ-1 mechanical-inclusion ruling (PK-PF1-4).
//
// This module is deliberately a separate top-level namespace from
// `verification/` — PF1 is not a verification-axis capability (see PF-spec.md
// Overlap/Isolation Proof carve #1). It must read the existing verification-axis
// triad (getFailureClassifications/getCrossFamilyCritiques/getTernaryRewards)
// strictly SELECT-only, and per the Persistence idiom section of PF-spec.md,
// all PF1 writes use the LOCAL BEGIN IMMEDIATE idiom (decision.ts:156-206) —
// never P5's memory-write-transaction primitive (that helper belongs to the
// P5 namespace; see PF-spec.md for why PF1 must not depend on it).

import type { Database } from 'bun:sqlite'

/** Write payload for persistOutcomeExpectation() / recordExpectedOutcome(). */
export interface ExpectedOutcomeInput {
  task_id: number
  expected_outcome: string
}

/**
 * ATM-PF1-03/REQ-PF1-01/REQ-PF1-02 — Persists an ExpectedOutcomeInput as a
 * durable row in `outcome_expectations` (migrate()'d in db.ts, PK-PF1-1)
 * inside ONE LOCAL `BEGIN IMMEDIATE` transaction — mirrors
 * `decision.ts:156-206` (`finalizeDecision()`) and P8's
 * `persistTernaryReward()`, both of which check their feature flag BEFORE
 * opening any transaction. Gated on `outcome_feedback_enabled`
 * (REQ-PF1-08): when the flag row is missing or `enabled` is not exactly 1,
 * this returns `null` WITHOUT opening any transaction or inserting any row
 * — the flag-gate lives in the persist function itself (defense in depth),
 * not only at the future call sites PK-PF1-4 wires up.
 *
 * Takes a raw `db: Database` handle (mirrors P6/P7/P8's own persist fns).
 * `recorded_at` is left to the column's own `DEFAULT (datetime('now'))`
 * (db.ts DDL) — this function never reads a wall clock itself.
 */
export function persistOutcomeExpectation(db: Database, input: ExpectedOutcomeInput): number | null {
  const flagRow = db
    .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'")
    .get() as { enabled: number } | null
  if (!flagRow || flagRow.enabled !== 1) {
    return null
  }

  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const inserted = db
      .prepare(`
        INSERT INTO outcome_expectations (task_id, expected_outcome)
        VALUES (?, ?)
        RETURNING id
      `)
      .get(input.task_id, input.expected_outcome) as { id: number }
    db.prepare('COMMIT').run()
    return inserted.id
  } catch (err) {
    try { db.prepare('ROLLBACK').run() } catch {}
    throw err
  }
}

/**
 * ATM-PF1-03/REQ-PF1-01 — The pre-act entry point PK-PF1-4 wires into the
 * claim/delegation path (all 4 sites per boss's OQ-1 ruling: `claim_task`,
 * `delegate_task`, `assign_task`, `transition_task`). NOT wired to any call
 * site in this packet — every call in PK-PF1-2's tests is direct/unwired.
 * Delegates straight to persistOutcomeExpectation(); kept as a distinct
 * exported symbol (rather than an alias) because REQ-PF1-01 names it as the
 * thing "the system shall call", with persistOutcomeExpectation() as the
 * mechanism it calls — matching the two-function shape the spec's Functions
 * bullet lists explicitly.
 */
export function recordExpectedOutcome(db: Database, input: ExpectedOutcomeInput): number | null {
  return persistOutcomeExpectation(db, input)
}

/** Input to diffOutcome() — an expected-vs-actual outcome pair. */
export interface DiffOutcomeInput {
  expected: string
  actual: string
}

/** Result of diffOutcome(). `delta` is present only when `matched` is false. */
export interface DiffOutcomeResult {
  matched: boolean
  delta?: string
}

/**
 * ATM-PF1-04/REQ-PF1-03 — PURE expected-vs-actual outcome comparator. No
 * side effects, no wall-clock read (no `Date.now()`/`new Date`), no DB
 * access, no I/O of any kind — inputs in, verdict out. Called twice on
 * identical input always returns deep-equal output.
 */
export function diffOutcome(input: DiffOutcomeInput): DiffOutcomeResult {
  if (input.expected === input.actual) {
    return { matched: true }
  }
  return {
    matched: false,
    delta: `expected "${input.expected}" but observed "${input.actual}"`,
  }
}
