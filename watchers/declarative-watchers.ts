// watchers/declarative-watchers.ts — EPIC-PF2 declarative watchers (PF-spec.md,
// ~/.claude/state/p4-p8-fanout/specs/PF-spec.md, REQ-PF2-01..18 / ATM-PF2-01..16).
//
// PK-PF2-2 (ATM-PF2-03 + ATM-PF2-14): createWatcher()/persistWatcher() +
// trigger_type validation (REQ-PF2-01/02), and condition_spec schema
// validation discriminated by trigger_type (REQ-PF2-15). Persistence uses
// the LOCAL `BEGIN IMMEDIATE` idiom, matching decision.ts:156-206's shape
// (a raw `Database` handle, `BEGIN IMMEDIATE` … `COMMIT`, `try/catch` →
// `ROLLBACK`) — never P5's memory-write-ordering transaction primitive
// (that helper belongs to the P5 namespace; PF2 must not depend on it,
// same carve-out PF1's reflection/outcome-feedback.ts documents).
// Unlike PF1's `persistOutcomeExpectation()`, this does NOT flag-gate
// itself: REQ-PF2-09's `declarative_watchers_enabled` flag gates the
// automatic watchdog-tick `evaluateWatchers()` pass (PK-PF2-5), not
// explicit `createWatcher()` calls — mirrors decision.ts's `finalizeDecision()`,
// which has no feature-flag check of its own either.
//
// Still NOT wired into any live call site — no MCP tool case (PK-PF2-5),
// no watchdog.ts touch (out of this packet's FILE BOUNDARY). The three
// bounded condition evaluators (evaluateScheduledCondition/
// evaluateStateChangeCondition/evaluateLlmCondition), fireWatcher(), and
// getWatchers()/disableWatcher() land in later packets (PK-PF2-3/4).
//
// This module is deliberately a separate top-level namespace from
// `reflection/` (EPIC-PF1) — PF2 has zero logic overlap with PF1 per
// PF-spec.md's Overlap/Isolation Proof; the only shared file between the
// two epics is db.ts's migrate() (additive, disjoint tables/flags, already
// landed PK-PF2-1). No open expression evaluation is permitted anywhere in
// this module — no dynamic-code-execution call of any kind, ever
// (static-scan gate, REQ-PF2-15). condition_spec validation below is
// deliberately STRUCTURAL (field allowlists + type/shape checks against a
// fixed schema per trigger_type) — never string-parsing or evaluating an
// expression.

import type { Database } from 'bun:sqlite'
import type { TaskDB, CreateTaskInput } from '../db'

/** The three trigger_type values a declarative_watchers row may have. */
export type TriggerType = 'scheduled' | 'state_change' | 'llm_eval'

export const TRIGGER_TYPES: readonly TriggerType[] = ['scheduled', 'state_change', 'llm_eval']

/**
 * `scheduled` condition_spec (REQ-PF2-12/REQ-PF2-15) — v1 is interval-only.
 * `cron_expr` is deliberately OUT of v1 scope (KO-PF2-3) and is rejected as
 * an unexpected field by validateScheduledConditionSpec() below.
 */
export interface ScheduledConditionSpec {
  interval_seconds: number
}

export type StateChangeComparator = 'eq' | 'ne' | 'gt' | 'lt' | 'changed'
export type StateChangeAggregateFn = 'COUNT' | 'MAX' | 'MIN' | 'SUM'

const STATE_CHANGE_COMPARATORS: readonly StateChangeComparator[] = ['eq', 'ne', 'gt', 'lt', 'changed']
const STATE_CHANGE_AGGREGATES: readonly StateChangeAggregateFn[] = ['COUNT', 'MAX', 'MIN', 'SUM']

/** Bounded scalar values a watched_selector's predicate fields may hold. */
type ScalarValue = string | number | boolean | null

/**
 * `state_change` condition_spec (REQ-PF2-13/17/18) — a bounded predicate
 * over ONE existing table/column. `watched_selector` (a bounded WHERE
 * predicate constrained to identify a single row — represented here as a
 * plain object of column->scalar equality pairs, never a raw expression
 * string) and `watched_aggregate` (one entry from the fixed allowlist) are
 * mutually exclusive — exactly one must be present (REQ-PF2-18 XOR).
 */
export interface StateChangeConditionSpec {
  watched_table: string
  watched_column: string
  comparator: StateChangeComparator
  operand: ScalarValue
  watched_selector?: Record<string, ScalarValue>
  watched_aggregate?: StateChangeAggregateFn
}

/**
 * `llm_eval` condition_spec (REQ-PF2-14/15) — one bounded prompt with a
 * strict boolean output contract. `max_tokens` is optional; when provided
 * it must be a positive integer.
 */
export interface LlmEvalConditionSpec {
  prompt: string
  max_tokens?: number
}

export type ConditionSpec = ScheduledConditionSpec | StateChangeConditionSpec | LlmEvalConditionSpec

/** Bounded max length for an llm_eval prompt — never an open/unbounded surface. */
const LLM_EVAL_MAX_PROMPT_LEN = 4000

