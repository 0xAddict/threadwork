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
