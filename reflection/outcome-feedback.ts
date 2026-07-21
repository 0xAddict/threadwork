// reflection/outcome-feedback.ts — EPIC-PF1 outcome-feedback loop (PF-spec.md,
// ~/.claude/state/p4-p8-fanout/specs/PF-spec.md, REQ-PF1-01..11 / ATM-PF1-01..11).
//
// PK-PF1-3 (ATM-PF1-05..08): reflect() post-hoc pass, distillSharedPattern()/
// supersedeSharedPattern(), and the getSharedPatterns()/getOutcomeExpectations()
// read-contracts. Still NOT wired into debrief.ts or the claim/delegation
// path — that additive, flag-gated, try/catch-swallowed wiring (4 sites per
// boss's OQ-1 mechanical-inclusion ruling: claim_task/delegate_task/
// assign_task/transition_task) is PK-PF1-4. Every function here is fully
// standalone-testable; nothing in this file is called from any other module
// yet.
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
import { getFailureClassifications } from '../verification/failure-classification'
import { getCrossFamilyCritiques } from '../verification/cross-family-critique'
import { getTernaryRewards } from '../verification/ternary-reward'

/** Write payload for persistOutcomeExpectation() / recordExpectedOutcome(). */
export interface ExpectedOutcomeInput {
  task_id: number
  expected_outcome: string
}

/**
 * ATM-PF1-03/REQ-PF1-01/REQ-PF1-02 — Persists an ExpectedOutcomeInput as a
 * durable row in `outcome_expectations` (migrate()'d in db.ts, PK-PF1-1)
 * inside ONE LOCAL `BEGIN IMMEDIATE` transaction. Gated on
 * `outcome_feedback_enabled` (REQ-PF1-08): when the flag is not exactly 1,
 * this returns `null` WITHOUT inserting any row — the flag-gate lives in the
 * persist function itself (defense in depth), not only at the future call
 * sites PK-PF1-4 wires up.
 *
 * PK-PF1-5 codex round 3 fold (HIGH): the flag check happens INSIDE the
 * transaction — the FIRST thing after `BEGIN IMMEDIATE`, not before it opens
 * (that was round 1/2's structure, mirroring `decision.ts:156-206`'s and
 * P8's `persistTernaryReward()`'s "check flag, then open transaction"
 * shape). That shape has a real TOCTOU gap: another connection can flip the
 * flag OFF in between this function's flag read and its `BEGIN IMMEDIATE`
 * acquiring the write lock, and the write would still go through — codex
 * reproduced exactly this, one `outcome_expectations` row committed while
 * the flag ended at `0`. Re-checking the flag as the first statement AFTER
 * `BEGIN IMMEDIATE` closes the gap: once the immediate lock is held, no
 * other connection can flip the flag until this transaction
 * commits/rolls back, so the re-checked value is authoritative for the
 * whole transaction.
 *
 * Takes a raw `db: Database` handle (mirrors P6/P7/P8's own persist fns).
 * `recorded_at` is left to the column's own `DEFAULT (datetime('now'))`
 * (db.ts DDL) — this function never reads a wall clock itself.
 */