/** Input to createWatcher() / persistWatcher(). */
export interface CreateWatcherInput {
  name: string
  /** Loosely typed (not the TriggerType union) so runtime callers — MCP
   * tool JSON in a later packet, or a deliberately-invalid test input —
   * type-check; createWatcher() is the single source of runtime
   * validation, matching how untyped wire input actually arrives. */
  trigger_type: string
  condition_spec: unknown
  action_spec: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isScalarOrNull(v: unknown): v is ScalarValue {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/**
 * A conservative bare-SQL-identifier allowlist (letters/digits/underscore,
 * not starting with a digit). `watched_table`/`watched_column` and every
 * `watched_selector` key end up interpolated as identifiers into a query
 * string in evaluateStateChangeCondition() (SQLite has no parameter-binding
 * for identifiers, only values) — this guard is what keeps that bounded:
 * anything outside this allowlist is rejected here, at createWatcher()
 * validation time, before it ever reaches a query string.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertSafeIdentifier(name: unknown, label: string): asserts name is string {
  if (typeof name !== 'string' || !SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `createWatcher(): state_change condition_spec.${label} must be a valid bare identifier (letters, digits, underscore, not starting with a digit) — got ${JSON.stringify(name)}`,
    )
  }
}

/**
 * ATM-PF2-03/REQ-PF2-01 — Validates a trigger_type is one of the three
 * allowed values. Throws (does not return a boolean) so callers get an
 * immediate, descriptive failure — mirrors the CHECK constraint's role at
 * the DB layer (PK-PF2-1) as defense in depth, not a replacement for it.
 */
export function validateTriggerType(triggerType: unknown): asserts triggerType is TriggerType {
  if (!TRIGGER_TYPES.includes(triggerType as TriggerType)) {
    throw new Error(
      `createWatcher(): invalid trigger_type ${JSON.stringify(triggerType)} — must be one of ${TRIGGER_TYPES.join(', ')}`,
    )
  }
}

function validateScheduledConditionSpec(spec: unknown): asserts spec is ScheduledConditionSpec {
  if (!isPlainObject(spec)) {
    throw new Error(`createWatcher(): scheduled condition_spec must be a plain object`)
  }
  const allowed = ['interval_seconds']
  const stray = Object.keys(spec).filter(k => !allowed.includes(k))
  if (stray.length > 0) {
    throw new Error(
      `createWatcher(): scheduled condition_spec has unexpected field(s): ${stray.join(', ')} — v1 supports interval_seconds only (cron_expr is out of scope, KO-PF2-3)`,
    )
  }
  if (typeof spec.interval_seconds !== 'number' || !Number.isFinite(spec.interval_seconds) || spec.interval_seconds <= 0) {
    throw new Error(`createWatcher(): scheduled condition_spec.interval_seconds must be a positive finite number`)
  }
}

function validateStateChangeConditionSpec(spec: unknown): asserts spec is StateChangeConditionSpec {
  if (!isPlainObject(spec)) {
    throw new Error(`createWatcher(): state_change condition_spec must be a plain object`)
  }
  const allowed = ['watched_table', 'watched_column', 'comparator', 'operand', 'watched_selector', 'watched_aggregate']
  const stray = Object.keys(spec).filter(k => !allowed.includes(k))
  if (stray.length > 0) {
    throw new Error(`createWatcher(): state_change condition_spec has unexpected field(s): ${stray.join(', ')}`)
  }
  assertSafeIdentifier(spec.watched_table, 'watched_table')
  assertSafeIdentifier(spec.watched_column, 'watched_column')
  if (!STATE_CHANGE_COMPARATORS.includes(spec.comparator as StateChangeComparator)) {
    throw new Error(`createWatcher(): state_change condition_spec.comparator must be one of ${STATE_CHANGE_COMPARATORS.join(', ')}`)
  }
  if (!isScalarOrNull(spec.operand)) {
    throw new Error(`createWatcher(): state_change condition_spec.operand must be a string, number, boolean, or null`)
  }

  // REQ-PF2-18: exactly one of watched_selector / watched_aggregate.
  const hasSelector = spec.watched_selector !== undefined
  const hasAggregate = spec.watched_aggregate !== undefined
  if (hasSelector === hasAggregate) {
    throw new Error(
      `createWatcher(): state_change condition_spec must specify exactly one of watched_selector or watched_aggregate (REQ-PF2-18)`,
    )
  }

  if (hasSelector) {
    // A bounded WHERE predicate: a non-empty plain object of column->scalar
    // equality pairs. Deliberately NOT a string — a raw predicate string
    // (e.g. "id = 1 OR 1=1") is exactly the open-expression shape REQ-PF2-15
    // forbids, so any non-object here is rejected structurally, never parsed.
    if (!isPlainObject(spec.watched_selector) || Object.keys(spec.watched_selector).length === 0) {
      throw new Error(
        `createWatcher(): state_change condition_spec.watched_selector must be a non-empty plain object of column->scalar equality pairs (bounded predicate — no free-form expression strings)`,
      )
    }
    for (const [key, value] of Object.entries(spec.watched_selector)) {
      assertSafeIdentifier(key, `watched_selector key ${JSON.stringify(key)}`)
      if (!isScalarOrNull(value)) {
        throw new Error(
          `createWatcher(): state_change condition_spec.watched_selector.${key} must be a string, number, boolean, or null (bounded — no nested expressions)`,
        )
      }
    }
  }

  if (hasAggregate) {
    if (!STATE_CHANGE_AGGREGATES.includes(spec.watched_aggregate as StateChangeAggregateFn)) {
      throw new Error(
        `createWatcher(): state_change condition_spec.watched_aggregate must be one of ${STATE_CHANGE_AGGREGATES.join(', ')} (fixed allowlist, REQ-PF2-18)`,
      )
    }
  }
}

function validateLlmEvalConditionSpec(spec: unknown): asserts spec is LlmEvalConditionSpec {
  if (!isPlainObject(spec)) {
    throw new Error(`createWatcher(): llm_eval condition_spec must be a plain object`)
  }
  const allowed = ['prompt', 'max_tokens']
  const stray = Object.keys(spec).filter(k => !allowed.includes(k))
  if (stray.length > 0) {
    throw new Error(`createWatcher(): llm_eval condition_spec has unexpected field(s): ${stray.join(', ')}`)
  }
  if (typeof spec.prompt !== 'string' || spec.prompt.length === 0) {
    throw new Error(`createWatcher(): llm_eval condition_spec.prompt must be a non-empty string`)
  }
  if (spec.prompt.length > LLM_EVAL_MAX_PROMPT_LEN) {
    throw new Error(`createWatcher(): llm_eval condition_spec.prompt exceeds the bounded max length (${LLM_EVAL_MAX_PROMPT_LEN} chars)`)
  }
  if (spec.max_tokens !== undefined) {
    if (typeof spec.max_tokens !== 'number' || !Number.isInteger(spec.max_tokens) || spec.max_tokens <= 0) {
      throw new Error(`createWatcher(): llm_eval condition_spec.max_tokens must be a positive integer when provided`)
    }
  }
}

/**
 * ATM-PF2-14/REQ-PF2-15 — Validates `conditionSpec` against the bounded,
 * typed schema for `triggerType`. Throws a descriptive Error on any
 * non-conforming shape; never evaluates, parses-as-code, or otherwise
 * executes any part of `conditionSpec` — validation is purely structural
 * (field allowlists + type checks).
 */
export function validateConditionSpec(triggerType: TriggerType, conditionSpec: unknown): void {
  switch (triggerType) {
    case 'scheduled':
      validateScheduledConditionSpec(conditionSpec)
      return
    case 'state_change':
      validateStateChangeConditionSpec(conditionSpec)
      return
    case 'llm_eval':
      validateLlmEvalConditionSpec(conditionSpec)
      return
  }
}

/**
 * `action_spec` validation (bounded, typed JSON — the task-template fields
 * fireWatcher() will consume in a later packet, PK-PF2-4). This packet only
 * enforces the structural minimum (a plain object, never a string/array/
 * null) — the deeper task-template field shape is out of ATM-PF2-14's named
 * scope (REQ-PF2-15 covers condition_spec only).
 */
function validateActionSpec(actionSpec: unknown): void {
  if (!isPlainObject(actionSpec)) {
    throw new Error(`createWatcher(): action_spec must be a plain object`)
  }
}

/**
 * ATM-PF2-03/REQ-PF2-01/REQ-PF2-02 — Persists a CreateWatcherInput as a
 * durable row in `declarative_watchers` (migrate()'d in db.ts, PK-PF2-1)
 * inside ONE LOCAL `BEGIN IMMEDIATE` transaction — decision.ts:156-206's
 * shape (open the immediate lock, do the write, COMMIT; any throw rolls
 * back). Does NOT validate its input — callers (createWatcher()) are
 * expected to have already validated trigger_type/condition_spec/
 * action_spec; an invalid trigger_type reaching this function is still
 * caught by the DB-level CHECK constraint (PK-PF2-1), which throws and
 * triggers the same ROLLBACK path. Takes a raw `db: Database` handle
 * (mirrors P6/P7/P8/PF1's own persist fns). `created_at` is left to the
 * column's own `DEFAULT (datetime('now'))` (db.ts DDL) — this function
 * never reads a wall clock itself.
 *
 * PK-PF2-5/ATM-PF2-09/REQ-PF2-10 — also appends the `watcher_created`
 * `audit_log` row, in the SAME transaction as the `INSERT` above (so a
 * rollback of one rolls back both) — the raw-`INSERT`-inside-the-
 * function's-own-transaction idiom, mirroring
 * `verification/ternary-reward.ts`'s `persistTernaryReward()` (its
 * `audit_log` insert at the time of writing) and
 * `reflection/outcome-feedback.ts`'s `persistOutcomeExpectation()` (line
 * 85) — never `server.ts`'s `AuditLog.log()` class-instance idiom, since
 * this EPIC's domain objects already own dedicated persist functions with
 * their own transactions the same way PF1/P8's do.
 */
export function persistWatcher(db: Database, input: CreateWatcherInput): number {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const inserted = db
      .prepare(`
        INSERT INTO declarative_watchers (name, trigger_type, condition_spec, action_spec)
        VALUES (?, ?, ?, ?)
        RETURNING id
      `)
      .get(input.name, input.trigger_type, JSON.stringify(input.condition_spec), JSON.stringify(input.action_spec)) as { id: number }
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, task_id)
      VALUES (?, ?, ?, ?)
    `).run('system', 'watcher_created', JSON.stringify({ watcher_id: inserted.id, name: input.name, trigger_type: input.trigger_type }), null)
    db.prepare('COMMIT').run()
    return inserted.id
  } catch (err) {
    try { db.prepare('ROLLBACK').run() } catch {}
    throw err
  }
}

/**
 * ATM-PF2-03/REQ-PF2-01 — Validates `input` (trigger_type, then
 * condition_spec per that trigger_type's schema, then action_spec), and on
 * success persists it via persistWatcher(). Validation happens entirely
 * BEFORE `BEGIN IMMEDIATE` opens (pure, no DB access, no lock held) — an
 * invalid input never acquires the write lock at all.
 */
export function createWatcher(db: Database, input: CreateWatcherInput): number {
  validateTriggerType(input.trigger_type)
  validateConditionSpec(input.trigger_type, input.condition_spec)
  validateActionSpec(input.action_spec)
  return persistWatcher(db, input)
}

// ---------------------------------------------------------------------------
// PK-PF2-3 — the three bounded condition evaluators (ATM-PF2-11/12/13/15/16,
// REQ-PF2-12/13/14/17/18). Pure/module-level only — dispatching these from
// the watchdog tick loop (evaluateWatchers(), REQ-PF2-03/04) is PK-PF2-5's
// job, out of this packet's FILE BOUNDARY (no watchdog.ts touch).
// ---------------------------------------------------------------------------

/**
 * Input to evaluateScheduledCondition() — the two fields REQ-PF2-12's pure
 * function needs, already resolved to plain numbers (unix seconds) by the
 * caller. Deliberately NOT the raw `declarative_watchers` row (whose
 * `last_fired_at` column is a TEXT datetime string) — converting that string
 * to a number is the CALLER's job (PK-PF2-4/5), keeping this function free
 * of any `Date` usage at all, not just free of reading the wall clock.
 */
export interface ScheduledEvalInput {
  interval_seconds: number
  /** unix seconds, or null if the watcher has never fired. */
  last_fired_at: number | null
}

/**
 * ATM-PF2-11/REQ-PF2-12 — PURE function of (interval_seconds, last_fired_at,
 * now): fires when `now >= last_fired_at + interval_seconds` (inclusive), or
 * unconditionally when `last_fired_at` is null (never fired). `now` is an
 * INJECTED clock reading (unix seconds) — this function never reads the
 * system clock or constructs a date/time value of its own, matching PF1's
 * `diffOutcome()` purity precedent. Throws on a malformed `interval_seconds`
 * (defense in depth — createWatcher()'s validator already rejects this
 * upstream, PK-PF2-2, but a pure function should never silently misbehave on
 * an invariant violation either).
 */
export function evaluateScheduledCondition(input: ScheduledEvalInput, now: number): boolean {
  if (!Number.isFinite(input.interval_seconds) || input.interval_seconds <= 0) {
    throw new Error(
      `evaluateScheduledCondition(): malformed interval_seconds ${JSON.stringify(input.interval_seconds)} — must be a positive finite number`,
    )
  }
  if (input.last_fired_at === null) {
    return true
  }
  return now >= input.last_fired_at + input.interval_seconds
}

/** A resolved state_change scalar, as read back from SQLite (never an object/array). */
type ResolvedScalar = string | number | null

function stringifyScalar(v: ResolvedScalar): string | null {
  return v === null ? null : String(v)
}

/**
 * Evaluates one `{comparator, operand}` predicate against a resolved scalar
 * (or a stringified PRIOR snapshot value re-used as the "scalar" input, to
 * reconstruct what the predicate evaluated to last time — see
 * evaluateStateChangeCondition()). `changed` is NOT evaluated here — it has
 * no fixed-operand meaning; its transition logic is snapshot-relative and
 * handled directly by the caller.
 */
function comparePredicate(comparator: Exclude<StateChangeComparator, 'changed'>, scalar: ResolvedScalar, operand: ScalarValue): boolean {
  switch (comparator) {
    case 'eq':
      return stringifyScalar(scalar) === (operand === null ? null : String(operand))
    case 'ne':
      return stringifyScalar(scalar) !== (operand === null ? null : String(operand))
    case 'gt': {
      const a = scalar === null ? NaN : Number(scalar)
      const b = operand === null ? NaN : Number(operand)
      return !Number.isNaN(a) && !Number.isNaN(b) && a > b
    }
    case 'lt': {
      const a = scalar === null ? NaN : Number(scalar)
      const b = operand === null ? NaN : Number(operand)
      return !Number.isNaN(a) && !Number.isNaN(b) && a < b
    }
  }
}

function quoteIdentifier(name: string): string {
  // Belt-and-suspenders on top of assertSafeIdentifier() (already enforced
  // at createWatcher() validation time, PK-PF2-2) — double-quote so the
  // identifier can never be misread as anything but a bare name, even if a
  // future caller somehow reaches this without going through validation.
  return `"${name.replace(/"/g, '""')}"`
}

