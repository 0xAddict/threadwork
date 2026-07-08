// tests/ternary-reward-finalize-integration.test.ts — P8 Stage 6 (EPIC-04
// wiring hook, REQ-013 / ATM-020, ATM-021) integration + regression-lock test,
// and Stage 7 ATM-026 flag-OFF parity (same wired call site).
//
// server.ts's finalize_decision case lives inside an UNEXPORTED anonymous
// handler passed to mcp.setRequestHandler(CallToolRequestSchema, ...), and the
// file unconditionally runs `await mcp.connect(new StdioServerTransport())` at
// module top level, so there is no way to reach the handler via a plain import.
// This test therefore spawns the REAL server.ts as a genuine child process
// (`bun server.ts`) with HOME redirected to an isolated per-test fixture dir,
// and drives it over a real MCP stdio session — the most faithful way to prove
// the additive wiring hook actually fires on the deployed code path. Pattern
// mirrors tests/cross-family-critique-critique-position-integration.test.ts.
//
// finalize_decision is boss-only (server.ts guard), so every client connects
// with AGENT_LABEL='boss'.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB } from '../decision'
import { persistCrossFamilyCritique, type CrossFamilyCritiqueRecord } from '../verification/cross-family-critique'
import { persistFailureClassification, type FailureClassification } from '../verification/failure-classification'

const WORKTREE_DIR = join(import.meta.dir, '..')
const SERVER_TS_PATH = join(WORKTREE_DIR, 'server.ts')

const tmpDirs: string[] = []
const clients: Client[] = []

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'p8-finalize-'))
  tmpDirs.push(d)
  return d
}

function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

function makeCritiqueRecord(overrides: Partial<CrossFamilyCritiqueRecord> = {}): CrossFamilyCritiqueRecord {
  return {
    decision_id: 1,
    critique_id: null,
    position_id: null,
    producer_agent: 'steve',
    producer_family: 'openai',
    critic_agent: 'boss',
    critic_family: 'anthropic',
    is_cross_family: true,
    verdict: 'block',
    linked_failure_class: null,
    ...overrides,
  }
}

function makeFailureClassification(overrides: Partial<FailureClassification> = {}): FailureClassification {
  return {
    failure_class: 'verification_failure',
    severity: 'high',
    transience: 'transient',
    domain: 'agent',
    taxonomy_version: 1,
    signal_source: 'verify_check',
    source_ref: null,
    task_id: null,
    agent: 'boss',
    summary: 'fixture classification',
    raw_signal: null,
    ...overrides,
  }
}

/**
 * Seeds an isolated fixture db: migrate()'d schema, flags per opts, one OPEN
 * decision (finalizable), and optional P6/P7 rows keyed to it. Optionally arms
 * a BEFORE INSERT trigger on ternary_rewards to fault-inject the persist path
 * (ATM-021(b)) — the trigger survives the server subprocess's own idempotent
 * `CREATE TABLE IF NOT EXISTS ternary_rewards`. WAL-checkpoints + closes before
 * the server subprocess opens the db.
 */
function seedFixture(
  tmpHome: string,
  opts: {
    ternaryFlagOn: boolean
    taskId: number | null
    crossFamilyVerdict?: 'block' | 'concur' | 'dissent'
    failureSeverity?: 'low' | 'medium' | 'high' | 'critical'
    poisonTernaryInsert?: boolean
  },
): { dbPath: string; decisionId: number } {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })

  const taskDb = new TaskDB(dbPath)
  taskDb.setFeatureFlag('ternary_reward_enabled', opts.ternaryFlagOn)
  // Seeding P6/P7 rows requires THEIR flags on (their persist fns are gated).
  taskDb.setFeatureFlag('cross_family_critique_enabled', true)
  taskDb.setFeatureFlag('failure_classification_enabled', true)

  const mem = new MemoryDB(taskDb)
  const dec = new DecisionDB(taskDb, mem)
  const decision = dec.openDecision('P8 ATM-020/021 fixture decision', null, 'boss', {
    taskId: opts.taskId ?? undefined,
  })

  if (opts.crossFamilyVerdict) {
    taskDb.run((db) =>
      persistCrossFamilyCritique(
        db,
        makeCritiqueRecord({ decision_id: decision.id, is_cross_family: true, verdict: opts.crossFamilyVerdict }),
      ),
    )
  }
  if (opts.failureSeverity && opts.taskId !== null) {
    taskDb.run((db) =>
      persistFailureClassification(db, makeFailureClassification({ task_id: opts.taskId, severity: opts.failureSeverity })),
    )
  }

  if (opts.poisonTernaryInsert) {
    // Fault injection (REQ-013(a)/ATM-021(b)): a BEFORE INSERT trigger that
    // unconditionally aborts. Persists in sqlite_master and survives the
    // server subprocess's own idempotent CREATE TABLE IF NOT EXISTS
    // ternary_rewards (db.ts) — so the trigger is still armed when
    // persistTernaryReward() attempts its INSERT, forcing exactly that one
    // write to throw, without touching any source file.
    taskDb.run((db) =>
      db.exec(`
        CREATE TRIGGER poison_ternary_rewards
        BEFORE INSERT ON ternary_rewards
        BEGIN
          SELECT RAISE(ABORT, 'ATM-021(b) fault-injection: poisoned insert');
        END;
      `),
    )
  }

  taskDb.run((db) => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
  taskDb.close()
  return { dbPath, decisionId: decision.id }
}

