// tests/t3-epic06-activation.test.ts — T3 EPIC-06 (P8-KO-6 pass-through
// verification). Covers ATM-019 (REQ-022: end-to-end activation smoke — a forced
// cross-family 'block' critique drives the UNMODIFIED P8 chain to reward=-1) and
// ATM-020 (REQ-023: the before/after reward=0 distribution script mechanism).
//
// EPIC-06 is verification-only: NO new production code. ATM-019 proves the
// existing P8 aggregateCrossFamilyVerdict -> assignTernaryReward ->
// persistTernaryReward chain now yields a DECISIVE reward once attribution is
// active and a genuinely cross-family critique is recorded; ATM-020 exercises
// the read-only distribution comparison script (scripts/t3-attribution-distribution.ts).
//
// ATM-019 harness: same real-subprocess + MCP-client approach as the EPIC-02/03
// suites (server.ts's decision handlers live behind an unconditional
// mcp.connect(StdioServerTransport)). The critic/finalizer session is 'boss'
// because finalize_decision is boss-only.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB } from '../decision'
import {
  computeRewardZeroDistribution,
  analyzeDistribution,
} from '../scripts/t3-attribution-distribution'
import type { PersistedTernaryReward } from '../verification/ternary-reward'

const WORKTREE_DIR = join(import.meta.dir, '..')
const SERVER_TS_PATH = join(WORKTREE_DIR, 'server.ts')

const tmpDirs: string[] = []
const clients: Client[] = []

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 't3-epic06-'))
  tmpDirs.push(d)
  return d
}

function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try { await c.close() } catch { /* already closed */ }
  }
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* already gone */ }
  }
})

// ---------------------------------------------------------------------------
// ATM-019 / REQ-022 [P2] — end-to-end activation smoke (forced 'block' -> -1)
// ---------------------------------------------------------------------------
function seedSmokeFixture(tmpHome: string): { dbPath: string; decisionId: number } {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })

  const taskDb = new TaskDB(dbPath)
  // Activation = all three governing flags ON + registry populated (committed).
  taskDb.setFeatureFlag('cross_family_critique_enabled', true)
  taskDb.setFeatureFlag('cross_family_attribution_enabled', true)
  taskDb.setFeatureFlag('ternary_reward_enabled', true)
  // A real task with NO failure classifications -> CLEAN P6 signal
  // (failure_signal_available=true, failure_severity=null), so the P8 decision
  // table cannot fall through to neutral 0 via a failure row — the -1 must come
  // from the cross-family 'block' verdict (decision-table row 1).
  const task = taskDb.createTask({ from: 'steve', to: 'steve', description: 'T3 EPIC-06 smoke task', priority: 'P2' })
  const mem = new MemoryDB(taskDb)
  const dec = new DecisionDB(taskDb, mem)
  const decision = dec.openDecision('T3 EPIC-06 activation smoke', null, 'steve', { taskId: task.id })
  taskDb.run(db => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
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
    const client = new Client({ name: 't3-epic06-test-client', version: '0.0.1' })
    try {
      await client.connect(transport)
      await client.listTools()
      clients.push(client)
      return client
    } catch (err) {
      lastErr = err
      try { await client.close() } catch { /* already dead */ }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 100 + attempt * 50))
        continue
      }
    }
  }
  throw lastErr
}

describe('ATM-019: activation smoke — cross-family block -> reward=-1 via unmodified P8 chain (REQ-022)', () => {
  test(
    'explicit cross-family producer/critic model ids + blocker severity, then finalize -> ternary_rewards row reward=-1',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedSmokeFixture(tmpHome)
      const client = await connectServer(tmpHome, 'boss')

      // Forced cross-family: producer gpt-5.5 (openai) vs critic claude-opus-4-6
      // (anthropic), severity blocker -> evaluateCrossFamily -> verdict 'block'.
      const critiqueResult: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'activation smoke: forced cross-family block',
          severity: 'blocker',
          producer_model_id: 'gpt-5.5',
          critic_model_id: 'claude-opus-4-6',
        },
      })
      expect(critiqueResult.isError).toBeFalsy()

      const finalizeResult: any = await client.callTool({
        name: 'finalize_decision',
        arguments: {
          decision_id: decisionId,
          outcome: 'blocked',
          rationale: 'cross-family blocker recorded',
        },
      })
      expect(finalizeResult.isError).toBeFalsy()

      const checkDb = new TaskDB(dbPath)
      try {
        // The cross_family_critiques row is a genuine cross-family block.
        const cf = checkDb.run(db =>
          db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(cf.length).toBe(1)
        expect(cf[0].producer_family).toBe('openai')
        expect(cf[0].critic_family).toBe('anthropic')
        expect(cf[0].is_cross_family).toBe(1)
        expect(cf[0].verdict).toBe('block')

        // The DECISIVE assertion: the unmodified P8 chain persisted reward=-1.
        const rewards = checkDb.run(db =>
          db.prepare("SELECT * FROM ternary_rewards WHERE decision_id = ? AND subject_kind='decision'").all(decisionId),
        ) as any[]
        expect(rewards.length).toBe(1)
        expect(rewards[0].reward).toBe(-1)
        expect(rewards[0].cross_family_verdict).toBe('block')
        // Clean P6 -> null severity, signal available.
        expect(rewards[0].failure_severity).toBeNull()
        expect(rewards[0].failure_signal_available).toBe(1)
      } finally {
        checkDb.close()
      }
    },
  )
})