type ScalarResolution = { status: 'ok'; value: ResolvedScalar } | { status: 'unavailable' }

function resolveSelectorScalar(
  db: Database,
  table: string,
  column: string,
  selector: Record<string, ScalarValue>,
): ScalarResolution {
  const keys = Object.keys(selector)
  const whereClause = keys.map(k => `${quoteIdentifier(k)} = ?`).join(' AND ')
  const params = keys.map(k => selector[k])
  const rows = db
    .prepare(`SELECT ${quoteIdentifier(column)} AS scalar FROM ${quoteIdentifier(table)} WHERE ${whereClause}`)
    .all(...params) as { scalar: ResolvedScalar }[]
  // REQ-PF2-18: a watched_selector must identify a SINGLE row. 0 or >1 rows
  // is UNAVAILABLE — not an error, not a fire; the caller leaves the
  // snapshot untouched and returns false.
  if (rows.length !== 1) {
    return { status: 'unavailable' }
  }
  return { status: 'ok', value: rows[0].scalar }
}

function resolveAggregateScalar(db: Database, table: string, column: string, agg: StateChangeAggregateFn): ScalarResolution {
  // Fixed allowlist (already enforced at createWatcher() validation time) —
  // the aggregate function name itself is never taken from user input as a
  // raw string; it's selected from this exhaustive switch.
  const fn = agg === 'COUNT' ? 'COUNT(*)' : `${agg}(${quoteIdentifier(column)})`
  const row = db.prepare(`SELECT ${fn} AS scalar FROM ${quoteIdentifier(table)}`).get() as { scalar: ResolvedScalar }
  // An aggregate over a whole table always yields exactly one row/scalar in
  // v1 (COUNT(*) on an empty table is 0; MAX/MIN/SUM on an empty table is
  // SQL NULL) — never UNAVAILABLE, per REQ-PF2-15's "watched_aggregate ...
  // always yields exactly one scalar" note.
  return { status: 'ok', value: row.scalar }
}

