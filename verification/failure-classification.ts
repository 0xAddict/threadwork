// verification/failure-classification.ts — P6 typed failure classification.
//
// EPIC-01 (Taxonomy): the canonical, versioned FailureClass taxonomy plus
// three orthogonal classification axes (severity / transience / domain).
//
// EPIC-02 (this stage's addition, below): the FailureClassification record
// type, the RawFailureSignal discriminated union, and the pure
// classifyFailure() table-driven classifier.
//
// This stage does NOT implement adapters (fromVerifyCheckResult etc.),
// persistence, migrate(), or the read accessor — those are implemented in
// later build Stages (3-7). See ~/.claude/state/p4-p8-fanout/build-p6/PLAN.md
// and specs/P6-spec.md.
//
// Isolation: this module has ZERO RUNTIME dependency on decision.ts or
// db.ts. Guardrail tests (tests/failure-classification.test.ts, ATM-004)
// import CritiqueSeverity / BlockedOn as TYPES ONLY, read-only, for
// compile-time drift detection. EPIC-02 below imports BlockedOn as a TYPE
// ONLY from db.ts (via `import type`, erased at compile time — zero runtime
// dependency) so RawFailureSignal's watchdog_blocked variant can express its
// blocked_on field precisely.

import type { BlockedOn } from '../db'
import type { Database } from 'bun:sqlite'

// ---------------------------------------------------------------------------
// ATM-001 / REQ-001 [P1] — Canonical versioned FailureClass
// ---------------------------------------------------------------------------

/**
 * The canonical failure classification. Append-only: see TAXONOMY_CHANGELOG
 * and the ATM-002 guardrail — ANY change to this member set, including an
 * append-only addition, requires bumping TAXONOMY_VERSION and adding a
 * TAXONOMY_CHANGELOG entry.
 */
export type FailureClass =
  | 'verification_failure'
  | 'test_failure'
  | 'liveness_timeout'
  | 'blocked_dependency'
  | 'infrastructure_transient'
  | 'contract_scope_conformance'
  | 'resource_budget_exhaustion'
  | 'correctness_adversarial_finding'
  | 'unknown'

/**
 * Taxonomy schema version. Bump on ANY change to the FailureClass member set
 * (append-only additions are NOT exempt) and add a matching
 * TAXONOMY_CHANGELOG entry. Enforced by the ATM-002 guardrail test against
 * tests/fixtures/failure-classification-taxonomy.snapshot.json.
 */
export const TAXONOMY_VERSION: number = 1

/** Append-only changelog of taxonomy version bumps. Empty at v1. */
export const TAXONOMY_CHANGELOG: { version: number; change: string }[] = []

// Runtime mirror of the FailureClass union, in the same order as declared
// above. `satisfies readonly FailureClass[]` plus the bidirectional
// exhaustiveness check below ensure this tuple and the FailureClass union
// cannot silently drift apart — adding a member to one without the other
// breaks `_failureClassExhaustive`'s assignment at compile time (G1).
const _failureClassesTuple = [
  'verification_failure',
  'test_failure',
  'liveness_timeout',
  'blocked_dependency',
  'infrastructure_transient',
  'contract_scope_conformance',
  'resource_budget_exhaustion',
  'correctness_adversarial_finding',
  'unknown',
] as const satisfies readonly FailureClass[]

type _FailureClassTupleMember = (typeof _failureClassesTuple)[number]
type _FailureClassExhaustive = [FailureClass] extends [_FailureClassTupleMember]
  ? [_FailureClassTupleMember] extends [FailureClass]
    ? true
    : ['ALL_FAILURE_CLASSES has member(s) not in the FailureClass union']
  : ['FailureClass union has member(s) missing from ALL_FAILURE_CLASSES']
const _failureClassExhaustive: _FailureClassExhaustive = true
void _failureClassExhaustive

export const ALL_FAILURE_CLASSES: readonly FailureClass[] = Object.freeze(_failureClassesTuple)

// ---------------------------------------------------------------------------
// ATM-003 / REQ-002 [P1] — Three orthogonal classification axes
// ---------------------------------------------------------------------------

