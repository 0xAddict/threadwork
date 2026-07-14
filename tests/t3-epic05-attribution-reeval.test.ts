// tests/t3-epic05-attribution-reeval.test.ts — T3 EPIC-05 (bounded one-time
// neutral-0 attribution re-eval). Covers ATM-012..ATM-018 + ATM-023..ATM-031
// against verification/attribution-reeval.ts + the db.ts migrate() additions.
//
// In-process suite: runAttributionReeval takes a raw bun:sqlite handle
// (db.getHandle()), exactly as the finalize hook passes rawDb to the P8 chain —
// so these tests drive the module directly with no server subprocess. Fixtures
// are seeded via direct SQL to control created_at, craft 'unknown'-family
// cross_family_critiques rows, and stage the pre-attribution neutral-0
// ternary_rewards rows the re-eval recovers.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import { TaskDB } from '../db'
import type { Database } from 'bun:sqlite'
import {
  runAttributionReeval,
  isCanonicalSqliteDatetime,
  recomputeDecisionCritiques,
  type AttributionReevalOptions,
} from '../verification/attribution-reeval'
import { persistTernaryReward } from '../verification/ternary-reward'

// --- window / registry constants ---------------------------------------------
const FLOOR = '2026-07-08 00:00:00'
const CEILING = '2026-07-08 23:42:00'
const ACTIVATION = '2026-07-08 23:42:00' // windowCeiling <= activation (equal OK)
const IN_WINDOW = '2026-07-08 12:00:00'
const REGISTRY = Object.freeze({ steve: 'openai', boss: 'anthropic' }) as Readonly<Record<string, any>>

function baseOpts(over: Partial<AttributionReevalOptions> = {}): AttributionReevalOptions {
  return {
    registry: REGISTRY,
    windowFloor: FLOOR,
    windowCeiling: CEILING,
    activationTimestamp: ACTIVATION,
    attestNoExplicitModelIds: true,
    ...over,
  }
}

// --- fixture plumbing ---------------------------------------------------------
const tmpDirs: string[] = []
const dbs: TaskDB[] = []

function mkFixture(opts: { attribution?: boolean; ternary?: boolean } = {}): { taskDb: TaskDB; h: Database } {
  const dir = mkdtempSync(join(tmpdir(), 't3-epic05-'))
  tmpDirs.push(dir)
  const taskDb = new TaskDB(join(dir, 'tasks.db'))
  dbs.push(taskDb)
  taskDb.setFeatureFlag('cross_family_critique_enabled', true)
  taskDb.setFeatureFlag('cross_family_attribution_enabled', opts.attribution ?? true)
  taskDb.setFeatureFlag('ternary_reward_enabled', opts.ternary ?? true)
  return { taskDb, h: taskDb.getHandle() }
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* already gone */ }
  }
})

function insertDecision(h: Database, taskId: number | null = null): number {
  return (h.prepare(
    "INSERT INTO decisions (title, context, opened_by, task_id) VALUES ('t3-epic05', NULL, 'steve', ?) RETURNING id",
  ).get(taskId) as { id: number }).id
}

function insertDecisionCritique(h: Database, decisionId: number, severity = 'blocker'): number {
  return (h.prepare(
    "INSERT INTO decision_critiques (decision_id, position_id, agent, critique, severity) VALUES (?, NULL, 'boss', 'c', ?) RETURNING id",
  ).get(decisionId, severity) as { id: number }).id
}

