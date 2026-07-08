// tests/cross-family-critique-critique-position-integration.test.ts — P7
// Stage 6 (EPIC-04 wiring hook, REQ-013 / ATM-020) integration test.
//
// server.ts's critique_position case lives inside an UNEXPORTED anonymous
// handler passed to mcp.setRequestHandler(CallToolRequestSchema, ...), and
// the file unconditionally runs `await mcp.connect(new StdioServerTransport())`
// at module top level (server.ts's own end-of-file comment confirms: "Tests
// never run server.ts main" — config.ts:64). Importing server.ts in-process
// would hijack this test runner's own stdio, so there is no way to reach the
// handler via a plain import. Grepped tests/ for StdioClientTransport/Client/
// setRequestHandler — zero existing tests invoke the MCP handler this way
// (no test imports server.ts at all).
//
// This test therefore spawns the REAL server.ts as a genuine child process —
// exactly how every agent actually runs it (`bun server.ts`) — with HOME
// redirected to an isolated per-test fixture directory, and drives it over a
// real MCP stdio session using the SDK's own public Client + StdioClientTransport
// (the same API any real MCP client, e.g. Claude Code, uses). This is the
// most faithful way to prove the additive wiring hook actually fires on the
// deployed code path, not a re-implementation of it.
//
// Pattern mirrors tests/failure-classification-verify-integration.test.ts's
// HOME-redirected Bun.spawnSync approach for verify.ts, adapted to a live
// stdio session since (unlike verify.ts) server.ts is a long-running MCP
// server, not a one-shot script.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB } from '../decision'

const WORKTREE_DIR = join(import.meta.dir, '..')
const SERVER_TS_PATH = join(WORKTREE_DIR, 'server.ts')

const tmpDirs: string[] = []
const clients: Client[] = []

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'p7-critique-position-'))
  tmpDirs.push(d)
  return d
}

function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

/**
 * Seeds an isolated fixture db (migrate()'d schema via TaskDB's constructor,
 * cross_family_critique_enabled set per `opts.flagOn`, one open decision) and
 * closes the handle before the server subprocess opens its own connection.
 * bun:sqlite's `{create: true}` does NOT create missing parent directories,
 * so the `.claude/mcp-servers/task-board` dir is pre-created here.
 */
function seedFixture(tmpHome: string, opts: { flagOn: boolean }): { dbPath: string; decisionId: number } {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })

  const taskDb = new TaskDB(dbPath)
  taskDb.setFeatureFlag('cross_family_critique_enabled', opts.flagOn)
  const mem = new MemoryDB(taskDb)
  const dec = new DecisionDB(taskDb, mem)
  const decision = dec.openDecision('P7 ATM-020/021 fixture decision', null, 'steve')
  taskDb.close()

  return { dbPath, decisionId: decision.id }
}

/**
 * Spawns the REAL server.ts as a child process against the isolated fixture
 * HOME and connects an MCP client to it over real stdio. NODE_ENV=test (+
 * THREADWORK_NUDGE_DISABLE=1 belt-and-suspenders) trips notify.ts's own
 * POST_DISABLED test-mode guard so no real Telegram network call is ever
 * attempted. Registered in the module-level `clients` array so the shared
 * afterEach() below always closes it, even on assertion failure.
 */
async function connectServer(tmpHome: string, agentLabel: string): Promise<Client> {
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
  const client = new Client({ name: 'p7-critique-position-test-client', version: '0.0.1' })
  await client.connect(transport)
  clients.push(client)
  return client
}

function openCheckDb(dbPath: string): TaskDB {
  return new TaskDB(dbPath)
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
// ATM-020 / REQ-013 [P1] — the additive, flag-gated, try/catch-wrapped call
// site in critique_position's handler, plus the two OPTIONAL schema fields.
// ---------------------------------------------------------------------------
describe('ATM-020: critique_position wiring hook — flag ON (REQ-013)', () => {
  test(
    'explicit producer_model_id/critic_model_id -> exactly 1 cross_family_critiques row: producer_family=openai, critic_family=anthropic, is_cross_family=1, verdict=block, critique_id = the decision_critiques row addCritique() just inserted',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, { flagOn: true })
      const client = await connectServer(tmpHome, 'boss')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'cross-family blocker critique',
          severity: 'blocker',
          producer_model_id: 'gpt-5.5',
          critic_model_id: 'claude-opus-4-6',
        },
      })

      expect(result.isError).toBeFalsy()
      const text = String(result.content?.[0]?.text ?? '')
      const m = text.match(/^Critique #(\d+) submitted on decision #(\d+) \(severity: blocker\)\.$/)
      expect(m).toBeTruthy()
      const critiqueId = Number(m![1])
      expect(Number(m![2])).toBe(decisionId)

      const checkDb = openCheckDb(dbPath)
      try {
        const critiqueRow = checkDb.run(db =>
          db.prepare('SELECT id FROM decision_critiques WHERE id = ?').get(critiqueId),
        ) as { id: number } | null
        expect(critiqueRow).toBeTruthy()
        expect(critiqueRow!.id).toBe(critiqueId)

        const rows = checkDb.run(db =>
          db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(rows.length).toBe(1)
        expect(rows[0].producer_family).toBe('openai')
        expect(rows[0].critic_family).toBe('anthropic')
        expect(rows[0].is_cross_family).toBe(1)
        expect(rows[0].verdict).toBe('block')
        expect(rows[0].critique_id).not.toBeNull()
        expect(rows[0].critique_id).toBe(critiqueId)
        expect(rows[0].critic_agent).toBe('boss')
        expect(rows[0].producer_agent).toBe('steve') // decision.opened_by (no position_id supplied)
      } finally {
        checkDb.close()
      }
    },
  )

  test(
    'omitting BOTH producer_model_id/critic_model_id -> resolves via resolveAgentDefaultFamily() (empty registry) to producer_family=unknown/critic_family=unknown, is_cross_family=0, verdict=unknown',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, { flagOn: true })
      const client = await connectServer(tmpHome, 'boss')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'omitted-model-id critique',
        },
      })

      expect(result.isError).toBeFalsy()
      const text = String(result.content?.[0]?.text ?? '')
      expect(text).toMatch(/^Critique #\d+ submitted on decision #\d+ \(severity: observation\)\.$/)

      const checkDb = openCheckDb(dbPath)
      try {
        const rows = checkDb.run(db =>
          db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(rows.length).toBe(1)
        expect(rows[0].producer_family).toBe('unknown')
        expect(rows[0].critic_family).toBe('unknown')
        expect(rows[0].is_cross_family).toBe(0)
        expect(rows[0].verdict).toBe('unknown')
      } finally {
        checkDb.close()
      }
    },
  )
})