export function persistOutcomeExpectation(db: Database, input: ExpectedOutcomeInput): number | null {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const flagRow = db
      .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'")
      .get() as { enabled: number } | null
    if (!flagRow || flagRow.enabled !== 1) {
      db.prepare('ROLLBACK').run()
      return null
    }

    const inserted = db
      .prepare(`
        INSERT INTO outcome_expectations (task_id, expected_outcome)
        VALUES (?, ?)
        RETURNING id
      `)
      .get(input.task_id, input.expected_outcome) as { id: number }

    // ATM-PF1-09/REQ-PF1-09: distinct audit row, SAME local transaction as
    // the insert above — all-or-nothing (mirrors persistTernaryReward()'s
    // exact idiom: a raw INSERT INTO audit_log against the same `db` handle,
    // agent='system', not the AuditLog class — these persist fns only ever
    // take a raw Database handle).
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, task_id)
      VALUES (?, ?, ?, ?)
    `).run('system', 'outcome_expected', JSON.stringify({ expected_outcome: input.expected_outcome }), input.task_id)

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

/** A durable `outcome_expectations` row, as returned by getOutcomeExpectations(). */
export interface OutcomeExpectationRow {
  id: number
  task_id: number
  expected_outcome: string
  recorded_at: string
  diffed_at: string | null
  diff_result: string | null
}

/**
 * ATM-PF1-08/REQ-PF1-07 — Read-only contract over `outcome_expectations`.
 * Body is SELECT-only (static-scanned). Defaults to no filter (all rows);
 * `taskId` narrows to one task's expectations.
 */
export function getOutcomeExpectations(db: Database, filter?: { taskId?: number }): OutcomeExpectationRow[] {
  if (filter?.taskId !== undefined) {
    return db
      .prepare('SELECT id, task_id, expected_outcome, recorded_at, diffed_at, diff_result FROM outcome_expectations WHERE task_id = ? ORDER BY recorded_at ASC')
      .all(filter.taskId) as OutcomeExpectationRow[]
  }
  return db
    .prepare('SELECT id, task_id, expected_outcome, recorded_at, diffed_at, diff_result FROM outcome_expectations ORDER BY recorded_at ASC')
    .all() as OutcomeExpectationRow[]
}

/** A durable `shared_patterns` row, as returned by getSharedPatterns(). */
export interface SharedPatternRow {
  id: number
  pattern_text: string
  confidence: number
  source_expectation_id: number | null
  is_active: number
  superseded_by: number | null
  created_at: string
}

/**
 * ATM-PF1-08/REQ-PF1-07 — Read-only contract over `shared_patterns`. Body is
 * SELECT-only (static-scanned). Defaults to `is_active=1` (only currently-live
 * patterns); pass `{ activeOnly: false }` to see superseded rows too (proves
 * REQ-PF1-06's never-delete lineage is queryable).
 */
export function getSharedPatterns(db: Database, filter?: { activeOnly?: boolean }): SharedPatternRow[] {
  const activeOnly = filter?.activeOnly ?? true
  if (activeOnly) {
    return db
      .prepare('SELECT id, pattern_text, confidence, source_expectation_id, is_active, superseded_by, created_at FROM shared_patterns WHERE is_active = 1 ORDER BY created_at DESC')
      .all() as SharedPatternRow[]
  }
  return db
    .prepare('SELECT id, pattern_text, confidence, source_expectation_id, is_active, superseded_by, created_at FROM shared_patterns ORDER BY created_at DESC')
    .all() as SharedPatternRow[]
}

/** Write payload for persistSharedPattern() / supersedeSharedPattern(). */
export interface SharedPatternInput {
  pattern_text: string
  confidence: number
  source_expectation_id: number | null
}

/**
 * ATM-PF1-06/REQ-PF1-05 — Persists a SharedPatternInput as a durable row in
 * `shared_patterns` inside ONE LOCAL `BEGIN IMMEDIATE` transaction. Gated on
 * `outcome_feedback_enabled` exactly like persistOutcomeExpectation() — flag
 * check happens as the first statement INSIDE the transaction (PK-PF1-5
 * codex round 3 fold — see persistOutcomeExpectation()'s doc comment for
 * why), returns `null` with zero writes when OFF. New rows default
 * `is_active=1` (the DDL's column default).
 *
 * Kept as a standalone, spec-named primitive (the spec's Functions bullet
 * lists `persistSharedPattern()` explicitly) — but as of PK-PF1-5 codex
 * round 2's fold, `distillSharedPattern()` no longer calls this function; it
 * inlines its own insert logic inside its own dedup-check-then-insert
 * transaction instead (SQLite doesn't support nested `BEGIN IMMEDIATE` on
 * one connection, and the dedup check needs to live INSIDE that same
 * transaction to close a check-then-insert race — see
 * `distillSharedPattern()`'s doc comment). This function remains a correct,
 * independently-testable, flag-gated, transactional insert primitive for any
 * future caller that doesn't need a co-transacted dedup check.
 */
export function persistSharedPattern(db: Database, input: SharedPatternInput): number | null {
  // PK-PF1-5 codex round 3 fold (HIGH): flag check moved INSIDE the
  // transaction — see persistOutcomeExpectation()'s doc comment for the
  // TOCTOU this closes (flag flips OFF between an outside-transaction check
  // and BEGIN IMMEDIATE acquiring the lock; codex reproduced it for every
  // PF1 write path).
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const flagRow = db
      .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'")
      .get() as { enabled: number } | null
    if (!flagRow || flagRow.enabled !== 1) {
      db.prepare('ROLLBACK').run()
      return null
    }

    const inserted = db
      .prepare(`
        INSERT INTO shared_patterns (pattern_text, confidence, source_expectation_id)
        VALUES (?, ?, ?)
        RETURNING id
      `)
      .get(input.pattern_text, input.confidence, input.source_expectation_id) as { id: number }

    // ATM-PF1-09/REQ-PF1-09: distinct audit row, same transaction. This
    // function is called ONLY by distillSharedPattern() (never by
    // supersedeSharedPattern(), which has its own inline insert below) —
    // 'shared_pattern_distilled' is therefore always the correct action.
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, task_id)
      VALUES (?, ?, ?, ?)
    `).run('system', 'shared_pattern_distilled', JSON.stringify({ pattern_text: input.pattern_text, confidence: input.confidence, source_expectation_id: input.source_expectation_id }), null)

    db.prepare('COMMIT').run()
    return inserted.id
  } catch (err) {
    try { db.prepare('ROLLBACK').run() } catch {}
    throw err
  }
}