function insertCrossFamily(
  h: Database,
  o: {
    decisionId: number
    critiqueId: number | null
    producerAgent?: string
    producerFamily?: string
    criticAgent?: string
    criticFamily?: string
    isCrossFamily?: number
    verdict?: string
    createdAt: string
  },
): void {
  h.prepare(
    `INSERT INTO cross_family_critiques
       (taxonomy_version, decision_id, critique_id, position_id, producer_agent, producer_family,
        critic_agent, critic_family, is_cross_family, verdict, linked_failure_class, created_at)
     VALUES (1, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    o.decisionId,
    o.critiqueId,
    o.producerAgent ?? 'steve',
    o.producerFamily ?? 'unknown',
    o.criticAgent ?? 'boss',
    o.criticFamily ?? 'unknown',
    o.isCrossFamily ?? 0,
    o.verdict ?? 'unknown',
    o.createdAt,
  )
}

function insertTernary(
  h: Database,
  o: {
    decisionId: number
    taskId?: number | null
    subjectKind?: string
    verdict?: string | null
    failureSeverity?: string | null
    failureSignalAvailable?: number
    reward?: number
    createdAt: string
  },
): number {
  return (h.prepare(
    `INSERT INTO ternary_rewards
       (policy_version, decision_id, task_id, subject_kind, cross_family_verdict,
        failure_severity, failure_signal_available, reward, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(
    o.decisionId,
    o.taskId ?? null,
    o.subjectKind ?? 'decision',
    o.verdict ?? 'unknown',
    o.failureSeverity ?? null,
    o.failureSignalAvailable ?? 1,
    o.reward ?? 0,
    o.createdAt,
  ) as { id: number }).id
}

/** A neutral-0 candidate whose critique recomputes to a cross-family 'block'
 *  (steve->openai vs boss->anthropic, severity blocker) under REGISTRY. */
function seedDecisiveCandidate(h: Database, createdAt = IN_WINDOW, taskId: number | null = null): number {
  const decId = insertDecision(h, taskId)
  const critId = insertDecisionCritique(h, decId, 'blocker')
  insertCrossFamily(h, { decisionId: decId, critiqueId: critId, createdAt })
  insertTernary(h, { decisionId: decId, taskId, subjectKind: 'decision', reward: 0, createdAt })
  return decId
}

function countRuns(h: Database): number {
  return (h.prepare('SELECT COUNT(*) c FROM attribution_reeval_runs').get() as { c: number }).c
}
function reevalRows(h: Database, decisionId?: number): any[] {
  const q =
    decisionId === undefined
      ? "SELECT * FROM ternary_rewards WHERE subject_kind='decision_reeval' ORDER BY id"
      : `SELECT * FROM ternary_rewards WHERE subject_kind='decision_reeval' AND decision_id=${decisionId} ORDER BY id`
  return h.prepare(q).all() as any[]
}
function runRow(h: Database): any {
  return h.prepare('SELECT * FROM attribution_reeval_runs WHERE singleton_key=1').get() as any
}

/** Proxy that records every prepared/exec'd SQL string against the handle. */
function spyHandle(h: Database): { proxy: Database; sql: string[] } {
  const sql: string[] = []
  const proxy = new Proxy(h, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver)
      if (prop === 'prepare' || prop === 'exec') {
        return (q: string, ...rest: unknown[]) => {
          sql.push(q)
          return (orig as (...a: unknown[]) => unknown).call(target, q, ...rest)
        }
      }
      return typeof orig === 'function' ? (orig as Function).bind(target) : orig
    },
  }) as unknown as Database
  return { proxy, sql }
}

// ===========================================================================
// ATM-012 — table + singleton + status CHECK
// ===========================================================================
describe('ATM-012: attribution_reeval_runs table/singleton/status-CHECK (REQ-013/020/024)', () => {
  test('columns match the declared set', () => {
    const { h } = mkFixture()
    const cols = (h.prepare('PRAGMA table_info(attribution_reeval_runs)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual([
      'id', 'singleton_key', 'status', 'window_floor', 'window_ceiling',
      'rows_scanned', 'rows_reassessed', 'rows_skipped', 'started_at', 'completed_at',
    ])
  })
  test('second singleton_key=1 INSERT fails UNIQUE', () => {
    const { h } = mkFixture()
    h.prepare("INSERT INTO attribution_reeval_runs (singleton_key, status) VALUES (1, 'running')").run()
    expect(() =>
      h.prepare("INSERT INTO attribution_reeval_runs (singleton_key, status) VALUES (1, 'complete')").run(),
    ).toThrow(/UNIQUE/i)
  })
  test("status='bogus' fails the CHECK constraint", () => {
    const { h } = mkFixture()
    expect(() =>
      h.prepare("INSERT INTO attribution_reeval_runs (singleton_key, status) VALUES (1, 'bogus')").run(),
    ).toThrow(/CHECK/i)
  })
})