export type FailureSeverity = 'low' | 'medium' | 'high' | 'critical'

const _failureSeveritiesTuple = [
  'low',
  'medium',
  'high',
  'critical',
] as const satisfies readonly FailureSeverity[]

type _FailureSeverityTupleMember = (typeof _failureSeveritiesTuple)[number]
type _FailureSeverityExhaustive = [FailureSeverity] extends [_FailureSeverityTupleMember]
  ? [_FailureSeverityTupleMember] extends [FailureSeverity]
    ? true
    : ['ALL_FAILURE_SEVERITIES has member(s) not in the FailureSeverity union']
  : ['FailureSeverity union has member(s) missing from ALL_FAILURE_SEVERITIES']
const _failureSeverityExhaustive: _FailureSeverityExhaustive = true
void _failureSeverityExhaustive

export const ALL_FAILURE_SEVERITIES: readonly FailureSeverity[] = Object.freeze(_failureSeveritiesTuple)

export type FailureTransience = 'transient' | 'permanent' | 'unknown'

const _failureTransiencesTuple = [
  'transient',
  'permanent',
  'unknown',
] as const satisfies readonly FailureTransience[]

type _FailureTransienceTupleMember = (typeof _failureTransiencesTuple)[number]
type _FailureTransienceExhaustive = [FailureTransience] extends [_FailureTransienceTupleMember]
  ? [_FailureTransienceTupleMember] extends [FailureTransience]
    ? true
    : ['ALL_FAILURE_TRANSIENCES has member(s) not in the FailureTransience union']
  : ['FailureTransience union has member(s) missing from ALL_FAILURE_TRANSIENCES']
const _failureTransienceExhaustive: _FailureTransienceExhaustive = true
void _failureTransienceExhaustive

export const ALL_FAILURE_TRANSIENCES: readonly FailureTransience[] = Object.freeze(_failureTransiencesTuple)

export type FailureDomain =
  | 'agent'
  | 'human'
  | 'external_api'
  | 'infrastructure'
  | 'upstream_task'
  | 'system'
  | 'unknown'

const _failureDomainsTuple = [
  'agent',
  'human',
  'external_api',
  'infrastructure',
  'upstream_task',
  'system',
  'unknown',
] as const satisfies readonly FailureDomain[]

type _FailureDomainTupleMember = (typeof _failureDomainsTuple)[number]
type _FailureDomainExhaustive = [FailureDomain] extends [_FailureDomainTupleMember]
  ? [_FailureDomainTupleMember] extends [FailureDomain]
    ? true
    : ['ALL_FAILURE_DOMAINS has member(s) not in the FailureDomain union']
  : ['FailureDomain union has member(s) missing from ALL_FAILURE_DOMAINS']
const _failureDomainExhaustive: _FailureDomainExhaustive = true
void _failureDomainExhaustive

export const ALL_FAILURE_DOMAINS: readonly FailureDomain[] = Object.freeze(_failureDomainsTuple)

// ---------------------------------------------------------------------------
// ATM-005 / REQ-003 [P1] — FailureClassification record + RawFailureSignal
// ---------------------------------------------------------------------------

/**
 * The result of classifying a raw failure signal.
 *
 * Deliberately has NO timestamp / classified_at field: classifyFailure() is
 * GENUINELY PURE (no Date/Date.now/performance.now/datetime(), no
 * randomness, no I/O, no side effects). The persisted `created_at` is
 * stamped later, at persist time, by Stage 3 — not here.
 */
export interface FailureClassification {
  failure_class: FailureClass
  severity: FailureSeverity
  transience: FailureTransience
  domain: FailureDomain
  taxonomy_version: number
  signal_source: string
  source_ref: string | null
  task_id: number | null
  agent: string | null
  summary: string
  raw_signal: unknown
}

/**
 * Fields common to the RawFailureSignal variants that carry task/agent/
 * summary context (verify_check, test_run, verify_idle_count,
 * watchdog_fault, watchdog_blocked, watchdog_dead_session, manual).
 */
interface _SignalContext {
  task_id?: number
  agent?: string
  summary?: string
}

