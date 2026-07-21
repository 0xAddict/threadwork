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
  if (typeof spec.watched_table !== 'string' || spec.watched_table.length === 0) {
    throw new Error(`createWatcher(): state_change condition_spec.watched_table must be a non-empty string`)
  }
  if (typeof spec.watched_column !== 'string' || spec.watched_column.length === 0) {
    throw new Error(`createWatcher(): state_change condition_spec.watched_column must be a non-empty string`)
  }
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