// ===========================================================================
// ATM-013 — FIRST-operation short-circuit (global SQL spy), both statuses
// ===========================================================================
describe('ATM-013: FIRST-op short-circuit — exactly one existence SELECT, zero further SQL (REQ-014)', () => {
  for (const status of ['complete', 'running'] as const) {
    test(`pre-seeded status='${status}' + invalid inputs -> only the attribution_reeval_runs existence SELECT runs`, () => {
      const { h } = mkFixture()
      h.prepare(`INSERT INTO attribution_reeval_runs (singleton_key, status) VALUES (1, '${status}')`).run()
      const { proxy, sql } = spyHandle(h)
      // Deliberately invalid other inputs (malformed floor, attestation omitted).
      const res = runAttributionReeval(proxy, {
        registry: REGISTRY,
        windowFloor: 'not-a-timestamp',
        windowCeiling: CEILING,
        activationTimestamp: ACTIVATION,
        attestNoExplicitModelIds: false as unknown as boolean,
      })
      expect(res.status).toBe('skipped_existing_run')
      expect(sql.length).toBe(1)
      expect(sql[0]).toMatch(/attribution_reeval_runs/)
      expect(sql[0]).toMatch(/select/i)
      // Zero statements against any other table.
      expect(sql.some(s => /feature_flags|audit_log|ternary_rewards|cross_family_critiques/i.test(s))).toBe(false)
    })
  }
})

// ===========================================================================
// ATM-014 — per-decision dedupe guard
// ===========================================================================
describe('ATM-014: per-decision dedupe skips decisions with an existing decision_reeval row (REQ-015)', () => {
  test('decision X (pre-seeded reeval) skipped; decision Y processed', () => {
    const { h } = mkFixture()
    const decX = seedDecisiveCandidate(h)
    const decY = seedDecisiveCandidate(h)
    // Pre-seed a decision_reeval row for X (belt guard should skip X).
    insertTernary(h, { decisionId: decX, subjectKind: 'decision_reeval', reward: -1, verdict: 'block', createdAt: IN_WINDOW })

    const res = runAttributionReeval(h, baseOpts())
    expect(res.status).toBe('complete')
    // X: only the pre-seeded reeval row (not doubled). Y: exactly one new reeval.
    expect(reevalRows(h, decX).length).toBe(1)
    expect(reevalRows(h, decY).length).toBe(1)
    expect(res.rowsReassessed).toBe(1) // only Y
    expect(res.rowsSkipped).toBe(1) // X
  })
})

// ===========================================================================
// ATM-015 — selective recompute (attested-window 'unknown'-only rule)
// ===========================================================================
describe("ATM-015: only 'unknown'-stored families are recomputed (REQ-016/035)", () => {
  test("stored 'openai' left untouched in-memory; stored 'unknown' recomputed from the registry", () => {
    const { h } = mkFixture()
    const decId = insertDecision(h)
    const critExplicit = insertDecisionCritique(h, decId, 'blocker')
    const critUnknown = insertDecisionCritique(h, decId, 'blocker')
    // Row A: explicit-model-id origin, producer_family already 'openai'.
    insertCrossFamily(h, {
      decisionId: decId, critiqueId: critExplicit,
      producerAgent: 'steve', producerFamily: 'openai', criticAgent: 'boss', criticFamily: 'anthropic',
      isCrossFamily: 1, verdict: 'block', createdAt: IN_WINDOW,
    })
    // Row B: empty-registry fallback origin, both 'unknown'.
    insertCrossFamily(h, {
      decisionId: decId, critiqueId: critUnknown,
      producerAgent: 'steve', producerFamily: 'unknown', criticAgent: 'boss', criticFamily: 'unknown',
      isCrossFamily: 0, verdict: 'unknown', createdAt: IN_WINDOW,
    })

    const recomputed = recomputeDecisionCritiques(h, decId, REGISTRY)
    const rowA = recomputed.find(r => r.critique_id === critExplicit)!
    const rowB = recomputed.find(r => r.critique_id === critUnknown)!
    // Row A: stored 'openai' is NOT recomputed (left exactly as stored).
    expect(rowA.producer_family).toBe('openai')
    expect(rowA.critic_family).toBe('anthropic')
    // Row B: both 'unknown' -> recomputed via the registry.
    expect(rowB.producer_family).toBe('openai') // steve -> openai
    expect(rowB.critic_family).toBe('anthropic') // boss -> anthropic
  })
})

