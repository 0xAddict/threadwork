// verification/attribution-reeval.ts — T3 EPIC-05 (M-006/M-007/M-008/M-011).
//
// Bounded, flag-gated, idempotent, concurrency-safe, operator-attested ONE-SHOT
// re-evaluation that recovers the single genuinely valuable historical case
// (T2/T5 memo): ternary_rewards rows persisted with reward=0 BEFORE attribution
// went live — stale precisely because the agent-family registry was empty at the
// time. It NEVER mutates an original row, NEVER fabricates a critique, is NEVER a
// general backfill and NEVER continuous (all out of scope).
//
// The re-eval RE-DERIVES family/verdict IN MEMORY from the stored
// producer_agent/critic_agent + the critique's own severity (Ground truth #7:
// simply re-invoking finalize-time logic would re-read the same stale
// cross_family_critiques rows and change nothing). cross_family_critiques is
// NEVER written; only NEW subject_kind='decision_reeval' ternary_rewards rows are
// appended for decisions whose recomputed reward is non-zero.
//
// IMPORT ALLOWLIST (REQ-034 / ATM-029): value imports are EXACTLY the read/pure
// symbols {resolveAgentDefaultFamily, evaluateCrossFamily, getCrossFamilyCritiques,
// aggregateCrossFamilyVerdict, assignTernaryReward, getTernaryRewards} plus
// persistTernaryReward as the SOLE host-module WRITE helper; everything else is
// type-only. loadAgentFamilyRegistry is DELIBERATELY not imported — the populated
// registry arrives as the REQUIRED `registry` parameter (REQ-031), composed by
// the invoking runbook.

import type { Database } from 'bun:sqlite'
import {
  resolveAgentDefaultFamily,
  evaluateCrossFamily,
  getCrossFamilyCritiques,
} from './cross-family-critique'
import type { ModelFamily, PersistedCrossFamilyCritique } from './cross-family-critique'
import {
  aggregateCrossFamilyVerdict,
  assignTernaryReward,
  getTernaryRewards,
  persistTernaryReward,
} from './ternary-reward'
import type { TernaryRewardRecord } from './ternary-reward'
import type { CritiqueSeverity } from '../decision'

/** Re-evaluation entry-point options (REQ-013/031). Timestamps are canonical
 *  SQLite datetime text 'YYYY-MM-DD HH:MM:SS' (UTC). */
export interface AttributionReevalOptions {
  /** REQ-031: the populated agent->family registry, supplied EXPLICITLY (the
   *  module never imports loadAgentFamilyRegistry). */
  registry: Readonly<Record<string, ModelFamily>>
  /** Candidate window floor (INCLUSIVE). */
  windowFloor: string
  /** Candidate window ceiling (EXCLUSIVE). */
  windowCeiling: string
  /** Operator-supplied out-of-band activation timestamp (KO-T3-2 — NEVER
   *  feature_flags.created_at). windowCeiling must be <= this. */
  activationTimestamp: string
  /** REQ-028: hard-required operator attestation that no in-window critique
   *  carried an explicit producer/critic model id. */
  attestNoExplicitModelIds: boolean
}

// ---------------------------------------------------------------------------
// TEST-ONLY seams. DELIBERATELY NOT part of AttributionReevalOptions — the
// public runAttributionReeval(db, options) contract carries ZERO test hooks, so
// no production CALLER can influence persistence or completion timing by
// constructing options (codex iter1 P0). A test installs these via
// __setAttributionReevalTestSeamsForTests and MUST reset them afterward. This
// mirrors the codebase's established test-only-export convention
// (agent-family-registry.ts's __resetAgentFamilyRegistryCacheForTests).
// ---------------------------------------------------------------------------
interface _AttributionReevalTestSeams {
  /** ATM-030: substitute the persist helper (e.g. force a null return). */
  persistOverride?: (db: Database, record: TernaryRewardRecord) => number | null
  /** ATM-031: fires between the candidate scan and the completion transaction. */
  afterScanBeforeComplete?: () => void
}
let _testSeams: _AttributionReevalTestSeams | null = null

/** TEST-ONLY (never honored in production): install/clear the re-eval test seams. */
export function __setAttributionReevalTestSeamsForTests(seams: _AttributionReevalTestSeams | null): void {
  _testSeams = seams
}

/**
 * The seams are honored ONLY under `bun test` (which sets NODE_ENV='test').
 * In production NODE_ENV is never 'test', so this returns null REGARDLESS of any
 * __setAttributionReevalTestSeamsForTests call — persistTernaryReward is always
 * the real helper and the completion timing is fixed. This makes the seam
 * production-INERT: no importer can influence runAttributionReeval's behavior
 * (codex iter2 P0).
 */