/**
 * The minimal shape evaluateStateChangeCondition() needs from a
 * `declarative_watchers` row: its id (to read/write the snapshot columns)
 * and its already-parsed, already-validated condition_spec. Building this
 * from a raw DB row (JSON-parsing condition_spec, discriminating by
 * trigger_type) is the caller's job — PK-PF2-4/5, out of this packet's
 * scope, which is the evaluator itself.
 */
export interface StateChangeWatcherRow {
  id: number
  condition_spec: StateChangeConditionSpec
}

/**
 * ATM-PF2-12/15/16 / REQ-PF2-13/17/18 — Evaluates a `state_change` watcher's
 * condition against LIVE data, inside ONE LOCAL `BEGIN IMMEDIATE`
 * transaction (REQ-PF2-17): (i) resolve the current scalar (watched_selector
 * XOR watched_aggregate — already enforced at createWatcher() validation
 * time, PK-PF2-2), (ii) compare it against the stored
 * `declarative_watchers.last_observed_value` snapshot to detect a
 * false/absent -> true TRANSITION (never fires repeatedly while the
 * predicate stays true — REQ-PF2-13), (iii) atomically persist the new
 * snapshot (`last_observed_value`/`last_observed_at`) in the SAME
 * transaction — REQ-PF2-17(iv) — so the next evaluation compares against
 * fresh data. An UNAVAILABLE resolution (0-row or >1-row watched_selector,
 * REQ-PF2-18) returns `false` WITHOUT throwing and WITHOUT touching the
 * snapshot.
 *
 * `changed` comparator: has no fixed `operand` meaning (unlike
 * eq/ne/gt/lt) — its predicate IS "does the current scalar differ from the
 * stored snapshot", so it fires whenever the value differs from the last
 * observation, EXCEPT on the very first-ever observation (no prior
 * snapshot to have changed from) — consistent with "transition, not
 * level" for every other comparator too.
 */