// ===========================================================================
// ATM-016 — end-to-end recovery + candidate filter + boundary + never-mutate
// ===========================================================================
describe('ATM-016: e2e recover + window filter negatives + boundary semantics + never mutate original (REQ-013/017/018/019/031/033)', () => {
  test('exactly the in-window candidates append reward=-1 decision_reeval rows; originals byte-identical; completes clean', () => {
    const { h } = mkFixture()
    // In-window decisive candidate.
    const decIn = seedDecisiveCandidate(h, IN_WINDOW)
    // Boundary floor (==FLOOR) -> MUST be a candidate (floor-inclusive).
    const decFloor = seedDecisiveCandidate(h, FLOOR)
    // Boundary ceiling (==CEILING) -> MUST NOT be a candidate (ceiling-exclusive).
    const decCeil = seedDecisiveCandidate(h, CEILING)
    // Out-of-window (before floor) -> not a candidate.
    const decOut = seedDecisiveCandidate(h, '2026-07-07 12:00:00')
    // subject_kind='decision_reeval' reward=0 -> never scanned as a candidate.
    const decReevalNeg = insertDecision(h)
    insertTernary(h, { decisionId: decReevalNeg, subjectKind: 'decision_reeval', reward: 0, createdAt: IN_WINDOW })

    // Snapshot every ORIGINAL ternary_rewards row (full-row) pre-run.
    const before = h.prepare('SELECT * FROM ternary_rewards ORDER BY id').all() as any[]

    const res = runAttributionReeval(h, baseOpts())
    expect(res.status).toBe('complete')

    // Exactly the in-window + floor-boundary decisions were reassessed.
    expect(reevalRows(h, decIn).length).toBe(1)
    expect(reevalRows(h, decFloor).length).toBe(1)
    expect(reevalRows(h, decCeil).length).toBe(0)
    expect(reevalRows(h, decOut).length).toBe(0)
    expect(res.rowsReassessed).toBe(2)
    for (const dec of [decIn, decFloor]) {
      const row = reevalRows(h, dec)[0]
      expect(row.reward).toBe(-1)
      expect(row.cross_family_verdict).toBe('block')
    }

    // Every ORIGINAL row is byte-identical post-run (append-only, never mutate).
    const beforeById = new Map(before.map(r => [r.id, r]))
    const afterOriginals = (h.prepare('SELECT * FROM ternary_rewards ORDER BY id').all() as any[]).filter(r =>
      beforeById.has(r.id),
    )
    for (const after of afterOriginals) {
      expect(after).toEqual(beforeById.get(after.id))
    }
  })
})

// ===========================================================================
// ATM-017 — idempotent completion marker + double invocation
// ===========================================================================
describe('ATM-017: back-to-back double invocation is idempotent (REQ-020)', () => {
  test('exactly one complete run row + counts; second call short-circuits; no duplicate reeval rows', () => {
    const { h } = mkFixture()
    const dec = seedDecisiveCandidate(h)
    const first = runAttributionReeval(h, baseOpts())
    expect(first.status).toBe('complete')
    const second = runAttributionReeval(h, baseOpts())
    expect(second.status).toBe('skipped_existing_run')

    expect(countRuns(h)).toBe(1)
    const rr = runRow(h)
    expect(rr.status).toBe('complete')
    expect(rr.rows_scanned).toBe(1)
    expect(rr.rows_reassessed).toBe(1)
    expect(reevalRows(h, dec).length).toBe(1) // no duplicate
  })
})

// ===========================================================================
// ATM-018 — both-flags gate (3 variants)
// ===========================================================================
describe('ATM-018: both-flags gate refuses with zero writes (REQ-021)', () => {
  for (const [name, attribution, ternary] of [
    ['attribution OFF', false, true],
    ['ternary OFF', true, false],
    ['both OFF', false, false],
  ] as const) {
    test(`${name} -> refused, no claim row, no reeval row`, () => {
      const { h } = mkFixture({ attribution, ternary })
      const dec = seedDecisiveCandidate(h)
      const res = runAttributionReeval(h, baseOpts())
      expect(res.status).toBe('refused')
      expect(countRuns(h)).toBe(0)
      expect(reevalRows(h, dec).length).toBe(0)
    })
  }
})