/**
 * OQ-2 disposition (adopted, per PHASE1-PLAN.md section (f)): deterministic
 * exact-match v1 — mirrors the SHAPE of PF6's `computeSimilarityKey` (a
 * single deterministic string key, grouped by string equality), not its
 * implementation (PF6 doesn't exist at this HEAD). Explicitly NOT
 * fuzzy/cosine matching — that's a future-packet extension, out of scope
 * for v1.
 */
export function computeSignature(matched: boolean, expectedOutcome: string): string {
  return `${matched ? 'match' : 'mismatch'}::${expectedOutcome.trim().toLowerCase()}`
}

/**
 * `shared_patterns` has no dedicated signature column (fixed DDL from
 * PK-PF1-1 — this packet cannot touch db.ts) so distillSharedPattern()'s
 * cross-call dedup embeds the signature as a machine-parseable tag inside
 * `pattern_text` and checks existing rows for it before re-distilling the
 * same signature on a later reflect() pass.
 *
 * PK-PF1-5 codex round 2 fold (HIGH): the raw signature is base64-encoded
 * before being embedded in the tag. Round 1's fix (a plain-text tag) was
 * itself exploitable: `signature` is built from user-controlled
 * `expected_outcome` text (description-derived, per round 1's E2 fold), so a
 * description containing the literal delimiter sequence `]] ` could forge a
 * premature tag-close — a LONGER attacker tag like
 * `[[sig:mismatch::...foo]] bar]]` then has a SHORTER, unrelated victim tag
 * `[[sig:mismatch::...foo]]` as its own exact prefix, falsely suppressing the
 * victim's real distillation (codex reproduced this). Base64's output
 * alphabet (`A-Za-z0-9+/=`) cannot contain `[`, `]`, or a space, so this
 * class of collision is now structurally impossible, not just unlikely.
 *
 * PK-PF1-5 codex round 3 fold (MED): the encoding is `utf16le`, NOT `utf-8`.
 * JS strings are UTF-16 and can contain LONE (unpaired) surrogates, which
 * are not valid Unicode scalar values — `Buffer.from(str, 'utf-8')` silently
 * replaces an invalid/lone surrogate with U+FFFD during encoding, which is
 * NOT injective: a string containing a genuine U+FFFD character and a
 * string containing an unrelated lone surrogate can produce IDENTICAL UTF-8
 * bytes (both become U+FFFD's encoding), hence identical base64 output,
 * even though the two original signatures are different strings (codex
 * reproduced this, causing a real signature group's distillation to be
 * falsely suppressed by an unrelated one). `Buffer.from(str, 'utf16le')`
 * encodes the string's raw UTF-16 code units directly and losslessly (2
 * bytes per code unit, no validity transformation), which is injective over
 * all possible JS strings, including ones with lone surrogates.
 */