/**
 * The 9 recognized raw-failure-signal shapes, discriminated on `source`.
 * classifyFailure() maps each variant (plus sub-conditions where noted) to a
 * FailureClassification via the authoritative 16-row mapping table (see
 * classifyFailure()'s doc comment below).
 */
export type RawFailureSignal =
  | ({
      source: 'verify_check'
      /** The CheckResult id — carried through to source_ref so the SG-13
       * exclusion is expressible upstream. The exclusion itself is the
       * Stage-5 adapter's job; classifyFailure just maps unconditionally. */
      checkResultId: string
    } & _SignalContext)
  | ({
      source: 'test_run'
    } & _SignalContext)
  | ({
      source: 'verify_idle_count'
      /** Checked against IDLE_COUNT_STAGNATION_THRESHOLD. */
      idle_count: number
    } & _SignalContext)
  | ({
      source: 'watchdog_fault'
      /** Branches on 'crash' | 'timeout'; anything else falls to unknown. */
      faultType: string
    } & _SignalContext)
  | ({
      source: 'watchdog_blocked'
      /** Type-only import from ../db — zero runtime dependency on db.ts. */
      blocked_on: BlockedOn | null
    } & _SignalContext)
  | ({
      source: 'watchdog_dead_session'
    } & _SignalContext)
  | {
      source: 'escalation_bridge_all_paths_failed'
      agent?: string
      summary?: string
      /** May hold the step/agent identifier. */
      source_ref?: string
    }
  | {
      source: 'adversarial_finding'
      category: string
      severityHint: string
      verifierName?: string
      summary?: string
    }
  | ({
      source: 'manual'
    } & _SignalContext)

/**
 * Idle-count stagnation threshold (mapping-table row 3): a verify_idle_count
 * signal with idle_count >= this value classifies as
 * resource_budget_exhaustion. Also consumed by the Stage-5 adapter.
 */
export const IDLE_COUNT_STAGNATION_THRESHOLD = 3

// ---------------------------------------------------------------------------
// ATM-006/007/008/009 / REQ-004 [P1/P2] — classifyFailure()
// ---------------------------------------------------------------------------

/** adversarial_finding categories that map to contract_scope_conformance (mapping-table row 14). */
const _CONTRACT_SCOPE_CATEGORIES: ReadonlySet<string> = new Set([
  'scope_conformance',
  'verifiability',
  'ears_conformance',
  'traceability',
  'classifier_rigor',
  'consumption_contract',
])