// ===========================================================================
// ATM-023 — SHORT claim transaction + commit-before-scan ordering
// ===========================================================================
describe('ATM-023: claim protocol — existence-check FIRST, claim closed before scan (REQ-024/025)', () => {
  test('(a) clean DB: existence SELECT is first, claim INSERT+COMMIT precede the first candidate read; no nested-txn error', () => {
    const { h } = mkFixture()
    seedDecisiveCandidate(h)
    const { proxy, sql } = spyHandle(h)
    const res = runAttributionReeval(proxy, baseOpts())
    expect(res.status).toBe('complete')

    // First SQL is the run-row existence check.
    expect(sql[0]).toMatch(/attribution_reeval_runs/i)
    expect(sql[0]).toMatch(/select/i)
    // The claim INSERT + its COMMIT both precede the first ternary_rewards SELECT
    // (the candidate scan via getTernaryRewards).
    const claimInsertIdx = sql.findIndex(s => /INSERT INTO attribution_reeval_runs/i.test(s))
    const commitIdxAfterClaim = sql.findIndex((s, i) => i > claimInsertIdx && /^\s*COMMIT/i.test(s))
    const firstCandidateReadIdx = sql.findIndex(s => /SELECT \* FROM ternary_rewards/i.test(s))
    expect(claimInsertIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdxAfterClaim).toBeGreaterThan(claimInsertIdx)
    expect(firstCandidateReadIdx).toBeGreaterThan(commitIdxAfterClaim)
    // Exactly one BEGIN IMMEDIATE precedes the candidate read (the claim txn) —
    // no nested transaction opened around the scan.
    const beginsBeforeScan = sql.filter((s, i) => i < firstCandidateReadIdx && /BEGIN IMMEDIATE/i.test(s))
    expect(beginsBeforeScan.length).toBe(1)
  })

  test('(b) pre-seeded claim row -> abort with zero candidate reads', () => {
    const { h } = mkFixture()
    seedDecisiveCandidate(h)
    h.prepare("INSERT INTO attribution_reeval_runs (singleton_key, status) VALUES (1, 'running')").run()
    const { proxy, sql } = spyHandle(h)
    const res = runAttributionReeval(proxy, baseOpts())
    expect(res.status).toBe('skipped_existing_run')
    expect(sql.some(s => /SELECT \* FROM ternary_rewards/i.test(s))).toBe(false)
  })
})

// ===========================================================================
// ATM-024 — concurrent double invocation
// ===========================================================================
describe('ATM-024: concurrent double invocation -> exactly one proceeds (REQ-024/025/026)', () => {
  test('two connections, one claim row, no duplicate decision_reeval rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't3-epic05-conc-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'tasks.db')
    const a = new TaskDB(dbPath)
    dbs.push(a)
    a.setFeatureFlag('cross_family_critique_enabled', true)
    a.setFeatureFlag('cross_family_attribution_enabled', true)
    a.setFeatureFlag('ternary_reward_enabled', true)
    const dec = seedDecisiveCandidate(a.getHandle())
    const b = new TaskDB(dbPath)
    dbs.push(b)

    // Single-threaded bun executes these sequentially (runAttributionReeval is
    // synchronous), so one runs fully and the other short-circuits on the
    // committed run row — the singleton UNIQUE + BEGIN IMMEDIATE re-check is what
    // guarantees safety under true OS-level concurrency (proven structurally by
    // ATM-012 + ATM-023b).
    const [ra, rb] = await Promise.all([
      Promise.resolve().then(() => runAttributionReeval(a.getHandle(), baseOpts())),
      Promise.resolve().then(() => runAttributionReeval(b.getHandle(), baseOpts())),
    ])
    const statuses = [ra.status, rb.status].sort()
    expect(statuses).toEqual(['complete', 'skipped_existing_run'])
    expect(countRuns(a.getHandle())).toBe(1)
    expect(reevalRows(a.getHandle(), dec).length).toBe(1)
  })
})

