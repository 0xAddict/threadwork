// tests/t3-epic02-critique-position-attribution.test.ts — T3 EPIC-02
// (call-site registry injection at critique_position behind the new
// cross_family_attribution_enabled flag). Covers ATM-004 (REQ-005),
// ATM-005 (REQ-006, full flag-OFF parity + loader-never-invoked), and
// ATM-006 (REQ-007, explicit-model-id branch untouched).
//
// Harness: same real-subprocess + MCP-client approach as
// tests/cross-family-critique-critique-position-integration.test.ts — see that
// file's header for WHY a subprocess is required (server.ts's critique_position
// case lives inside an unexported handler behind an unconditional
// `await mcp.connect(new StdioServerTransport())`, so it cannot be reached via a
// plain in-process import without hijacking the test runner's own stdio).
// Duplicated locally (not imported) so this suite has no fixture coupling to the
// P7 file — the house convention already used by the other critique_position
// subprocess suites.
//
// REGISTRY NOTE: loadAgentFamilyRegistry() reads the operator-maintained
// config/agent-family-registry.json at a path derived from ITS OWN on-disk
// location (verification/agent-family-registry.ts:DEFAULT_CONFIG_PATH =
// import.meta.dir/../config/...), NOT from HOME or cwd. The server subprocess
// therefore always loads the REAL committed worktree registry, which maps the 5
// known agents (boss/steve/sadie/kiera/snoopy) to 'anthropic'. These tests use a
// decision opened_by 'steve' and critic SELF_LABEL 'boss' so the registry-driven
// resolution is the real committed 'anthropic' value — a genuine, non-'unknown'
// result that proves the injection fires, with zero mutation of the committed
// config file.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'fs'
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
  const d = mkdtempSync(join(tmpdir(), 't3-epic02-'))
  tmpDirs.push(d)
  return d
}

function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

/**
 * Seeds an isolated fixture db: migrate()'d schema (which also registers the
 * default-OFF cross_family_attribution_enabled flag from PK-A), both governing
 * flags set per opts, one open decision opened_by the given agent.
 */
function seedFixture(
  tmpHome: string,
  opts: { critiqueFlagOn: boolean; attributionFlagOn: boolean; openedBy?: string },
): { dbPath: string; decisionId: number } {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })

  const taskDb = new TaskDB(dbPath)
  taskDb.setFeatureFlag('cross_family_critique_enabled', opts.critiqueFlagOn)
  taskDb.setFeatureFlag('cross_family_attribution_enabled', opts.attributionFlagOn)
  const mem = new MemoryDB(taskDb)
  const dec = new DecisionDB(taskDb, mem)
  const decision = dec.openDecision('T3 EPIC-02 fixture decision', null, opts.openedBy ?? 'steve')
  // WAL checkpoint+truncate before closing so no lingering WAL widens the
  // subprocess-startup SQLITE_BUSY window (see the P7 harness header).
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
    const client = new Client({ name: 't3-epic02-test-client', version: '0.0.1' })
    try {
      await client.connect(transport)
      await client.listTools() // readiness probe past the SQLITE_BUSY constructor window
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
// ATM-004 / REQ-005 [P1] — registry injection on the agent-fallback path
// ---------------------------------------------------------------------------
describe('ATM-004: registry injection at critique_position (flag ON, REQ-005)', () => {
  test(
    'both flags ON, no explicit model ids -> agent-fallback resolves via the injected registry to a NON-unknown family (steve/boss -> anthropic)',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, {
        critiqueFlagOn: true,
        attributionFlagOn: true,
        openedBy: 'steve',
      })
      const client = await connectServer(tmpHome, 'boss')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'registry-injection critique',
          severity: 'blocker',
        },
      })

      expect(result.isError).toBeFalsy()

      const checkDb = openCheckDb(dbPath)
      try {
        const rows = checkDb.run(db =>
          db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(rows.length).toBe(1)
        // The decisive assertion: with the attribution flag ON, the two
        // agent-fallback resolveAgentDefaultFamily() calls now receive the
        // populated registry, so 'steve'/'boss' resolve to their real
        // committed 'anthropic' mapping instead of the pre-T3 'unknown'.
        expect(rows[0].producer_family).toBe('anthropic')
        expect(rows[0].critic_family).toBe('anthropic')
        expect(rows[0].producer_agent).toBe('steve')
        expect(rows[0].critic_agent).toBe('boss')
      } finally {
        checkDb.close()
      }
    },
  )
})