function _toNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function _toNullableString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function _toSummary(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** severityHint sub-rule (mapping-table rows 13-15): case-sensitive, defaults to 'medium'. */
function _mapSeverityHint(hint: unknown): FailureSeverity {
  if (hint === 'HIGH') return 'high'
  if (hint === 'MEDIUM' || hint === 'MED') return 'medium'
  return 'medium'
}

type _ClassificationQuad = Pick<FailureClassification, 'failure_class' | 'severity' | 'transience' | 'domain'>

/** Row 16: manual / unrecognized source / malformed required fields. */
const _UNKNOWN_QUAD: _ClassificationQuad = {
  failure_class: 'unknown',
  severity: 'medium',
  transience: 'unknown',
  domain: 'unknown',
}

/**
 * classifyFailure() — pure, deterministic, table-driven mapping from a
 * RawFailureSignal to a FailureClassification, keyed on signal.source (and
 * sub-condition). Encodes the authoritative 16-row mapping table:
 *
 *  1  verify_check                          (unconditional)          -> verification_failure / medium   / transient / agent
 *  2  test_run                              (unconditional)          -> test_failure          / high     / transient / agent
 *  3  verify_idle_count   idle_count >= 3                            -> resource_budget_exhaustion / medium / permanent / agent
 *  4  watchdog_fault      faultType==='crash'                        -> liveness_timeout      / critical / transient / agent
 *  5  watchdog_fault      faultType==='timeout'                      -> liveness_timeout      / high     / transient / agent
 *  6  watchdog_blocked    blocked_on==='human'                       -> blocked_dependency     / low      / transient / human
 *  7  watchdog_blocked    blocked_on==='external_api'                -> blocked_dependency     / medium   / transient / external_api
 *  8  watchdog_blocked    blocked_on==='upstream_task'                -> blocked_dependency     / low      / transient / upstream_task
 *  9  watchdog_blocked    blocked_on==='agent'                       -> blocked_dependency     / low      / transient / agent
 *  10 watchdog_blocked    blocked_on===null / legacy                 -> blocked_dependency     / low      / transient / unknown
 *  11 watchdog_dead_session               (unconditional)            -> liveness_timeout       / critical / permanent / agent
 *  12 escalation_bridge_all_paths_failed  (unconditional)            -> infrastructure_transient / critical / transient / infrastructure
 *  13 adversarial_finding category==='correctness'                  -> correctness_adversarial_finding / hint-mapped / permanent / system
 *  14 adversarial_finding category in contract-scope set            -> contract_scope_conformance      / hint-mapped / permanent / system
 *  15 adversarial_finding other/unrecognized category                -> unknown                / hint-mapped / permanent / system
 *  16 manual / unrecognized source / malformed required fields      -> unknown                / medium      / unknown   / unknown
 *
 * PURITY CONTRACT: no Date, no Date.now, no performance.now, no datetime(),
 * no randomness, no I/O, no side effects — see ATM-008's source-level
 * guardrail test. Never throws — see ATM-007/ATM-009: any unrecognized
 * source or malformed/missing/wrong-type required field falls to the row-16
 * unknown fallback. Tolerates circular references in the input signal (this
 * function never JSON-serializes the signal — raw_signal below stores a
 * plain object reference).
 */
export function classifyFailure(signal: RawFailureSignal): FailureClassification {
  // Deliberately untyped local view: at runtime the input may not actually
  // satisfy RawFailureSignal (ATM-007/ATM-009 feed malformed/cast values).
  // Every read below is defensive (optional chaining + typeof narrowing) so
  // no property access can throw, even for null/undefined/primitive/
  // circular-referenced signals.
  const s: any = signal
  const source: unknown = s !== null && s !== undefined ? s.source : undefined

  const base = {
    taxonomy_version: TAXONOMY_VERSION,
    signal_source: typeof source === 'string' ? source : 'unknown',
    source_ref: _toNullableString(s?.source_ref ?? s?.checkResultId),
    task_id: _toNullableNumber(s?.task_id),
    agent: _toNullableString(s?.agent),
    summary: _toSummary(s?.summary),
    raw_signal: signal,
  }

  let quad: _ClassificationQuad

  switch (source) {
    case 'verify_check': {
      // Row 1 — unconditional. The SG-13 exclusion is the Stage-5 adapter's
      // job (it simply never emits a verify_check signal for an excluded
      // check); classifyFailure maps every verify_check it receives.
      quad = { failure_class: 'verification_failure', severity: 'medium', transience: 'transient', domain: 'agent' }
      break
    }
    case 'test_run': {
      // Row 2 — unconditional (the adapter only emits on tests_pass===false).
      quad = { failure_class: 'test_failure', severity: 'high', transience: 'transient', domain: 'agent' }
      break
    }
    case 'verify_idle_count': {
      // Row 3, else row 16.
      const idleCount = s?.idle_count
      if (typeof idleCount === 'number' && Number.isFinite(idleCount) && idleCount >= IDLE_COUNT_STAGNATION_THRESHOLD) {
        quad = { failure_class: 'resource_budget_exhaustion', severity: 'medium', transience: 'permanent', domain: 'agent' }
      } else {
        quad = { ..._UNKNOWN_QUAD }
      }
      break
    }
    case 'watchdog_fault': {
      // Rows 4-5, else row 16.
      const faultType = s?.faultType
      if (faultType === 'crash') {
        quad = { failure_class: 'liveness_timeout', severity: 'critical', transience: 'transient', domain: 'agent' }
      } else if (faultType === 'timeout') {
        quad = { failure_class: 'liveness_timeout', severity: 'high', transience: 'transient', domain: 'agent' }
      } else {
        quad = { ..._UNKNOWN_QUAD }
      }
      break
    }
    case 'watchdog_blocked': {
      // Rows 6-10 — every blocked_on value (including null/legacy/
      // unrecognized) resolves to blocked_dependency; only the domain and
      // severity vary.
      const blockedOn = s?.blocked_on
      switch (blockedOn) {
        case 'human':
          quad = { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'human' }
          break
        case 'external_api':
          quad = { failure_class: 'blocked_dependency', severity: 'medium', transience: 'transient', domain: 'external_api' }
          break
        case 'upstream_task':
          quad = { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'upstream_task' }
          break
        case 'agent':
          quad = { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'agent' }
          break
        default:
          // Row 10 — null / legacy / any unrecognized blocked_on value.
          quad = { failure_class: 'blocked_dependency', severity: 'low', transience: 'transient', domain: 'unknown' }
          break
      }
      break
    }
    case 'watchdog_dead_session': {
      // Row 11 — unconditional.
      quad = { failure_class: 'liveness_timeout', severity: 'critical', transience: 'permanent', domain: 'agent' }
      break
    }
    case 'escalation_bridge_all_paths_failed': {
      // Row 12 — unconditional.
      quad = { failure_class: 'infrastructure_transient', severity: 'critical', transience: 'transient', domain: 'infrastructure' }
      break
    }
    case 'adversarial_finding': {
      // Rows 13-15.
      const category = s?.category
      const severity = _mapSeverityHint(s?.severityHint)
      if (category === 'correctness') {
        quad = { failure_class: 'correctness_adversarial_finding', severity, transience: 'permanent', domain: 'system' }
      } else if (typeof category === 'string' && _CONTRACT_SCOPE_CATEGORIES.has(category)) {
        quad = { failure_class: 'contract_scope_conformance', severity, transience: 'permanent', domain: 'system' }
      } else {
        quad = { failure_class: 'unknown', severity, transience: 'permanent', domain: 'system' }
      }
      break
    }
    case 'manual':
    default: {
      // Row 16 — manual, or any source not recognized above.
      quad = { ..._UNKNOWN_QUAD }
      break
    }
  }

  return { ...base, ...quad }
}

// ---------------------------------------------------------------------------
// ATM-020 / REQ-009 [P1] — persistFailureClassification() (Stage 3, EPIC-04)
// ---------------------------------------------------------------------------

/**
 * Persists a FailureClassification as a durable, append-only row in
 * failure_classifications (migrate()'d in db.ts), plus a matching audit_log
 * row — both inside ONE LOCAL 'BEGIN IMMEDIATE' transaction, so a failure on
 * either write rolls back both (REQ-018/ATM-030 two-direction fault
 * injection). Gated on the failure_classification_enabled feature flag
 * (REQ-010/ATM-021): when the flag row is missing or `enabled` is not
 * exactly 1, this returns null WITHOUT opening any transaction or inserting
 * any row.
 *
 * Deliberately takes a raw `db: Database` handle (not a TaskDB) so this
 * module stays free of any TaskDB coupling beyond the type-only BlockedOn
 * import already present above. Atomicity here comes from the LOCAL
 * 'BEGIN IMMEDIATE'/'COMMIT'/'ROLLBACK' below — the same inline pattern used
 * by decision.ts's finalizeDecision()/expireDecision() — NOT from any P5
 * write-ordering helper (the write-transaction wrapper or sequence minter
 * that ships in a sibling module). This module imports neither of those P5
 * symbols (REQ-012/ATM-023): build-order independence from P5 is structural,
 * not just a runtime coincidence.
 */
export function persistFailureClassification(
  db: Database,
  classification: FailureClassification,
): number | null {
  // REQ-010/ATM-021: flag gate, checked BEFORE any transaction is opened.
  const flagRow = db
    .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'failure_classification_enabled'")
    .get() as { enabled: number } | null
  if (!flagRow || flagRow.enabled !== 1) {
    return null
  }

  // Tolerate circular / non-serializable raw_signal without throwing.
  let rawJson: string | null
  try {
    rawJson = JSON.stringify(classification.raw_signal) ?? null
  } catch {
    rawJson = null
  }

  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const inserted = db
      .prepare(`
        INSERT INTO failure_classifications (
          taxonomy_version, failure_class, severity, transience, domain,
          signal_source, source_ref, task_id, agent, summary, raw_signal_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .get(
        classification.taxonomy_version,
        classification.failure_class,
        classification.severity,
        classification.transience,
        classification.domain,
        classification.signal_source,
        classification.source_ref,
        classification.task_id,
        classification.agent,
        classification.summary,
        rawJson,
      ) as { id: number }

    // REQ-018/ATM-030: audit row, same local transaction. detail always
    // carries failure_class; task_id/agent are included only when present.
    const detail: Record<string, unknown> = { failure_class: classification.failure_class }
    if (classification.task_id !== null && classification.task_id !== undefined) {
      detail.task_id = classification.task_id
    }
    if (classification.agent !== null && classification.agent !== undefined) {
      detail.agent = classification.agent
    }

    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, task_id)
      VALUES (?, ?, ?, ?)
    `).run(classification.agent ?? 'system', 'failure_classified', JSON.stringify(detail), classification.task_id)

    db.prepare('COMMIT').run()
    return inserted.id
  } catch (err) {
    try { db.prepare('ROLLBACK').run() } catch {}
    throw err
  }
}