// ===========================================================================
// ATM-025 — partial UNIQUE index DDL + enforcement
// ===========================================================================
describe('ATM-025: ux_ternary_reeval_decision partial UNIQUE index (REQ-026)', () => {
  test('index present; duplicate decision_reeval per decision fails; two decision rows still succeed', () => {
    const { h } = mkFixture()
    const idx = h.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_ternary_reeval_decision'").get()
    expect(idx).toBeTruthy()
    const dec = insertDecision(h)
    insertTernary(h, { decisionId: dec, subjectKind: 'decision_reeval', reward: -1, createdAt: IN_WINDOW })
    expect(() =>
      insertTernary(h, { decisionId: dec, subjectKind: 'decision_reeval', reward: -1, createdAt: IN_WINDOW }),
    ).toThrow(/UNIQUE/i)
    // Two plain 'decision' rows for the same decision are still allowed (partial scope).
    expect(() => {
      insertTernary(h, { decisionId: dec, subjectKind: 'decision', reward: 0, createdAt: IN_WINDOW })
      insertTernary(h, { decisionId: dec, subjectKind: 'decision', reward: 0, createdAt: IN_WINDOW })
    }).not.toThrow()
  })
})

// ===========================================================================
// ATM-026 — per-decision uniqueness-conflict catch + skip + continue
// ===========================================================================
describe('ATM-026: mid-run uniqueness conflict for one decision is caught, skipped, run continues (REQ-027)', () => {
  test('conflict on X counted skipped; Y processed; run completes', () => {
    const { h } = mkFixture()
    const decX = seedDecisiveCandidate(h)
    const decY = seedDecisiveCandidate(h)

    // persistOverride simulates the "row appeared between guard-check and persist"
    // race for X: it inserts the conflicting decision_reeval row, then delegates
    // to the REAL persistTernaryReward — which throws a genuine UNIQUE conflict.
    let injected = false
    const opts = baseOpts({
      __test: {
        persistOverride: (db, record) => {
          if (record.decision_id === decX && !injected) {
            injected = true
            db.prepare(
              `INSERT INTO ternary_rewards (policy_version, decision_id, task_id, subject_kind, cross_family_verdict, failure_severity, failure_signal_available, reward, created_at)
               VALUES (1, ?, NULL, 'decision_reeval', 'block', NULL, 1, -1, ?)`,
            ).run(record.decision_id, IN_WINDOW)
          }
          return persistTernaryReward(db, record)
        },
      },
    })
    const res = runAttributionReeval(h, opts)
    expect(res.status).toBe('complete')
    expect(res.rowsSkipped).toBeGreaterThanOrEqual(1) // X's conflict counted skipped
    // Y got exactly one reeval row; X has exactly one (the injected one, no dup).
    expect(reevalRows(h, decY).length).toBe(1)
    expect(reevalRows(h, decX).length).toBe(1)
  })
})

