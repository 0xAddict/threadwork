// verification/failure-classification.ts — P6 typed failure classification.
//
// EPIC-01 (Taxonomy): the canonical, versioned FailureClass taxonomy plus
// three orthogonal classification axes (severity / transience / domain).
//
// This stage does NOT implement classifyFailure(), adapters, persistence, or
// the read accessor — those are implemented in later build Stages (2-7). See
// ~/.claude/state/p4-p8-fanout/build-p6/PLAN.md and specs/P6-spec.md.
//
// Isolation: this module has ZERO runtime dependency on decision.ts or db.ts.
// Guardrail tests (tests/failure-classification.test.ts, ATM-004) import
// CritiqueSeverity / BlockedOn as TYPES ONLY, read-only, for compile-time
// drift detection — never imported here.

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