async function connectServer(tmpHome: string, agentLabel: string): Promise<Client> {
  const MAX_ATTEMPTS = 4
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const transport = new StdioClientTransport({
      command: 'bun',
      args: [SERVER_TS_PATH],
      cwd: WORKTREE_DIR,
      env: {
        ...process.env,
        HOME: tmpHome,
        AGENT_LABEL: agentLabel,
        NODE_ENV: 'test',
        THREADWORK_NUDGE_DISABLE: '1',
      } as Record<string, string>,
    })
    const client = new Client({ name: 'p8-finalize-test-client', version: '0.0.1' })
    try {
      await client.connect(transport)
      await client.listTools() // readiness probe (past the SQLITE_BUSY-vulnerable constructor window)
      clients.push(client)
      return client
    } catch (err) {
      lastErr = err
      try {
        await client.close()
      } catch {
        /* already dead */
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50))
        continue
      }
    }
  }
  throw lastErr
}

function openCheckDb(dbPath: string): TaskDB {
  return new TaskDB(dbPath)
}

async function finalize(client: Client, decisionId: number): Promise<any> {
  return client.callTool({
    name: 'finalize_decision',
    arguments: { decision_id: decisionId, outcome: 'accepted', rationale: 'p8 fixture rationale' },
  })
}

const FINALIZE_RE = /^Decision #(\d+) finalized\. Outcome: accepted\. Memory #(\d+) created\.$/

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      await c.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* already gone */
    }
  }
})