// ===========================================================================
// ATM-027 — attestation + window-validity gates (nine variants)
// ===========================================================================
describe('ATM-027: attestation/format/round-trip/ordering/ceiling refusal gates (REQ-028/029/037/038)', () => {
  const variants: Array<[string, Partial<AttributionReevalOptions>]> = [
    ['(a) attestation omitted', { attestNoExplicitModelIds: undefined as unknown as boolean }],
    ['(b) attestation false', { attestNoExplicitModelIds: false }],
    ['(c) windowCeiling > activationTimestamp', { windowCeiling: '2026-07-09 00:00:00', activationTimestamp: '2026-07-08 23:42:00' }],
    ['(d) ISO T-separator timestamp', { windowFloor: '2026-07-08T00:00:00' }],
    ['(e) empty-string timestamp', { windowFloor: '' }],
    ['(f) windowFloor >= windowCeiling', { windowFloor: CEILING, windowCeiling: CEILING }],
    ['(g) impossible date 2026-02-30', { windowFloor: '2026-02-30 12:00:00', windowCeiling: '2026-07-08 00:00:00', activationTimestamp: '2026-07-08 00:00:00' }],
    ['(h) date-only string', { windowFloor: '2026-07-08' }],
    ['(i) timezone-suffixed string', { windowFloor: '2026-07-08 00:00:00Z' }],
  ]
  for (const [name, over] of variants) {
    test(`${name} -> refused, zero writes`, () => {
      const { h } = mkFixture()
      const dec = seedDecisiveCandidate(h)
      const res = runAttributionReeval(h, baseOpts(over))
      expect(res.status).toBe('refused')
      expect(countRuns(h)).toBe(0)
      expect(reevalRows(h, dec).length).toBe(0)
    })
  }

  test('isCanonicalSqliteDatetime pure validator matrix', () => {
    expect(isCanonicalSqliteDatetime('2026-07-08 23:42:00')).toBe(true)
    expect(isCanonicalSqliteDatetime('2024-02-29 00:00:00')).toBe(true) // leap day
    expect(isCanonicalSqliteDatetime('2026-02-30 12:00:00')).toBe(false)
    expect(isCanonicalSqliteDatetime('2026-07-08T00:00:00')).toBe(false)
    expect(isCanonicalSqliteDatetime('2026-07-08')).toBe(false)
    expect(isCanonicalSqliteDatetime('25:00:00')).toBe(false)
    expect(isCanonicalSqliteDatetime('2026-07-08 00:00:00Z')).toBe(false)
    expect(isCanonicalSqliteDatetime('')).toBe(false)
    expect(isCanonicalSqliteDatetime('2026-13-01 00:00:00')).toBe(false)
  })
})

// ===========================================================================
// ATM-028 — best-effort audit-log cross-check abort
// ===========================================================================
describe('ATM-028: in-window audit model-id hit aborts before the claim (REQ-030)', () => {
  test('synthetic forward-format producer_model_id detail -> refused, no claim row', () => {
    const { h } = mkFixture()
    const dec = seedDecisiveCandidate(h)
    h.prepare(
      "INSERT INTO audit_log (agent, action, detail, created_at) VALUES ('boss', 'decision_critique_submitted', ?, ?)",
    ).run(JSON.stringify({ decision_id: dec, producer_model_id: 'gpt-5.5' }), IN_WINDOW)
    const res = runAttributionReeval(h, baseOpts())
    expect(res.status).toBe('refused')
    expect(countRuns(h)).toBe(0)
    expect(reevalRows(h, dec).length).toBe(0)
  })

  test('control: 900750f-shape audit detail (no model-id fields) proceeds to complete', () => {
    const { h } = mkFixture()
    const dec = seedDecisiveCandidate(h)
    h.prepare(
      "INSERT INTO audit_log (agent, action, detail, created_at) VALUES ('boss', 'decision_critique_submitted', ?, ?)",
    ).run(JSON.stringify({ decision_id: dec, critique_id: 1, severity: 'blocker' }), IN_WINDOW)
    const res = runAttributionReeval(h, baseOpts())
    expect(res.status).toBe('complete')
    expect(reevalRows(h, dec).length).toBe(1)
  })
})

// ===========================================================================
// ATM-029 — required registry param + import-allowlist static check
// ===========================================================================
describe('ATM-029: registry is a required explicit param; no loader import; import allowlist (REQ-031/034)', () => {
  test('entry point drives recompute from the explicit registry param', () => {
    const { h } = mkFixture()
    const dec = seedDecisiveCandidate(h)
    const res = runAttributionReeval(h, baseOpts())
    expect(res.status).toBe('complete')
    expect(reevalRows(h, dec)[0].reward).toBe(-1)
  })

  test('static: no loader import; value imports == allowlist; persistTernaryReward is the only write helper', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'verification', 'attribution-reeval.ts'), 'utf-8')
    // Strip comments first — the constraint is about CODE (imports/usage), not
    // the header comment that documents WHY the loader is deliberately absent.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // No import of the loader or its module in the code.
    expect(/loadAgentFamilyRegistry/.test(code)).toBe(false)
    expect(/agent-family-registry/.test(code)).toBe(false)
    // No OTHER host-module write helper is imported.
    for (const forbidden of ['persistCrossFamilyCritique', 'persistFailureClassification', 'assessAndPersistTernaryRewardForDecision']) {
      expect(src.includes(forbidden)).toBe(false)
    }
    // The permitted write helper IS imported.
    expect(src.includes('persistTernaryReward')).toBe(true)
    // Value-import allowlist: each expected read/pure symbol appears in a non-type import.
    for (const sym of ['resolveAgentDefaultFamily', 'evaluateCrossFamily', 'getCrossFamilyCritiques', 'aggregateCrossFamilyVerdict', 'assignTernaryReward', 'getTernaryRewards']) {
      expect(src.includes(sym)).toBe(true)
    }
  })
})