export function evaluateStateChangeCondition(watcher: StateChangeWatcherRow, db: Database): boolean {
  const spec = watcher.condition_spec
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const resolution: ScalarResolution =
      spec.watched_selector !== undefined
        ? resolveSelectorScalar(db, spec.watched_table, spec.watched_column, spec.watched_selector)
        : resolveAggregateScalar(db, spec.watched_table, spec.watched_column, spec.watched_aggregate as StateChangeAggregateFn)

    if (resolution.status === 'unavailable') {
      // Nothing was written — ROLLBACK is a formality (closes the immediate
      // lock cleanly) rather than a correctness requirement here.
      db.prepare('ROLLBACK').run()
      return false
    }

    const currentScalar = resolution.value
    const priorRow = db
      .prepare('SELECT last_observed_value FROM declarative_watchers WHERE id = ?')
      .get(watcher.id) as { last_observed_value: string | null } | null
    const priorSnapshot: string | null = priorRow?.last_observed_value ?? null

    let fires: boolean
    if (spec.comparator === 'changed') {
      fires = priorSnapshot !== null && stringifyScalar(currentScalar) !== priorSnapshot
    } else {
      const priorPredicateTrue = priorSnapshot === null ? false : comparePredicate(spec.comparator, priorSnapshot, spec.operand)
      const currentPredicateTrue = comparePredicate(spec.comparator, currentScalar, spec.operand)
      fires = !priorPredicateTrue && currentPredicateTrue
    }

    // REQ-PF2-17(iv): persist the new snapshot atomically, in the SAME
    // transaction, on every AVAILABLE evaluation (fired or not) — so the
    // next evaluation always compares against fresh data. Timestamped via
    // SQL's own datetime('now'), not JS Date (purity/static-scan discipline
    // — see the module header).
    db.prepare("UPDATE declarative_watchers SET last_observed_value = ?, last_observed_at = datetime('now') WHERE id = ?")
      .run(stringifyScalar(currentScalar), watcher.id)

    db.prepare('COMMIT').run()
    return fires
  } catch (err) {
    try { db.prepare('ROLLBACK').run() } catch {}
    throw err
  }
}

/** Bounded default for llm_eval's max_tokens when the condition_spec omits it. */
const LLM_EVAL_DEFAULT_MAX_TOKENS = 16

/**
 * The injected LLM client contract for evaluateLlmCondition(). A single
 * bounded call: `complete(prompt, maxTokens)` resolves to the model's raw
 * text reply, or rejects (error/timeout — the client owns its own timeout
 * behavior; the evaluator does not run its own timer). Tests inject a mock
 * implementation — zero real API calls anywhere in this module or its
 * tests.
 */
export interface LlmEvalClient {
  complete(prompt: string, maxTokens: number): Promise<string>
}

/**
 * ATM-PF2-13/REQ-PF2-14 — Evaluates an `llm_eval` watcher's condition via
 * EXACTLY ONE bounded call to the injected `client` (no retry loop — v1 has
 * none; REQ-PF2-14 says "issuing exactly one bounded prompt"). Applies a
 * STRICT boolean output contract: the reply is trimmed and lowercased, and
 * only an exact `"true"` maps to `true` / exact `"false"` maps to `false`.
 * Any other outcome — a non-boolean/ambiguous reply, a thrown error, or a
 * rejected (e.g. timeout-shaped) promise — defaults to `false` and never
 * throws out of this function, so an unreliable LLM call can never cause an
 * ambiguous or accidental fire.
 */
export async function evaluateLlmCondition(spec: LlmEvalConditionSpec, client: LlmEvalClient): Promise<boolean> {
  let raw: string
  try {
    raw = await client.complete(spec.prompt, spec.max_tokens ?? LLM_EVAL_DEFAULT_MAX_TOKENS)
  } catch {
    return false
  }
  const normalized = raw.trim().toLowerCase()
  return normalized === 'true'
}