function _activeTestSeams(): _AttributionReevalTestSeams | null {
  return process.env.NODE_ENV === 'test' ? _testSeams : null
}

export type AttributionReevalStatus = 'skipped_existing_run' | 'refused' | 'aborted' | 'complete'

export interface AttributionReevalResult {
  status: AttributionReevalStatus
  reason?: string
  rowsScanned: number
  rowsReassessed: number
  rowsSkipped: number
}

const _ZERO_COUNTS = { rowsScanned: 0, rowsReassessed: 0, rowsSkipped: 0 } as const

/**
 * PURE in-memory equivalent of SQLite datetime round-trip validity (REQ-037,
 * Algorithm step 0 — issues ZERO SQL): a value is valid iff it matches the
 * canonical 'YYYY-MM-DD HH:MM:SS' shape AND is a real calendar date/time, so it
 * rejects shape-valid-but-impossible values (`'2026-02-30 12:00:00'`,
 * `'25:00:00'`) exactly as SQLite's strftime round-trip would NULL/normalize
 * them, plus ISO 'T'-separated, date-only, timezone-suffixed, and empty strings
 * (shape mismatch).
 */
export function isCanonicalSqliteDatetime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (!m) return false
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[]
  if (mo < 1 || mo > 12) return false
  if (h > 23 || mi > 59 || s > 59) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  if (d < 1 || d > daysInMonth) return false
  return true
}

function isFlagOn(db: Database, name: string): boolean {
  const row = db.prepare('SELECT enabled FROM feature_flags WHERE flag_name = ?').get(name) as
    | { enabled: number }
    | null
  return !!row && row.enabled === 1
}

function isUniquenessConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}

/** A concurrent writer holds the write lock (SQLite BUSY / locked). */
function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg)
}

/**
 * REQ-030 best-effort audit cross-check: any in-window audit_log
 * 'decision_critique_submitted' row whose detail JSON carries a
 * producer_model_id/critic_model_id key. At 900750f the detail records NO
 * model-id fields (Ground truth #21), so the control path never hits — this is
 * defense-in-depth, not proof of absence.
 */
function auditHasExplicitModelId(db: Database, floor: string, ceiling: string): boolean {
  const rows = db
    .prepare(
      "SELECT detail FROM audit_log WHERE action = 'decision_critique_submitted' AND created_at >= ? AND created_at < ?",
    )
    .all(floor, ceiling) as { detail: string | null }[]
  for (const r of rows) {
    if (!r.detail) continue
    try {
      const obj = JSON.parse(r.detail) as Record<string, unknown>
      if ('producer_model_id' in obj || 'critic_model_id' in obj) return true
    } catch {
      // Unparseable detail — ignore (best-effort).
    }
  }
  return false
}

function readCritiqueSeverity(db: Database, critiqueId: number | null): CritiqueSeverity | null {
  if (critiqueId === null) return null
  const row = db.prepare('SELECT severity FROM decision_critiques WHERE id = ?').get(critiqueId) as
    | { severity: string }
    | null
  if (!row || typeof row.severity !== 'string') return null
  return row.severity as CritiqueSeverity
}

function hasDecisionReeval(db: Database, decisionId: number): boolean {
  const row = db
    .prepare("SELECT 1 FROM ternary_rewards WHERE decision_id = ? AND subject_kind = 'decision_reeval' LIMIT 1")
    .get(decisionId)
  return !!row
}

/**
 * Re-derive each of a decision's cross_family_critiques rows IN MEMORY: recompute
 * a family ONLY when its STORED value is exactly 'unknown' (REQ-016/REQ-035 —
 * sound within the attested window per the spec's Provenance basis), then
 * re-evaluate is_cross_family/verdict via evaluateCrossFamily() on the
 * (possibly-updated) family pair + the critique's own severity. The
 * cross_family_critiques table is NEVER written.
 */
export function recomputeDecisionCritiques(
  db: Database,
  decisionId: number,
  registry: Readonly<Record<string, ModelFamily>>,
): PersistedCrossFamilyCritique[] {
  const critiques = getCrossFamilyCritiques(db, { decisionId })
  return critiques.map((c) => {
    const newProducerFamily =
      c.producer_family === 'unknown' ? resolveAgentDefaultFamily(c.producer_agent, registry) : c.producer_family
    const newCriticFamily =
      c.critic_family === 'unknown' ? resolveAgentDefaultFamily(c.critic_agent, registry) : c.critic_family
    const severity = readCritiqueSeverity(db, c.critique_id)
    const evaluation = evaluateCrossFamily({
      // Runtime-defensive over non-ModelFamily strings (forward-compat widening);
      // cast satisfies the typed input contract.
      producer_family: newProducerFamily as ModelFamily,
      critic_family: newCriticFamily as ModelFamily,
      critic_severity: severity,
    })
    return {
      ...c,
      producer_family: newProducerFamily,
      critic_family: newCriticFamily,
      is_cross_family: evaluation.is_cross_family,
      verdict: evaluation.verdict,
    }
  })
}