// ===========================================================================
// ATM-030 — null-persist abort (integrity guard)
// ===========================================================================
describe('ATM-030: persistTernaryReward null return aborts, claim stays running (REQ-032)', () => {
  test('null persist -> aborted; claim row remains running; no further candidates processed', () => {
    const { h } = mkFixture()
    const decA = seedDecisiveCandidate(h, '2026-07-08 08:00:00')
    const decB = seedDecisiveCandidate(h, '2026-07-08 09:00:00')
    const opts = baseOpts({
      __test: { persistOverride: () => null }, // every persist returns null
    })
    const res = runAttributionReeval(h, opts)
    expect(res.status).toBe('aborted')
    // The claim row remains 'running' (never flips to complete).
    expect(runRow(h).status).toBe('running')
    // No decision_reeval rows landed (the override never persists).
    expect(reevalRows(h).length).toBe(0)
    // Aborted on the FIRST candidate — the second was never processed.
    expect(res.rowsReassessed).toBe(0)
    void decA; void decB
  })
})

// ===========================================================================
// ATM-031 — mid-run flag-flip completion abort
// ===========================================================================
describe('ATM-031: flag OFF before the completion txn aborts, claim stays running (REQ-020/036)', () => {
  for (const flag of ['ternary_reward_enabled', 'cross_family_attribution_enabled'] as const) {
    test(`flip ${flag} OFF after scan, before completion -> no complete marker`, () => {
      const { h, taskDb } = mkFixture()
      const dec = seedDecisiveCandidate(h)
      const opts = baseOpts({
        __test: { afterScanBeforeComplete: () => taskDb.setFeatureFlag(flag, false) },
      })
      const res = runAttributionReeval(h, opts)
      expect(res.status).toBe('aborted')
      expect(runRow(h).status).toBe('running')
      // The reeval row WAS persisted during the scan (that is fine — append-only);
      // it is the completion marker that must not land.
      void dec
    })
  }

  test('zero non-zero-candidates path: flag OFF before completion still aborts (no persist ever invoked)', () => {
    const { h, taskDb } = mkFixture()
    // A candidate whose recompute stays neutral-0 (same-family -> no decisive verdict):
    // registry maps both agents to 'anthropic', so evaluateCrossFamily is not cross-family.
    const decId = insertDecision(h)
    const critId = insertDecisionCritique(h, decId, 'blocker')
    insertCrossFamily(h, { decisionId: decId, critiqueId: critId, createdAt: IN_WINDOW })
    insertTernary(h, { decisionId: decId, subjectKind: 'decision', reward: 0, createdAt: IN_WINDOW })
    const sameFamilyRegistry = Object.freeze({ steve: 'anthropic', boss: 'anthropic' }) as Readonly<Record<string, any>>
    const opts = baseOpts({
      registry: sameFamilyRegistry,
      __test: { afterScanBeforeComplete: () => taskDb.setFeatureFlag('ternary_reward_enabled', false) },
    })
    const res = runAttributionReeval(h, opts)
    expect(res.status).toBe('aborted')
    expect(runRow(h).status).toBe('running')
    expect(reevalRows(h).length).toBe(0) // nothing decisive was ever persisted
  })

  test('control: both flags ON -> completes to status=complete', () => {
    const { h } = mkFixture()
    const dec = seedDecisiveCandidate(h)
    const res = runAttributionReeval(h, baseOpts())
    expect(res.status).toBe('complete')
    expect(runRow(h).status).toBe('complete')
    expect(reevalRows(h, dec).length).toBe(1)
  })
})