function signatureTag(signature: string): string {
  const encoded = Buffer.from(signature, 'utf16le').toString('base64')
  return `[[sig:${encoded}]]`
}

/**
 * ATM-PF1-06/REQ-PF1-05 — When 3 or more `outcome_expectations` diffs share
 * a signature (computeSignature(), OQ-2 exact-match v1), produces exactly
 * one confidence-scored `shared_patterns` row via persistSharedPattern().
 * Fewer than 3 -> returns `null`, zero writes. If ANY row — active OR
 * superseded — already carries this exact signature's tag (dedup via the
 * `[[sig:...]]` tag), returns `null` without writing again — reflect() calls
 * this once per signature-group on every pass, so this dedup is what
 * prevents re-creating the same pattern every time it re-observes an
 * already-distilled group, INCLUDING after a valid supersedeSharedPattern()
 * call (PK-PF1-5 codex round 1 fold, MED-3: checking only `is_active=1`
 * meant a superseded row's signature would silently re-distill on the next
 * pass, since the row that carried the tag was no longer active — fixed by
 * checking the full lineage, not just the active subset).
 *
 * Dedup match is a STRICT PREFIX check (`pattern_text.startsWith(tag + ' ')`)
 * done in application code, NOT a SQL `LIKE` substring search (PK-PF1-5
 * codex round 1 fold, HIGH: `LIKE '%tag%'` treats `_`/`%` inside the
 * signature as SQL wildcards — e.g. a real `foo_bar` signature's tag would
 * false-match an unrelated `fooxbar` tag already on file — and a substring
 * search over the WHOLE `pattern_text` is spoofable: a task's
 * user-controlled `expected_outcome` text embedded later in `pattern_text`
 * could itself contain a literal `[[sig:...]]`-shaped string and falsely
 * suppress a DIFFERENT signature's distillation. Since `pattern_text` is
 * ALWAYS constructed as `${tag} ${...}` below, a prefix check is both safe
 * (no wildcard injection) and unspoofable (the tag can only ever be at
 * position 0 — nothing in `${rep.expected_outcome}`, which appears strictly
 * AFTER the tag, can forge a prefix match for a different signature).
 *
 * `corroborated` (REQ-PF1-11, "enrich pattern distillation" from the
 * read-only P6/P7/P8 triad) is computed by the CALLER (reflect(), which is
 * the function REQ-PF1-11 actually names as the triad's consumer) and
 * passed in here as a plain boolean — a deliberately simple v1 enrichment:
 * when true, nudges confidence up by a small fixed amount, capped at 1.
 * Deeper per-task correlation is a natural v2 extension.
 *
 * PK-PF1-5 codex round 2 fold (MED): the dedup check and the insert are now
 * ONE atomic `BEGIN IMMEDIATE` transaction, not a check followed by a
 * separately-transacted write. Round 1's fix left the dedup `SELECT` OUTSIDE
 * any transaction, so two concurrent `reflect()` calls processing the same
 * newly-eligible signature-group could both observe "no existing tag" before
 * either committed, and both insert a duplicate active pattern for the same
 * signature (codex reproduced this). This function does NOT call
 * persistSharedPattern() — SQLite doesn't support nested `BEGIN IMMEDIATE`
 * on one connection, so the insert logic is inlined here inside this
 * function's own transaction instead.
 *
 * PK-PF1-5 codex round 3 fold (HIGH): the flag check ALSO moved inside this
 * same transaction (immediately after `BEGIN IMMEDIATE`, before the dedup
 * check) rather than before it opens — see persistOutcomeExpectation()'s
 * doc comment for the TOCTOU this closes. The `matchingGroup.length < 3`
 * check stays outside (pure, no DB access, safe either way).
 */