// ---------------------------------------------------------------------------
// ATM-020 / REQ-023 [P3] — before/after reward=0 distribution script mechanism
// ---------------------------------------------------------------------------
const TERNARY_INSERT = `
  INSERT INTO ternary_rewards
    (policy_version, decision_id, task_id, subject_kind, cross_family_verdict,
     failure_severity, failure_signal_available, reward, created_at)
  VALUES (1, ?, NULL, 'decision', ?, NULL, 1, ?, ?)
`

function seedDistributionFixture(tmpHome: string): string {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })
  const taskDb = new TaskDB(dbPath)
  taskDb.run(db => {
    const stmt = db.prepare(TERNARY_INSERT)
    // BEFORE activation (2026-07-08 12:00:00): all neutral-0 (empty registry era).
    stmt.run(101, 'unknown', 0, '2026-07-08 10:00:00')
    stmt.run(102, 'unknown', 0, '2026-07-08 11:00:00')
    stmt.run(103, 'unknown', 0, '2026-07-08 11:30:00')
    // AFTER activation: ≥1 genuine cross-family decisive reward -> proportion drops.
    stmt.run(201, 'block', -1, '2026-07-09 09:00:00')
    stmt.run(202, 'concur', 1, '2026-07-09 09:30:00')
    stmt.run(203, 'unknown', 0, '2026-07-09 10:00:00')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  })
  taskDb.close()
  return dbPath
}

describe('ATM-020: reward=0 before/after distribution script (REQ-023)', () => {
  const ACTIVATION = '2026-07-08 23:42:00'

  test('pure core: post-activation reward=0 proportion is strictly lower, boundary is floor-inclusive on AFTER', () => {
    const rows: PersistedTernaryReward[] = [
      // before: 2 rows, both neutral -> 100%
      mkRow(1, 0, '2026-07-08 10:00:00'),
      mkRow(2, 0, '2026-07-08 20:00:00'),
      // after: created_at == activation goes to AFTER (>= is after); one -1, one 0 -> 50%
      mkRow(3, -1, ACTIVATION),
      mkRow(4, 0, '2026-07-09 01:00:00'),
    ]
    const rep = computeRewardZeroDistribution(rows, ACTIVATION)
    expect(rep.before.total).toBe(2)
    expect(rep.before.proportionZero).toBe(1)
    expect(rep.after.total).toBe(2) // boundary row counted on the AFTER side
    expect(rep.after.proportionZero).toBe(0.5)
    expect(rep.postProportionStrictlyLower).toBe(true)
  })

  test('pure core: empty buckets do not divide by zero and do not falsely claim a drop', () => {
    const rep = computeRewardZeroDistribution([], ACTIVATION)
    expect(rep.before.proportionZero).toBe(0)
    expect(rep.after.proportionZero).toBe(0)
    expect(rep.postProportionStrictlyLower).toBe(false)
  })

  test('DB path (read-only): analyzeDistribution over a seeded fixture shows the post-activation drop', () => {
    const tmpHome = mkTmpHome()
    const dbPath = seedDistributionFixture(tmpHome)
    const rep = analyzeDistribution(dbPath, ACTIVATION)
    // before = 3 neutral-0 (100%); after = {-1, +1, 0} -> 1/3 neutral (~33%).
    expect(rep.before.total).toBe(3)
    expect(rep.before.proportionZero).toBe(1)
    expect(rep.after.total).toBe(3)
    expect(rep.after.rewardZero).toBe(1)
    expect(rep.postProportionStrictlyLower).toBe(true)
  })
})

function mkRow(id: number, reward: -1 | 0 | 1, created_at: string): PersistedTernaryReward {
  return {
    id,
    policy_version: 1,
    decision_id: id,
    task_id: null,
    subject_kind: 'decision',
    cross_family_verdict: reward === -1 ? 'block' : reward === 1 ? 'concur' : 'unknown',
    failure_severity: null,
    failure_signal_available: true,
    reward,
    created_at,
  }
}