// ---------------------------------------------------------------------------
// ATM-020 / REQ-013 [P1] — the additive, flag-gated finalize hook, flag ON
// ---------------------------------------------------------------------------
describe('ATM-020: finalize_decision ternary-reward hook — flag ON (REQ-013)', () => {
  test('(A) block P7 verdict + high P6 severity → exactly 1 ternary_rewards row reward=-1, policy_version=1, failure_signal_available=1', async () => {
    const tmpHome = mkTmpHome()
    const TASK_ID = 4242
    const { dbPath, decisionId } = seedFixture(tmpHome, {
      ternaryFlagOn: true,
      taskId: TASK_ID,
      crossFamilyVerdict: 'block',
      failureSeverity: 'high',
    })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await finalize(client, decisionId)
    expect(result.isError).toBeFalsy()
    expect(String(result.content?.[0]?.text ?? '')).toMatch(FINALIZE_RE)

    const checkDb = openCheckDb(dbPath)
    try {
      const rows = checkDb.run((db) =>
        db.prepare('SELECT * FROM ternary_rewards WHERE decision_id = ?').all(decisionId),
      ) as any[]
      expect(rows.length).toBe(1)
      expect(rows[0].reward).toBe(-1)
      expect(rows[0].policy_version).toBe(1)
      expect(rows[0].failure_signal_available).toBe(1)
      expect(rows[0].decision_id).toBe(decisionId)
      expect(rows[0].task_id).toBe(TASK_ID)
      expect(rows[0].subject_kind).toBe('decision')
    } finally {
      checkDb.close()
    }
  })

  test('(B) task_id=null + no critiques → reward=0, failure_signal_available=0, no throw', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath, decisionId } = seedFixture(tmpHome, { ternaryFlagOn: true, taskId: null })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await finalize(client, decisionId)
    expect(result.isError).toBeFalsy()
    expect(String(result.content?.[0]?.text ?? '')).toMatch(FINALIZE_RE)

    const checkDb = openCheckDb(dbPath)
    try {
      const rows = checkDb.run((db) =>
        db.prepare('SELECT * FROM ternary_rewards WHERE decision_id = ?').all(decisionId),
      ) as any[]
      expect(rows.length).toBe(1)
      expect(rows[0].reward).toBe(0)
      expect(rows[0].failure_signal_available).toBe(0)
      expect(rows[0].task_id).toBeNull()
    } finally {
      checkDb.close()
    }
  })

  test('(C) concur P7 verdict + low P6 severity (available) → reward=+1 (positive path fires end-to-end)', async () => {
    const tmpHome = mkTmpHome()
    const TASK_ID = 5555
    const { dbPath, decisionId } = seedFixture(tmpHome, {
      ternaryFlagOn: true,
      taskId: TASK_ID,
      crossFamilyVerdict: 'concur',
      failureSeverity: 'low',
    })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await finalize(client, decisionId)
    expect(result.isError).toBeFalsy()

    const checkDb = openCheckDb(dbPath)
    try {
      const rows = checkDb.run((db) =>
        db.prepare('SELECT * FROM ternary_rewards WHERE decision_id = ?').all(decisionId),
      ) as any[]
      expect(rows.length).toBe(1)
      expect(rows[0].reward).toBe(1)
      expect(rows[0].failure_signal_available).toBe(1)
    } finally {
      checkDb.close()
    }
  })

  test('(D) AVAILABILITY GUARD: concur P7 verdict but task_id=null (P6 signal unavailable) → reward=0, NEVER +1, failure_signal_available=0', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath, decisionId } = seedFixture(tmpHome, {
      ternaryFlagOn: true,
      taskId: null,
      crossFamilyVerdict: 'concur',
    })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await finalize(client, decisionId)
    expect(result.isError).toBeFalsy()

    const checkDb = openCheckDb(dbPath)
    try {
      const rows = checkDb.run((db) =>
        db.prepare('SELECT * FROM ternary_rewards WHERE decision_id = ?').all(decisionId),
      ) as any[]
      expect(rows.length).toBe(1)
      expect(rows[0].reward).toBe(0) // NEVER +1 — unavailable P6 signal is not clean
      expect(rows[0].failure_signal_available).toBe(0)
    } finally {
      checkDb.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-021 / REQ-013(a) [P1] — regression-lock + fault-injection
// ---------------------------------------------------------------------------
describe('ATM-021(a): finalize_decision response-text + decisions-schema regression lock', () => {
  test('flag-ON finalize returns the byte-parity success template, and the decisions PRAGMA is unchanged', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath, decisionId } = seedFixture(tmpHome, {
      ternaryFlagOn: true,
      taskId: 6001,
      crossFamilyVerdict: 'block',
      failureSeverity: 'critical',
    })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await finalize(client, decisionId)
    expect(result.isError).toBeFalsy()
    const m = String(result.content?.[0]?.text ?? '').match(FINALIZE_RE)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBe(decisionId)

    const checkDb = openCheckDb(dbPath)
    try {
      const cols = (
        checkDb.run((db) => db.prepare("PRAGMA table_info('decisions')").all()) as { name: string }[]
      ).map((c) => c.name)
      expect(cols).toEqual([
        'id',
        'title',
        'context',
        'opened_by',
        'status',
        'finalized_by',
        'outcome',
        'outcome_rationale',
        'expires_at',
        'memory_id',
        'task_id',
        'created_at',
        'updated_at',
        'finalized_at',
      ])
    } finally {
      checkDb.close()
    }
  })
})