export function distillSharedPattern(
  db: Database,
  matchingGroup: OutcomeExpectationRow[],
  signature: string,
  corroborated: boolean = false,
): number | null {
  if (matchingGroup.length < 3) {
    return null
  }

  const tag = signatureTag(signature)
  const prefix = `${tag} `

  // Representative row + confidence: pure derivation from already-fetched
  // data (no DB access), safe to compute before acquiring the lock.
  const rep = [...matchingGroup].sort((a, b) => (a.diffed_at ?? '').localeCompare(b.diffed_at ?? ''))[matchingGroup.length - 1]
  const repDiff: DiffOutcomeResult = rep.diff_result
    ? (JSON.parse(rep.diff_result) as DiffOutcomeResult)
    : { matched: signature.startsWith('match::') }
  // Confidence v1: approaches 1 as the group grows, never reaches exactly 1
  // from the base formula alone — always in (0,1). A `corroborated` signal
  // adds a small deterministic bump, capped at 1.
  let confidence = 1 - 1 / matchingGroup.length
  if (corroborated) {
    confidence = Math.min(1, confidence + 0.1)
  }
  const patternText = `${tag} ${repDiff.matched ? 'Consistently met' : 'Consistently missed'} expectation "${rep.expected_outcome}" (${matchingGroup.length} occurrences)`

  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const flagRow = db
      .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'")
      .get() as { enabled: number } | null
    if (!flagRow || flagRow.enabled !== 1) {
      db.prepare('ROLLBACK').run()
      return null
    }

    const allPatternTexts = db
      .prepare('SELECT pattern_text FROM shared_patterns')
      .all() as { pattern_text: string }[]
    const existing = allPatternTexts.some(r => r.pattern_text.startsWith(prefix))
    if (existing) {
      db.prepare('ROLLBACK').run()
      return null
    }

    const inserted = db
      .prepare(`
        INSERT INTO shared_patterns (pattern_text, confidence, source_expectation_id)
        VALUES (?, ?, ?)
        RETURNING id
      `)
      .get(patternText, confidence, rep.id) as { id: number }

    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, task_id)
      VALUES (?, ?, ?, ?)
    `).run('system', 'shared_pattern_distilled', JSON.stringify({ pattern_text: patternText, confidence, source_expectation_id: rep.id }), null)

    db.prepare('COMMIT').run()
    return inserted.id
  } catch (err) {
    try { db.prepare('ROLLBACK').run() } catch {}
    throw err
  }
}

/**
 * ATM-PF1-07/REQ-PF1-06 — Marks `oldPatternId`'s row `is_active=0` /
 * `superseded_by=<new id>` and appends the replacement row, all inside ONE
 * LOCAL `BEGIN IMMEDIATE` transaction — the prior row is NEVER deleted
 * (never-delete lineage, REQ-PF1-06). Gated on `outcome_feedback_enabled`
 * like every other PF1 write. Row count goes `n -> n+1`, never back down.
 *
 * Validates `oldPatternId` refers to a row that actually exists AND is
 * currently `is_active=1` — returns `null` with zero writes otherwise
 * (PK-PF1-5 codex round 1 fold, MED-3: the pre-fix version let a
 * non-existent or already-superseded `oldPatternId` silently "succeed",
 * inserting an orphan replacement row and logging a
 * `shared_pattern_superseded` audit action for a supersession that never
 * actually happened).
 *
 * PK-PF1-5 codex round 2 fold (MED): the existence/active-state validation
 * now happens INSIDE the transaction (re-checked under the `BEGIN IMMEDIATE`
 * lock, not before opening it), and the deactivating `UPDATE` is GUARDED
 * (`WHERE ... AND is_active = 1`) with its affected-row-count checked before
 * treating the supersession as successful. Round 1's fix validated BEFORE
 * opening the transaction, so two concurrent callers could both observe the
 * old pattern active, both pass validation, and both insert a competing
 * "replacement" — the later `UPDATE` silently overwrites `superseded_by`,
 * leaving two active replacement rows for one superseded original (codex
 * reproduced this). If the guarded update affects zero rows (another caller
 * won the race first), the whole transaction — including the replacement
 * row this call inserted — is rolled back, so no orphan row is left behind.
 *
 * PK-PF1-5 codex round 3 fold (HIGH): the flag check ALSO moved inside this
 * transaction (immediately after `BEGIN IMMEDIATE`, before the existence
 * check) rather than before it opens — see persistOutcomeExpectation()'s
 * doc comment for the TOCTOU this closes.
 */
export function supersedeSharedPattern(db: Database, oldPatternId: number, newInput: SharedPatternInput): number | null {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const flagRow = db
      .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'")
      .get() as { enabled: number } | null
    if (!flagRow || flagRow.enabled !== 1) {
      db.prepare('ROLLBACK').run()
      return null
    }

    const oldRow = db
      .prepare('SELECT id FROM shared_patterns WHERE id = ? AND is_active = 1')
      .get(oldPatternId)
    if (!oldRow) {
      db.prepare('ROLLBACK').run()
      return null
    }

    const inserted = db
      .prepare(`
        INSERT INTO shared_patterns (pattern_text, confidence, source_expectation_id)
        VALUES (?, ?, ?)
        RETURNING id
      `)
      .get(newInput.pattern_text, newInput.confidence, newInput.source_expectation_id) as { id: number }

    const updateResult = db
      .prepare('UPDATE shared_patterns SET is_active = 0, superseded_by = ? WHERE id = ? AND is_active = 1')
      .run(inserted.id, oldPatternId)
    if (updateResult.changes !== 1) {
      db.prepare('ROLLBACK').run()
      return null
    }

    // ATM-PF1-09/REQ-PF1-09: distinct audit row, same transaction as the
    // insert+update pair above.
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, task_id)
      VALUES (?, ?, ?, ?)
    `).run('system', 'shared_pattern_superseded', JSON.stringify({ old_pattern_id: oldPatternId, new_pattern_id: inserted.id }), null)

    db.prepare('COMMIT').run()
    return inserted.id
  } catch (err) {
    try { db.prepare('ROLLBACK').run() } catch {}
    throw err
  }
}