/**
 * Step 2 (REQ-024/025): SHORT claim transaction. Inside ONE LOCAL BEGIN
 * IMMEDIATE — atomically RE-CHECK emptiness (a row may have appeared since the
 * step-0 check), INSERT the singleton claim row, COMMIT. Returns false (aborts)
 * on a lost re-check OR a singleton-uniqueness conflict (concurrent claim). The
 * transaction is CLOSED before any candidate read / persistTernaryReward call.
 */
function claimRun(db: Database, floor: string, ceiling: string): boolean {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const still = db.prepare('SELECT id FROM attribution_reeval_runs LIMIT 1').get()
    if (still) {
      db.prepare('ROLLBACK').run()
      return false
    }
    db.prepare(
      "INSERT INTO attribution_reeval_runs (singleton_key, status, window_floor, window_ceiling) VALUES (1, 'running', ?, ?)",
    ).run(floor, ceiling)
    db.prepare('COMMIT').run()
    return true
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    } catch {
      // already rolled back / no active txn
    }
    // Lost the claim under concurrency: a singleton-uniqueness conflict OR a
    // write-lock contention (SQLITE_BUSY) from a simultaneous claimer — abort
    // without scanning (REQ-024/025; the spec's "fails the re-check or the
    // singleton INSERT" concurrent-loser path).
    if (isUniquenessConflict(err) || isBusy(err)) return false
    throw err
  }
}

/**
 * Step 4 (REQ-020/036): completion transaction. Inside its OWN LOCAL BEGIN
 * IMMEDIATE — atomically re-check BOTH governing flags, and only then UPDATE the
 * claim row to 'complete' + counts. If either flag is OFF at the re-check,
 * ROLLBACK and leave status='running' (operator recovery). Returns whether the
 * completion committed.
 */
function completeRun(db: Database, scanned: number, reassessed: number, skipped: number): boolean {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    if (!isFlagOn(db, 'cross_family_attribution_enabled') || !isFlagOn(db, 'ternary_reward_enabled')) {
      db.prepare('ROLLBACK').run()
      return false
    }
    db.prepare(
      "UPDATE attribution_reeval_runs SET status = 'complete', rows_scanned = ?, rows_reassessed = ?, rows_skipped = ?, completed_at = datetime('now') WHERE singleton_key = 1",
    ).run(scanned, reassessed, skipped)
    db.prepare('COMMIT').run()
    return true
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    } catch {
      // already rolled back / no active txn
    }
    throw err
  }
}

/**
 * runAttributionReeval — the single bounded one-time neutral-0 re-eval entry
 * point (REQ-013). See the module header + the T3 spec EPIC-05 Algorithm for the
 * step-by-step contract. Returns a structured result; never leaves an open
 * transaction on any path.
 */