// ---------------------------------------------------------------------------
// ATM-024 / REQ-013 [P1] — getFailureClassifications() (Stage 4, EPIC-05)
// ---------------------------------------------------------------------------

/**
 * A durable failure_classifications row, as read back by
 * getFailureClassifications(). Widens `failure_class` from the closed
 * FailureClass union to `FailureClass | string` (via Omit + intersection,
 * NOT a bare interface-extends, since extends cannot widen a member) so a
 * row written by a future taxonomy version — carrying a failure_class value
 * this build doesn't recognize — still deserializes without loss (see
 * ATM-026). `id` and `created_at` are part of the stable contract P7/P8
 * build against.
 */
export type PersistedFailureClassification = Omit<FailureClassification, 'failure_class'> & {
  failure_class: FailureClass | string
  id: number
  created_at: string
}

/**
 * Reads durable failure_classifications rows back out, in ascending id
 * order, optionally narrowed by task_id / agent / failure_class / a
 * created_at floor (`since`, inclusive). Read-only (SELECT only — never
 * INSERT/UPDATE/DELETE) and performs no scoring or synthesis of its own: it
 * is a pass-through accessor over what persistFailureClassification already
 * wrote. `failure_class` and `taxonomy_version` are copied through AS-IS,
 * with no validation or coercion, so a row from a newer taxonomy version
 * stays intact for an older build reading it (forward compatibility).
 */