/**
 * ATM-PF1-05/REQ-PF1-04 — The post-hoc pass PK-PF1-4 additively invokes
 * AFTER `debrief.ts`'s existing summarise step (never before, never in
 * place of it — that wiring is PK-PF1-4; this function is standalone-called
 * in every test here). Gated on `outcome_feedback_enabled` — OFF performs
 * zero reads/writes beyond the flag check itself and returns
 * `{ diffed: 0, distilled: 0 }`.
 *
 * Phase 1 — diff every un-diffed `outcome_expectations` row whose task has
 * REACHED `status = 'completed'`, not merely acquired a non-null `result`.
 * `tasks.result` (populated by `completeTask()`/`forceCompleteTask()`) is
 * the only column at HEAD shaped like an "actual outcome" — there is no
 * dedicated `actual_outcome` column anywhere, so this is the deliberate,
 * documented source `diffOutcome()`'s `actual` input is read from. The
 * explicit `status = 'completed'` filter (PK-PF1-5 codex round 1 fold,
 * MED-1 — verified real against `completeTaskWithFinalizerCheck()`,
 * `db.ts:1805/1874`) matters because a board-CARD row (`complexity_user`
 * non-null) routes executor-completion to `status = 'review'` WHILE ALSO
 * populating `result` in the same `UPDATE` — that row is NOT yet accepted
 * by the human [Accept] gate (#13007 owns the review→completed advance);
 * without this filter, `reflect()` would diff and permanently audit a
 * card's outcome before the human ever accepted it. Plain agent tasks
 * (`complexity_user` NULL) reach `status = 'completed'` directly, unchanged
 * — this filter is a no-op for them. Each diff is persisted back onto its
 * own row (`diffed_at` + JSON-encoded `diff_result`) inside its own LOCAL
 * `BEGIN IMMEDIATE` transaction, via a GUARDED `UPDATE ... WHERE id = ? AND
 * diffed_at IS NULL` whose affected-row-count is checked (PK-PF1-5 codex
 * round 2 fold, MED: round 1's version snapshotted the un-diffed row set in
 * one unlocked `SELECT`, then unconditionally `UPDATE`d each row inside its
 * own transaction — two concurrent `reflect()` calls could both select the
 * same un-diffed row before either claimed it, and both proceed to update +
 * audit it, producing a duplicate `outcome_reflected` audit row for one
 * logical diff (codex reproduced this). Re-checking `diffed_at IS NULL`
 * atomically under the lock and skipping (not erroring) when the guarded
 * update affects zero rows closes that race.
 *
 * Phase 2 (REQ-PF1-11) — consumes P6/P7/P8's read-contract triad
 * (getFailureClassifications/getCrossFamilyCritiques/getTernaryRewards)
 * STRICTLY READ-ONLY — reflect() is the function REQ-PF1-11 actually names
 * as the triad's consumer. Never writes to any of the 3 underlying tables
 * (statically enforced — see the ATM-PF1-08/ATM-PF1-11 guard tests). v1
 * reduces this to an existence check (`corroborated: boolean`) fed into
 * distillSharedPattern() as a confidence enrichment signal; deeper
 * correlation is a v2 extension.
 *
 * Phase 3 — groups ALL diffed `outcome_expectations` rows (cumulative
 * across every past reflect() call, not just this one) by
 * computeSignature() and calls distillSharedPattern() for any group of size
 * >= 3 (REQ-PF1-05). distillSharedPattern()'s own dedup (the `[[sig:...]]`
 * tag) is what prevents re-distilling the same signature on every
 * subsequent pass.
 *
 * PK-PF1-5 codex round 3 fold (HIGH): the OUTER flag check above stays as a
 * fast-path (avoids the un-diffed scan + triad reads entirely when clearly
 * OFF), but is NOT sufficient alone for correctness — another connection
 * could flip the flag OFF after this check but before a per-row write
 * commits, and that row would still get diffed/audited while the flag reads
 * `0` (codex reproduced this). Each per-row transaction in Phase 1's loop
 * below therefore RE-CHECKS the flag as the first statement after its own
 * `BEGIN IMMEDIATE`, authoritative for that row's write. Phase 3's writes go
 * through `distillSharedPattern()`, which has its own internal re-check
 * (see that function's doc comment) — no separate re-check needed here.
 *
 * PK-PF1-5 codex round 4 fold (MED, boss-authorized — see BASELINES.md
 * PK-PF1-5 section for the full disposition of round 4's HIGH/MED/LOW):
 * the OUTER batch SELECT above (`status = 'completed' AND result IS NOT
 * NULL`) is likewise only a fast-path PRE-FILTER now, not the source of the
 * actual/status data a row is diffed against. The pre-fold version captured
 * `t.result` in that same outer SELECT and used it directly to compute
 * `diffOutcome()` BEFORE the per-row `BEGIN IMMEDIATE` even opened. That
 * snapshot can go stale: a raw, non-transactional write elsewhere —
 * `watchdog.ts`'s auto-resolve-via-sibling block (around lines 359-371)
 * mutates `tasks.status`/`tasks.result` outside the normal claim/complete
 * flow, with no coordination with `reflect()` and no live-status predicate
 * on its own `UPDATE ... WHERE id = ?` — can land in the gap between this
 * function's outer read and a given row's per-row lock. Codex reproduced
 * exactly this: `reflect()` would diff and PERMANENTLY audit an outcome
 * against data that was already obsolete by the time the diff was
 * persisted. Each per-row transaction below now re-reads `tasks.status`/
 * `tasks.result` FRESH, immediately after acquiring `BEGIN IMMEDIATE` (this
 * is safe/consistent for the same reason the flag re-check above is: once
 * the immediate lock is held, no other connection can mutate that row until
 * this transaction commits/rolls back), and computes `diffOutcome()` from
 * THAT fresh read, never from the outer snapshot. If the fresh read shows
 * the row no longer qualifies under the exact same condition the outer
 * SELECT (and PK-PF1-5 codex round 1's MED-1 fold, db.ts:1805/1874
 * card-vs-task terminal semantics) already applies — `status` is no longer
 * `'completed'`, or `result` is somehow NULL — the row is SKIPPED: not
 * diffed, and `diffed_at` is deliberately left NULL (the same choice the
 * "lost the race" branch a few lines below already makes for a row it
 * didn't fully process). This is safe against infinite reprocessing without
 * a separate "given up" marker, because the OUTER batch SELECT's own
 * `t.status = 'completed'` filter is what gates whether a row is even
 * considered on a FUTURE `reflect()` call: a row that stays disqualified
 * simply stops matching that filter and is never re-selected, while a row
 * that legitimately re-qualifies (status returns to `'completed'`) is
 * correctly picked back up and diffed then — which permanently marking
 * `diffed_at` here would incorrectly foreclose.
 */