describe('ATM-021(b): fault-injection on the ternary persist path (REQ-013(a))', () => {
  test('poisoned ternary_rewards INSERT (flag ON) leaves the finalize response, the decisions row, the created memory, and the decision_finalized audit row completely unaffected — and no ternary_rewards / ternary_reward_assigned rows survive', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath, decisionId } = seedFixture(tmpHome, {
      ternaryFlagOn: true,
      taskId: 7001,
      crossFamilyVerdict: 'block',
      failureSeverity: 'high',
      poisonTernaryInsert: true,
    })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await finalize(client, decisionId)

    // The finalize response is the NORMAL success template — the poisoned
    // insert threw INSIDE the hook's own inner try/catch and never reached the
    // handler's outer catch (which would have produced "Finalize failed: ...").
    expect(result.isError).toBeFalsy()
    const m = String(result.content?.[0]?.text ?? '').match(FINALIZE_RE)
    expect(m).toBeTruthy()
    const memoryId = Number(m![2])

    const checkDb = openCheckDb(dbPath)
    try {
      // The decision WAS finalized (status flipped, memory linked) — the
      // pre-existing dec.finalizeDecision() write already committed.
      const decRow = checkDb.run((db) =>
        db.prepare('SELECT status, memory_id FROM decisions WHERE id = ?').get(decisionId),
      ) as { status: string; memory_id: number | null } | null
      expect(decRow).toBeTruthy()
      expect(decRow!.status).toBe('finalized')
      expect(decRow!.memory_id).toBe(memoryId)

      // The created memory row exists.
      const memRow = checkDb.run((db) => db.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)) as
        | { id: number }
        | null
      expect(memRow).toBeTruthy()

      // No ternary_rewards row landed (the poisoned INSERT rolled back).
      const trRows = checkDb.run((db) =>
        db.prepare('SELECT * FROM ternary_rewards WHERE decision_id = ?').all(decisionId),
      ) as any[]
      expect(trRows.length).toBe(0)

      // The pre-existing 'decision_finalized' audit row is present exactly
      // once; the hook's OWN 'ternary_reward_assigned' row never landed either
      // (same local txn rollback — no orphan in either direction).
      const auditActions = (
        checkDb.run((db) =>
          db
            .prepare(
              "SELECT action FROM audit_log WHERE action IN ('decision_finalized','ternary_reward_assigned') ORDER BY id",
            )
            .all(),
        ) as { action: string }[]
      ).map((r) => r.action)
      expect(auditActions).toEqual(['decision_finalized'])
    } finally {
      checkDb.close()
    }
  })
})

// ===========================================================================
// STAGE 7 of build-p8/PLAN.md: EPIC-06 (Flag-OFF parity across the wired
// call site) — ATM-026 / REQ-017. Verified here since it exercises the
// identical finalize_decision handler path as ATM-020 above.
// ===========================================================================
describe('ATM-026: finalize_decision ternary-reward hook — flag OFF parity (REQ-017)', () => {
  test('flag OFF → 0 ternary_rewards rows written AND the finalize response text is byte-identical to the flag-ON success template', async () => {
    const tmpHome = mkTmpHome()
    // Same rich fixture as ATM-020(A) (block + high) EXCEPT the ternary flag is OFF.
    const { dbPath, decisionId } = seedFixture(tmpHome, {
      ternaryFlagOn: false,
      taskId: 8001,
      crossFamilyVerdict: 'block',
      failureSeverity: 'high',
    })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await finalize(client, decisionId)
    expect(result.isError).toBeFalsy()
    // Byte-identical success template — the flag-OFF path returns exactly the
    // pre-P8 response.
    expect(String(result.content?.[0]?.text ?? '')).toMatch(FINALIZE_RE)

    const checkDb = openCheckDb(dbPath)
    try {
      // Zero ternary_rewards rows — the hook's flag gate short-circuits.
      const trCount = checkDb.run(
        (db) => (db.prepare('SELECT count(*) AS n FROM ternary_rewards').get() as { n: number }).n,
      )
      expect(trCount).toBe(0)

      // The decision still finalized normally, and NO 'ternary_reward_assigned'
      // audit row was written (only the pre-existing 'decision_finalized').
      const decRow = checkDb.run((db) =>
        db.prepare('SELECT status FROM decisions WHERE id = ?').get(decisionId),
      ) as { status: string } | null
      expect(decRow!.status).toBe('finalized')

      const trAudit = checkDb.run(
        (db) =>
          (db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'ternary_reward_assigned'").get() as {
            n: number
          }).n,
      )
      expect(trAudit).toBe(0)
    } finally {
      checkDb.close()
    }
  })
})