export function runAttributionReeval(db: Database, options: AttributionReevalOptions): AttributionReevalResult {
  // Algorithm step 0 (REQ-014/ATM-013): FIRST operation — run-row existence
  // short-circuit. Exactly ONE SELECT; if ANY row exists (running OR complete),
  // return immediately with NO further read/write of any kind.
  const existing = db.prepare('SELECT id FROM attribution_reeval_runs LIMIT 1').get()
  if (existing) {
    return { status: 'skipped_existing_run', reason: 'a run row already exists', ..._ZERO_COUNTS }
  }

  // Step 1 gates. In-memory (zero-SQL) validations FIRST so an invalid
  // invocation refuses with zero side effects; the SQL gates (flags, audit)
  // follow only once the arguments are well-formed.
  if (options.attestNoExplicitModelIds !== true) {
    return { status: 'refused', reason: 'attestNoExplicitModelIds not exactly true (REQ-028)', ..._ZERO_COUNTS }
  }
  if (
    !isCanonicalSqliteDatetime(options.windowFloor) ||
    !isCanonicalSqliteDatetime(options.windowCeiling) ||
    !isCanonicalSqliteDatetime(options.activationTimestamp)
  ) {
    return { status: 'refused', reason: 'a timestamp failed round-trip validity (REQ-037)', ..._ZERO_COUNTS }
  }
  if (!(options.windowFloor < options.windowCeiling)) {
    return { status: 'refused', reason: 'windowFloor not strictly < windowCeiling (REQ-038)', ..._ZERO_COUNTS }
  }
  if (!(options.windowCeiling <= options.activationTimestamp)) {
    return { status: 'refused', reason: 'windowCeiling after activationTimestamp (REQ-029)', ..._ZERO_COUNTS }
  }
  if (!isFlagOn(db, 'cross_family_attribution_enabled') || !isFlagOn(db, 'ternary_reward_enabled')) {
    return { status: 'refused', reason: 'a governing flag is OFF (REQ-021)', ..._ZERO_COUNTS }
  }
  if (auditHasExplicitModelId(db, options.windowFloor, options.windowCeiling)) {
    return { status: 'refused', reason: 'an in-window audit row records an explicit model id (REQ-030)', ..._ZERO_COUNTS }
  }

  // Step 2: claim (SHORT txn), CLOSED before any candidate read.
  if (!claimRun(db, options.windowFloor, options.windowCeiling)) {
    return { status: 'refused', reason: 'claim lost — concurrent run (REQ-024/025)', ..._ZERO_COUNTS }
  }

  // Step 3: candidate scan — reward=0 subject_kind='decision' rows in
  // [windowFloor, windowCeiling) (floor-inclusive, ceiling-exclusive; REQ-033).
  const persist = _activeTestSeams()?.persistOverride ?? persistTernaryReward
  const candidates = getTernaryRewards(db, { reward: 0, since: options.windowFloor }).filter(
    (r) => r.subject_kind === 'decision' && r.created_at < options.windowCeiling,
  )

  let rowsScanned = 0
  let rowsReassessed = 0
  let rowsSkipped = 0
  const reassessedThisRun = new Set<number>()

  for (const cand of candidates) {
    rowsScanned++
    const decisionId = cand.decision_id
    if (decisionId === null) {
      rowsSkipped++
      continue
    }
    // Per-decision guard (belt): an existing decision_reeval row OR one already
    // persisted this run -> skip (REQ-015).
    if (reassessedThisRun.has(decisionId) || hasDecisionReeval(db, decisionId)) {
      rowsSkipped++
      continue
    }

    const recomputed = recomputeDecisionCritiques(db, decisionId, options.registry)
    const newVerdict = aggregateCrossFamilyVerdict(recomputed)
    const assessment = assignTernaryReward({
      cross_family_verdict: newVerdict,
      failure_severity: cand.failure_severity,
      failure_signal_available: cand.failure_signal_available,
    })
    if (assessment.reward === 0) {
      // Still neutral -> persist nothing (REQ-019): no redundant neutral-0 noise.
      continue
    }

    let insertedId: number | null
    try {
      insertedId = persist(db, {
        policy_version: assessment.policy_version,
        decision_id: decisionId,
        task_id: cand.task_id,
        subject_kind: 'decision_reeval',
        cross_family_verdict: newVerdict,
        failure_severity: cand.failure_severity,
        failure_signal_available: cand.failure_signal_available,
        reward: assessment.reward,
      })
    } catch (err) {
      // REQ-027/ATM-026: a per-decision uniqueness conflict (the suspenders
      // index) -> count skipped for this decision only and continue.
      if (isUniquenessConflict(err)) {
        rowsSkipped++
        continue
      }
      throw err
    }

    // REQ-032/ATM-030: a null return (ternary_reward_enabled raced OFF mid-run)
    // aborts the run WITHOUT the completion marker — status stays 'running'.
    if (insertedId === null) {
      return {
        status: 'aborted',
        reason: 'persistTernaryReward returned null — flag raced OFF (REQ-032)',
        rowsScanned,
        rowsReassessed,
        rowsSkipped,
      }
    }
    reassessedThisRun.add(decisionId)
    rowsReassessed++
  }

  // TEST-ONLY seam (ATM-031): fires after the scan, before completion.
  _activeTestSeams()?.afterScanBeforeComplete?.()

  // Step 4: completion — re-check BOTH flags atomically, then mark complete.
  if (!completeRun(db, rowsScanned, rowsReassessed, rowsSkipped)) {
    return {
      status: 'aborted',
      reason: 'a governing flag was OFF at the completion re-check (REQ-036)',
      rowsScanned,
      rowsReassessed,
      rowsSkipped,
    }
  }

  return { status: 'complete', rowsScanned, rowsReassessed, rowsSkipped }
}