// ---------------------------------------------------------------------------
// ATM-005 / REQ-006 [P1] — full flag-OFF parity + loader-never-invoked
// ---------------------------------------------------------------------------
describe('ATM-005: flag-OFF full parity + loader-never-invoked (REQ-006)', () => {
  test(
    'attribution flag OFF (default) -> byte-identical pre-T3 output: response template, every cross_family_critiques column, and audit row all at their pre-attribution values (steve stays unknown despite being a registry key)',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, {
        critiqueFlagOn: true,
        attributionFlagOn: false, // default OFF
        openedBy: 'steve',
      })
      const client = await connectServer(tmpHome, 'boss')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'flag-off parity critique',
          severity: 'blocker',
        },
      })

      expect(result.isError).toBeFalsy()
      const text = String(result.content?.[0]?.text ?? '')

      const checkDb = openCheckDb(dbPath)
      try {
        // Anchor the byte-identical response template on the real critique id.
        const critiqueRow = checkDb.run(db =>
          db.prepare('SELECT id FROM decision_critiques WHERE decision_id = ?').get(decisionId),
        ) as { id: number } | null
        expect(critiqueRow).toBeTruthy()
        const critiqueId = critiqueRow!.id

        // (a) full response text byte-identical to the pre-T3 template.
        expect(text).toBe(`Critique #${critiqueId} submitted on decision #${decisionId} (severity: blocker).`)

        // (b) the persisted cross_family_critiques row is byte-equal to the
        // pre-T3 baseline ACROSS ALL COLUMNS. Crucially producer_family and
        // critic_family are 'unknown' even though BOTH 'steve' and 'boss' ARE
        // keys in the committed registry — proving the OFF path did NOT apply
        // (and, by the loader-guard static check below, never invoked) the
        // registry.
        const rows = checkDb.run(db =>
          db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(rows.length).toBe(1)
        const row = rows[0]
        expect(row.taxonomy_version).toBe(1)
        expect(row.decision_id).toBe(decisionId)
        expect(row.critique_id).toBe(critiqueId)
        expect(row.position_id).toBeNull()
        expect(row.producer_agent).toBe('steve')
        expect(row.producer_family).toBe('unknown')
        expect(row.critic_agent).toBe('boss')
        expect(row.critic_family).toBe('unknown')
        expect(row.is_cross_family).toBe(0)
        expect(row.verdict).toBe('unknown')
        expect(row.linked_failure_class).toBeNull()

        // (c) the audit_log 'decision_critique_submitted' row is present with
        // its pre-T3 detail shape and records NO model-id fields.
        const auditRows = checkDb.run(db =>
          db
            .prepare(
              "SELECT agent, action, detail FROM audit_log WHERE task_id IS NULL AND action = 'decision_critique_submitted' ORDER BY id",
            )
            .all(),
        ) as { agent: string; action: string; detail: string }[]
        expect(auditRows.length).toBe(1)
        expect(auditRows[0].agent).toBe('boss')
        const detail = JSON.parse(auditRows[0].detail)
        expect(detail.decision_id).toBe(decisionId)
        expect(detail.critique_id).toBe(critiqueId)
        expect(detail.severity).toBe('blocker')
        expect(detail.producer_model_id).toBeUndefined()
        expect(detail.critic_model_id).toBeUndefined()
      } finally {
        checkDb.close()
      }
    },
  )

  test(
    "(d) loader-never-invoked static guarantee: server.ts's SOLE loadAgentFamilyRegistry() call site is the consequent of the cross_family_attribution_enabled ternary, so JS short-circuit evaluation never invokes it on the OFF path",
    () => {
      const src = readFileSync(SERVER_TS_PATH, 'utf-8')
      // Exactly one *call* to the loader anywhere in server.ts.
      const callSites = src.match(/loadAgentFamilyRegistry\s*\(/g) ?? []
      expect(callSites.length).toBe(1)
      // That call is the consequent of the attribution-flag ternary — so it is
      // only evaluated when the flag is ON (REQ-006 OFF path never touches it).
      expect(src).toMatch(
        /isFeatureEnabled\(\s*['"]cross_family_attribution_enabled['"]\s*\)\s*\n?\s*\?\s*loadAgentFamilyRegistry\(\)/,
      )
    },
  )
})

// ---------------------------------------------------------------------------
// ATM-006 / REQ-007 [P2] — explicit-model-id branch untouched by EPIC-02
// ---------------------------------------------------------------------------
describe('ATM-006: explicit-model-id branch untouched (flag ON, REQ-007)', () => {
  test(
    'both flags ON + explicit producer_model_id=gpt-5.5 -> producer_family=openai via resolveModelFamily() (a value the registry can NEVER produce), critic falls to the registry-injected agent path -> anthropic',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, {
        critiqueFlagOn: true,
        attributionFlagOn: true,
        openedBy: 'steve',
      })
      const client = await connectServer(tmpHome, 'boss')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'explicit-producer-model-id critique',
          severity: 'blocker',
          producer_model_id: 'gpt-5.5',
        },
      })

      expect(result.isError).toBeFalsy()

      const checkDb = openCheckDb(dbPath)
      try {
        const rows = checkDb.run(db =>
          db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(rows.length).toBe(1)
        // 'openai' is unreachable through the registry (it maps agents only to
        // 'anthropic'); it can ONLY come from resolveModelFamily('gpt-5.5').
        // This proves EPIC-02 left the explicit-model-id branch untouched.
        expect(rows[0].producer_family).toBe('openai')
        // critic side has no explicit model id -> agent-fallback path, which
        // now IS registry-injected -> 'boss' -> 'anthropic'.
        expect(rows[0].critic_family).toBe('anthropic')
        expect(rows[0].is_cross_family).toBe(1)
        expect(rows[0].verdict).toBe('block')
      } finally {
        checkDb.close()
      }
    },
  )
})