export function getFailureClassifications(
  db: Database,
  filter?: { taskId?: number; agent?: string; failureClass?: FailureClass; since?: string },
): PersistedFailureClassification[] {
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (filter?.taskId !== undefined) {
    clauses.push('task_id = ?')
    params.push(filter.taskId)
  }
  if (filter?.agent !== undefined) {
    clauses.push('agent = ?')
    params.push(filter.agent)
  }
  if (filter?.failureClass !== undefined) {
    clauses.push('failure_class = ?')
    params.push(filter.failureClass)
  }
  if (filter?.since !== undefined) {
    clauses.push('created_at >= ?')
    params.push(filter.since)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM failure_classifications ${where} ORDER BY id ASC`)
    .all(...params) as any[]

  return rows.map((row): PersistedFailureClassification => {
    let rawSignal: unknown = null
    if (row.raw_signal_json !== null && row.raw_signal_json !== undefined) {
      try {
        rawSignal = JSON.parse(row.raw_signal_json)
      } catch {
        rawSignal = null
      }
    }

    return {
      id: row.id,
      taxonomy_version: row.taxonomy_version,
      failure_class: row.failure_class,
      severity: row.severity,
      transience: row.transience,
      domain: row.domain,
      signal_source: row.signal_source,
      source_ref: row.source_ref,
      task_id: row.task_id,
      agent: row.agent,
      summary: row.summary,
      raw_signal: rawSignal,
      created_at: row.created_at,
    }
  })
}