// ---------------------------------------------------------------------------
// ATM-026 / REQ-017 [P1] — flag-OFF parity run across this SAME wired call
// site (belongs to EPIC-06, verified here since it exercises the identical
// handler path as ATM-020 above).
// ---------------------------------------------------------------------------
describe('ATM-026: critique_position wiring hook — flag OFF (REQ-017)', () => {
  test('flag OFF -> 0 cross_family_critiques rows, response text/format unaffected', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath, decisionId } = seedFixture(tmpHome, { flagOn: false })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await client.callTool({
      name: 'critique_position',
      arguments: {
        decision_id: decisionId,
        critique: 'flag-off critique',
        severity: 'blocker',
        producer_model_id: 'gpt-5.5',
        critic_model_id: 'claude-opus-4-6',
      },
    })

    expect(result.isError).toBeFalsy()
    const text = String(result.content?.[0]?.text ?? '')
    expect(text).toMatch(/^Critique #\d+ submitted on decision #\d+ \(severity: blocker\)\.$/)

    const checkDb = openCheckDb(dbPath)
    try {
      const rows = checkDb.run(db =>
        db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
      ) as any[]
      expect(rows.length).toBe(0)
    } finally {
      checkDb.close()
    }
  })

  // -------------------------------------------------------------------------
  // STAGE 7 (P7 build): the same flag-OFF call site, but pinned to the EXACT
  // byte-identical response template (REQ-017) rather than a regex, PLUS an
  // explicit assertion that the base decision_critiques row is written
  // completely normally — i.e. flag-OFF is a true no-op on everything
  // EXCEPT the additive cross_family_critiques write, not merely "0 rows
  // happens to also hold". Even omits producer_model_id/critic_model_id
  // (the fully-default caller shape) to prove parity holds independent of
  // which optional args are supplied.
  // -------------------------------------------------------------------------
  test('ATM-026 (Stage 7): flag OFF -> response text byte-identical to the exact template, decision_critiques row written normally, 0 cross_family_critiques rows', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath, decisionId } = seedFixture(tmpHome, { flagOn: false })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await client.callTool({
      name: 'critique_position',
      arguments: {
        decision_id: decisionId,
        critique: 'stage-7 flag-off parity critique',
        severity: 'concern',
      },
    })

    expect(result.isError).toBeFalsy()
    const text = String(result.content?.[0]?.text ?? '')

    const checkDb = openCheckDb(dbPath)
    try {
      // (c) decision_critiques row still written normally (base critique
      // unaffected by the flag) — fetched FIRST so its real id anchors the
      // byte-identical template assertion below.
      const critiqueRow = checkDb.run(db =>
        db.prepare('SELECT id, decision_id, agent, critique, severity FROM decision_critiques WHERE decision_id = ?').get(decisionId),
      ) as { id: number; decision_id: number; agent: string; critique: string; severity: string } | null
      expect(critiqueRow).toBeTruthy()
      expect(critiqueRow!.decision_id).toBe(decisionId)
      expect(critiqueRow!.agent).toBe('boss')
      expect(critiqueRow!.critique).toBe('stage-7 flag-off parity critique')
      expect(critiqueRow!.severity).toBe('concern')

      // (b) response text byte-identical to the exact template
      // `Critique #<id> submitted on decision #<id> (severity: <sev>).`
      const expectedText = `Critique #${critiqueRow!.id} submitted on decision #${decisionId} (severity: concern).`
      expect(text).toBe(expectedText)

      // (a) ZERO cross_family_critiques rows written.
      const rows = checkDb.run(db =>
        db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
      ) as any[]
      expect(rows.length).toBe(0)
      const totalRows = checkDb.run(db => db.prepare('SELECT COUNT(*) as c FROM cross_family_critiques').get()) as { c: number }
      expect(totalRows.c).toBe(0)
    } finally {
      checkDb.close()
    }
  })
})