// ---------------------------------------------------------------------------
// PK-PF2-4 — fireWatcher() + idempotency (ATM-PF2-05/06, REQ-PF2-05/06/16)
// and the getWatchers()/disableWatcher() lifecycle read-contracts
// (ATM-PF2-07, REQ-PF2-07). evaluateWatchers()'s watchdog-tick dispatch
// (REQ-PF2-03/04) is PK-PF2-5's job, out of this packet's FILE BOUNDARY (no
// watchdog.ts/server.ts touch).
// ---------------------------------------------------------------------------

/**
 * The minimal shape fireWatcher() needs from a `declarative_watchers` row:
 * its id (for the firing row's `watcher_id` FK) and its already-parsed
 * `action_spec` (the bounded task-template fields, validated as a plain
 * object at createWatcher() time, PK-PF2-2). Building this from a raw DB
 * row is the caller's job (PK-PF2-5's evaluateWatchers()).
 */
export interface FireableWatcherRow {
  id: number
  action_spec: {
    description: unknown
    to?: unknown
    priority?: unknown
    from?: unknown
  }
}

export interface FireResult {
  fired: boolean
  taskId: number | null
  firingId: number | null
  /** true when this call was rejected because idempotencyKey was already fired (graceful, not an error). */
  alreadyFired: boolean
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

/**
 * Builds the CreateTaskInput fireWatcher() passes to the EXISTING
 * `createTask()` path from a watcher's `action_spec`. `action_spec` was
 * only validated as "a plain object" at createWatcher() time (PK-PF2-2;
 * its deeper task-template field shape was explicitly out of ATM-PF2-14's
 * scope) — so this defensively re-validates the fields `createTask()`
 * actually requires and throws a clear, descriptive error rather than
 * letting a malformed action_spec reach `createTask()` as `undefined`/a
 * wrong type / a value the live schema rejects.
 *
 * PK-PF2-5 FIX (found via this packet's own testing, not present before):
 * `to` is now REQUIRED (non-empty string), same treatment as
 * `description` — NOT defaulted to `null` as an earlier draft of this
 * function did. `CreateTaskInput.to`'s TYPE is `string | null`, but the
 * live `tasks` DDL declares `to_agent TEXT NOT NULL` (db.ts:298) — passing
 * `to: null` through to `createTask()` throws a raw `SQLiteError: NOT NULL
 * constraint failed: tasks.to_agent` from deep inside `createTask()`,
 * *after* the task-creating transaction has already opened, rather than a
 * clear validation error here, before any DB work starts. `priority`
 * remains optional (falls back to `'normal'`, `createTask()`'s own DEFAULT
 * — mirrored here explicitly since `CreateTaskInput` has no default value
 * of its own) — omitting it is a legitimate, addressable-later watcher
 * config, unlike `to`/`description`, which the schema itself requires.
 */
function buildCreateTaskInputFromActionSpec(actionSpec: FireableWatcherRow['action_spec'], fromAgent: string): CreateTaskInput {
  if (typeof actionSpec.description !== 'string' || actionSpec.description.length === 0) {
    throw new Error(
      `fireWatcher(): action_spec.description must be a non-empty string — got ${JSON.stringify(actionSpec.description)}`,
    )
  }
  if (typeof actionSpec.to !== 'string' || actionSpec.to.length === 0) {
    throw new Error(
      `fireWatcher(): action_spec.to must be a non-empty string — got ${JSON.stringify(actionSpec.to)} (tasks.to_agent is NOT NULL, db.ts:298)`,
    )
  }
  return {
    from: fromAgent,
    to: actionSpec.to,
    description: actionSpec.description,
    priority: typeof actionSpec.priority === 'string' && actionSpec.priority.length > 0 ? actionSpec.priority : 'normal',
  }
}

/** The system-agent name fireWatcher() supplies as `from` on the tasks it creates. */
const WATCHER_FIRING_FROM_AGENT = 'system'

/**
 * ATM-PF2-05/REQ-PF2-05/06 — Fires a watcher: creates exactly one task via
 * the EXISTING `createTask()` path (db.ts:1444/1510 — never a new
 * task-creation primitive, REQ-PF2-06) and records exactly one
 * `declarative_watcher_firings` row, atomically, inside ONE LOCAL `BEGIN
 * IMMEDIATE` transaction.
 *
 * `idempotencyKey` is an OPAQUE, caller-supplied string — this function
 * does not derive it. The actual per-trigger-type derivation formula
 * (what makes a given evaluation a distinct "occasion" worth firing once)
 * requires context only `evaluateWatchers()` has (which tick, what `now`
 * was used, which transition fired) — PK-PF2-5's scope. fireWatcher() only
 * needs the key to be a string and relies on the DB-layer
 * `UNIQUE(idempotency_key)` constraint (PK-PF2-1) as the actual fire-once
 * enforcement (REQ-PF2-16) — never an app-level pre-check substituting for
 * it (ATM-PF2-06: "not merely skipped by an app check").
 *
 * ATOMICITY: `taskDb.createTask()` internally does a single raw INSERT
 * against `taskDb`'s own persistent connection (db.ts `run()` is not
 * itself a transaction — see db.ts:281) with no BEGIN/COMMIT of its own,
 * so calling it from INSIDE this function's own `BEGIN IMMEDIATE` (opened
 * on that exact same connection, via `taskDb.run()`) makes the task INSERT
 * part of this transaction. If the SUBSEQUENT firing-row INSERT is
 * rejected by the UNIQUE constraint (a duplicate `idempotencyKey`), the
 * whole transaction — including the task INSERT that already ran — rolls
 * back, so a duplicate fire attempt leaves ZERO orphan task row. The
 * rejection is caught and returned as a graceful `{fired: false,
 * alreadyFired: true}` result, never thrown; any OTHER error (not a UNIQUE
 * violation) still rolls back and rethrows.
 *
 * PK-PF2-5/ATM-PF2-09/REQ-PF2-10 — also appends the `watcher_fired`
 * `audit_log` row, in the SAME transaction as the task + firing `INSERT`s
 * above, ONLY on the genuinely-fired path (never on the already-fired/
 * `alreadyFired` graceful-rejection path — REQ-PF2-10 names one row per
 * actual fire, not per attempt). Same raw-`INSERT`-inside-the-transaction
 * idiom as `persistWatcher()`'s `watcher_created` row above.
 */
export function fireWatcher(taskDb: TaskDB, watcher: FireableWatcherRow, idempotencyKey: string): FireResult {
  return taskDb.run(db => {
    db.prepare('BEGIN IMMEDIATE').run()
    try {
      const task = taskDb.createTask(buildCreateTaskInputFromActionSpec(watcher.action_spec, WATCHER_FIRING_FROM_AGENT))
      const firing = db
        .prepare(`
          INSERT INTO declarative_watcher_firings (watcher_id, created_task_id, idempotency_key)
          VALUES (?, ?, ?)
          RETURNING id
        `)
        .get(watcher.id, task.id, idempotencyKey) as { id: number }
      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, task_id)
        VALUES (?, ?, ?, ?)
      `).run('system', 'watcher_fired', JSON.stringify({ watcher_id: watcher.id, firing_id: firing.id, idempotency_key: idempotencyKey }), task.id)
      db.prepare('COMMIT').run()
      return { fired: true, taskId: task.id, firingId: firing.id, alreadyFired: false }
    } catch (err) {
      try { db.prepare('ROLLBACK').run() } catch {}
      if (isUniqueConstraintViolation(err)) {
        return { fired: false, taskId: null, firingId: null, alreadyFired: true }
      }
      throw err
    }
  })
}

/** A durable `declarative_watchers` row, as returned by getWatchers(). */
export interface DeclarativeWatcherRow {
  id: number
  name: string
  trigger_type: TriggerType
  condition_spec: string
  action_spec: string
  enabled: number
  last_fired_at: string | null
  last_observed_value: string | null
  last_observed_at: string | null
  created_at: string
}

/**
 * ATM-PF2-07/REQ-PF2-07 — Read-only lifecycle contract. Defaults to
 * `enabled=1` only (mirrors PF1's `getSharedPatterns()`'s `activeOnly`
 * default) — the natural input set for a subsequent `evaluateWatchers()`
 * pass (PK-PF2-5). Pass `{enabledOnly: false}` to see disabled watchers
 * too (e.g. for an admin listing). SELECT-only — never writes.
 */
export function getWatchers(db: Database, options: { enabledOnly?: boolean } = {}): DeclarativeWatcherRow[] {
  const enabledOnly = options.enabledOnly ?? true
  const where = enabledOnly ? 'WHERE enabled = 1' : ''
  return db.prepare(`SELECT * FROM declarative_watchers ${where} ORDER BY id ASC`).all() as DeclarativeWatcherRow[]
}

/**
 * ATM-PF2-07/REQ-PF2-07 — Disables a watcher by setting `enabled = 0`.
 * NEVER deletes the row (declarative_watchers rows are never removed by
 * this module). Returns `true` if a row was actually updated, `false` if
 * `watcherId` doesn't exist (no error — a no-op disable is not a failure).
 * A single `UPDATE` statement is already atomic under SQLite's autocommit
 * mode — no explicit transaction wrapper needed.
 */
export function disableWatcher(db: Database, watcherId: number): boolean {
  const result = db.prepare('UPDATE declarative_watchers SET enabled = 0 WHERE id = ?').run(watcherId)
  return result.changes > 0
}

// ---------------------------------------------------------------------------
// PK-PF2-4 hybrid addendum (main's ruling, msg a2661b4f) — computeIdempotencyKey().
// SPEC-SILENT, SADIE-DECIDED ADDITION BEYOND THIS PACKET'S ORIGINAL ATM LIST
// (ATM-PF2-05/06/07 name only fireWatcher()/getWatchers()/disableWatcher()),
// RATIFIED BY MAIN, FLAGGED FOR CODEX REVIEW (see BASELINES.md's PF2-4
// section for the full note + the PF2-6 codex checkpoint on these formulas
// vs. REQ text). Built here, under calm TDD, rather than invented mid-wiring
// inside PK-PF2-5 — fireWatcher() itself only ever consumes an opaque
// caller-supplied idempotencyKey string (see fireWatcher()'s own docstring
// above); this is that string's producer, for PK-PF2-5 to call.
// ---------------------------------------------------------------------------

/**
 * A dynamic segment of an idempotency key. Deliberately narrow (matches
 * `ScalarValue` plus plain strings/numbers) — every value this module ever
 * feeds in is either a resolved DB scalar, a watcher id, a computed bucket
 * number, or an ISO timestamp string.
 */
type KeySegmentValue = string | number | boolean | null

/**
 * Encodes one dynamic segment as a SELF-DELIMITING JSON token —
 * `JSON.stringify` for string/number/boolean/null, or the bare literal
 * `'undefined'` for `undefined` (JSON.stringify(undefined) is itself
 * `undefined`, not a string, so it needs an explicit fallback to keep this
 * encoding TOTAL). This is what makes composeKey() COLLISION-SAFE: every
 * segment is a complete, independently-parseable JSON value (a quoted
 * string with all internal quotes/backslashes escaped, or a bare number/
 * bool/null/the `undefined` literal) — a literal `:` inside a dynamic
 * string value can never be mistaken for the `:` JOIN separator between
 * segments, because it only ever appears INSIDE a quoted segment's escaped
 * content, never adjacent to an unescaped quote boundary. Raw `:`-joined
 * interpolation (no per-segment encoding) does NOT have this property —
 * e.g. `{a:'x', b:'y:z'}` and `{a:'x:y', b:'z'}` both naively join to the
 * identical string `x:y:z`; JSON.stringify-ing each segment first makes
 * them `"x":"y:z"` vs `"x:y":"z"` — distinct.
 *
 * KL-3 CAVEAT (BASELINES.md, PF1's own R4-HIGH finding, card #10376381):
 * this encoding is injective GIVEN ITS INPUT, but SQLite's TEXT column
 * round-trip is documented as LOSSY for lone-surrogate strings (a
 * malformed UTF-16 sequence with no valid UTF-8 representation) — so if a
 * dynamic segment here originated from a value already read back out of
 * SQLite (e.g. `evaluateStateChangeCondition()`'s resolved scalar), two
 * distinct ORIGINAL values could in principle have already collapsed to
 * the same lossy string before ever reaching this function, defeating
 * injectivity upstream of anything this function can control. Accepted
 * for v1 (same disposition as KL-3 itself) — documented here and in
 * BASELINES.md rather than silently assumed away; codex will weigh it.
 */
function encodeKeySegment(value: KeySegmentValue | undefined): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

function composeKey(segments: ReadonlyArray<KeySegmentValue | undefined>): string {
  return segments.map(encodeKeySegment).join(':')
}

/**
 * Discriminated input to computeIdempotencyKey(), one shape per
 * trigger_type — mirrors `ConditionSpec`'s own discriminated-union shape.
 * The caller (PK-PF2-5's `evaluateWatchers()`) is responsible for
 * computing `windowBucket`/`transitionTimestamp`/`evaluationTimestamp`
 * from its own tick/evaluation context; this function only encodes them.
 */
export type IdempotencyKeyInput =
  | { triggerType: 'scheduled'; watcherId: number; windowBucket: number }
  | { triggerType: 'state_change'; watcherId: number; newValue: KeySegmentValue; transitionTimestamp: string }
  | { triggerType: 'llm_eval'; watcherId: number; evaluationTimestamp: string }

/**
 * Computes the OPAQUE (to fireWatcher()) idempotency_key string for one
 * fire-worthy evaluation occasion. PURE — no DB access, no wall-clock read
 * (every timestamp/bucket is caller-supplied). Formulas (ratified by main,
 * amended from sadie's original proposal for collision-safety —
 * see BASELINES.md):
 *
 * - `scheduled`  -> watcherId + 'sched' + windowBucket
 *   (`windowBucket` = `Math.floor(dueTimestamp / interval_seconds)`,
 *   computed by the caller — each new due-window is a fresh occasion; the
 *   SAME window re-evaluated twice before `last_fired_at` updates produces
 *   the SAME key, correctly deduped by the DB UNIQUE constraint.)
 * - `state_change` -> watcherId + 'state' + newValue + transitionTimestamp
 *   (ties the key to the SPECIFIC transition's resulting value + the
 *   timestamp it was observed at — a later, different transition gets a
 *   fresh key.)
 * - `llm_eval` -> watcherId + 'llm' + evaluationTimestamp
 *   (each bounded prompt call is its own occasion; there is no natural
 *   dedup key beyond time for this trigger_type — see the OPEN DESIGN NOTE
 *   in BASELINES.md's PF2-4 section: this makes `llm_eval` idempotency
 *   effectively per-evaluation-only, which REQ-PF2-05/14's text does not
 *   resolve either way. Flagged for PK-PF2-6 codex review, not decided
 *   here.)
 */
export function computeIdempotencyKey(input: IdempotencyKeyInput): string {
  switch (input.triggerType) {
    case 'scheduled':
      return composeKey([input.watcherId, 'sched', input.windowBucket])
    case 'state_change':
      return composeKey([input.watcherId, 'state', input.newValue, input.transitionTimestamp])
    case 'llm_eval':
      return composeKey([input.watcherId, 'llm', input.evaluationTimestamp])
  }
}

// ---------------------------------------------------------------------------
// PK-PF2-5 Stage B — stubLlmEvalClient. KNOWN LIMITATION (main's ruling,
// PF2-5 open item #2): no production LlmEvalClient implementation exists
// anywhere in this codebase — provisioning one is a new outbound-API-call
// capability surface this build explicitly does not build, an activation-
// scope decision (main is escalating a ticket to boss for "production
// LlmEvalClient provisioning," parallel to card #10376381). This stub
// ships instead so `llm_eval` watchers are structurally wired end-to-end
// (evaluateWatchers() dispatches to evaluateLlmCondition() for every
// enabled llm_eval watcher, every tick, per REQ-PF2-03's "additively
// invoke evaluateWatchers()" covering ALL enabled watchers, not a subset)
// but functionally INERT: the stub's reply is deliberately not the exact
// string `'true'`, so evaluateLlmCondition()'s existing strict-boolean
// default-false semantics (PK-PF2-3, REQ-PF2-14) apply and no `llm_eval`
// watcher can ever fire until a real client replaces this stub. See
// BASELINES.md's PF2-5 section for the full KNOWN LIMITATION writeup and
// tracked-TODO framing.
// ---------------------------------------------------------------------------

export const stubLlmEvalClient: LlmEvalClient = {
  async complete(_prompt: string, _maxTokens: number): Promise<string> {
    return 'stub: no production LlmEvalClient provisioned — see BASELINES.md PF2-5 KNOWN LIMITATION'
  },
}