export function reflect(db: Database): { diffed: number; distilled: number } {
  const flagRow = db
    .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'")
    .get() as { enabled: number } | null
  if (!flagRow || flagRow.enabled !== 1) {
    return { diffed: 0, distilled: 0 }
  }

  // NOTE (PK-PF1-5 codex round 4 fold): this SELECT is a fast-path
  // PRE-FILTER only — it decides which rows are even worth attempting this
  // pass. It deliberately does NOT select `t.result`/`t.status` for use as
  // the diff input; each row's actual/status is re-read FRESH inside its
  // own per-row transaction below (see that loop's doc comment for why).
  const undiffed = db
    .prepare(`
      SELECT oe.id AS id, oe.task_id AS task_id, oe.expected_outcome AS expected_outcome
      FROM outcome_expectations oe
      JOIN tasks t ON t.id = oe.task_id
      WHERE oe.diffed_at IS NULL AND t.result IS NOT NULL AND t.status = 'completed'
    `)
    .all() as { id: number; task_id: number; expected_outcome: string }[]

  let diffedCount = 0
  for (const row of undiffed) {
    db.prepare('BEGIN IMMEDIATE').run()
    try {
      const rowFlagRow = db
        .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'outcome_feedback_enabled'")
        .get() as { enabled: number } | null
      if (!rowFlagRow || rowFlagRow.enabled !== 1) {
        // Flag flipped OFF since the outer fast-path check — do not write.
        db.prepare('ROLLBACK').run()
        continue
      }

      // PK-PF1-5 codex round 4 fold (MED): re-read this row's task
      // status/result FRESH, under the lock, instead of trusting the outer
      // batch SELECT's snapshot (see this function's doc comment). Skip
      // (leave diffed_at NULL, do not diff/audit) if it no longer qualifies.
      const freshTask = db
        .prepare('SELECT status, result FROM tasks WHERE id = ?')
        .get(row.task_id) as { status: string; result: string | null } | null
      if (!freshTask || freshTask.status !== 'completed' || freshTask.result === null) {
        db.prepare('ROLLBACK').run()
        continue
      }

      const diff = diffOutcome({ expected: row.expected_outcome, actual: freshTask.result })

      const updateResult = db
        .prepare("UPDATE outcome_expectations SET diffed_at = datetime('now'), diff_result = ? WHERE id = ? AND diffed_at IS NULL")
        .run(JSON.stringify(diff), row.id)
      if (updateResult.changes !== 1) {
        // Lost the race — another concurrent reflect() call already claimed
        // (diffed) this row first. Not an error; just don't double-count or
        // double-audit it.
        db.prepare('ROLLBACK').run()
        continue
      }

      // ATM-PF1-09/REQ-PF1-09: distinct audit row per diffed row, same
      // transaction as that row's UPDATE.
      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, task_id)
        VALUES (?, ?, ?, ?)
      `).run('system', 'outcome_reflected', JSON.stringify({ outcome_expectation_id: row.id, matched: diff.matched }), row.task_id)

      db.prepare('COMMIT').run()
      diffedCount++
    } catch (err) {
      try { db.prepare('ROLLBACK').run() } catch {}
      throw err
    }
  }

  const corroborated =
    getFailureClassifications(db).length > 0 ||
    getCrossFamilyCritiques(db).length > 0 ||
    getTernaryRewards(db).length > 0

  const allDiffed = getOutcomeExpectations(db).filter(r => r.diffed_at != null)
  const groups = new Map<string, OutcomeExpectationRow[]>()
  for (const row of allDiffed) {
    const diff = JSON.parse(row.diff_result!) as DiffOutcomeResult
    const sig = computeSignature(diff.matched, row.expected_outcome)
    const group = groups.get(sig) ?? []
    group.push(row)
    groups.set(sig, group)
  }

  let distilledCount = 0
  for (const [sig, group] of groups) {
    if (group.length >= 3) {
      const id = distillSharedPattern(db, group, sig, corroborated)
      if (id != null) {
        distilledCount++
      }
    }
  }

  return { diffed: diffedCount, distilled: distilledCount }
}
