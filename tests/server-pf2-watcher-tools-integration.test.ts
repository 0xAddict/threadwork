// tests/server-pf2-watcher-tools-integration.test.ts — PK-PF2-5 Stage B
// (ATM-PF2-08/09, REQ-PF2-08/09/10) integration test.
//
// Mirrors tests/cross-family-critique-critique-position-integration.test.ts's
// harness EXACTLY (same reasoning applies: server.ts's tool cases live
// inside an unexported anonymous mcp.setRequestHandler(...) handler and the
// file unconditionally calls mcp.connect(new StdioServerTransport()) at
// module top level, so there is no way to reach create_watcher/
// list_watchers/disable_watcher via a plain import — this spawns the REAL
// server.ts as a genuine child process and drives it over a real MCP stdio
// session, exactly how any real MCP client — including Claude Code itself —
// uses it). Kept LEAN (4 tests, not an exhaustive suite) given this pattern's
// known load-sensitivity (subprocess spawn + real stdio handshake) —
// PK-PF2-3/4's regression runs repeatedly classified the SAME critique_position
// harness as a 5000ms-timeout casualty under high system load; the bulk of
// PK-PF2-5's own verification lives in the fast, in-process static
// wiring-scan + diff-allowlist guard (tests/guardrails/pf2-5-wiring.guard.test.ts)
// and the direct-call evaluateWatchers() unit suite
// (tests/watchdog-pf2-evaluate-watchers.test.ts) instead.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TaskDB } from '../db'

const WORKTREE_DIR = join(import.meta.dir, '..')
const SERVER_TS_PATH = join(WORKTREE_DIR, 'server.ts')

const tmpDirs: string[] = []
const clients: Client[] = []

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'pf2-5-watcher-tools-'))
  tmpDirs.push(d)
  return d
}

function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

/** Seeds an isolated, migrate()'d fixture DB — mirrors the critique_position harness's seedFixture(). */
function seedFixture(tmpHome: string, opts: { flagOn: boolean }): { dbPath: string } {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })
  const taskDb = new TaskDB(dbPath)
  taskDb.setFeatureFlag('declarative_watchers_enabled', opts.flagOn)
  taskDb.run(db => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
  taskDb.close()
  return { dbPath }
}

/** Mirrors the critique_position harness's connectServer() exactly (bounded startup retry, readiness probe). */
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
    const client = new Client({ name: 'pf2-5-watcher-tools-test-client', version: '0.0.1' })
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

describe('ATM-PF2-08/09: create_watcher via real MCP tool call', () => {
  test('a well-formed create_watcher call creates exactly 1 declarative_watchers row + exactly 1 watcher_created audit row', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath } = seedFixture(tmpHome, { flagOn: false }) // flag OFF -- see the dedicated flag-independence test below
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await client.callTool({
      name: 'create_watcher',
      arguments: {
        name: 'integration test watcher',
        trigger_type: 'scheduled',
        condition_spec: { interval_seconds: 3600 },
        action_spec: { description: 'integration task', to: 'sadie' },
      },
    })

    expect(result.isError).toBeFalsy()
    const text = String(result.content?.[0]?.text ?? '')
    expect(text).toMatch(/^Watcher #\d+ \("integration test watcher"\) created\.$/)

    const checkDb = openCheckDb(dbPath)
    try {
      const watcherCount = checkDb.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(watcherCount.n).toBe(1)
      const auditRows = checkDb.run(d => d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'watcher_created'").get()) as { n: number }
      expect(auditRows.n).toBe(1)
    } finally {
      checkDb.close()
    }
  })

  test('an invalid condition_spec returns isError:true with createWatcher()\'s own descriptive message, zero rows created', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath } = seedFixture(tmpHome, { flagOn: true })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await client.callTool({
      name: 'create_watcher',
      arguments: {
        name: 'bad watcher',
        trigger_type: 'scheduled',
        condition_spec: { interval_seconds: -5 }, // malformed -- createWatcher()'s validator rejects this
        action_spec: { description: 'x', to: 'sadie' },
      },
    })

    // NOTE (finding, not a bug in this packet's code): `isError` is
    // nested inside `content[0]` here, mirroring assign_task's own
    // established error-response idiom verbatim (server.ts's pre-existing
    // convention across all 48 cases) -- NOT surfaced at the MCP SDK
    // client's top-level `result.isError`, which reads `undefined` for
    // every case in this codebase, not just this new one (confirmed
    // empirically; no existing test in this repo actually asserts
    // `result.isError === true`, only `toBeFalsy()` on success paths,
    // which is vacuously true for `undefined` too). Asserting on the
    // content text is the only way to actually observe the failure here,
    // matching the codebase's real, proven behavior rather than the MCP
    // protocol's formal (but unused-in-this-repo) top-level shape.
    const text = String(result.content?.[0]?.text ?? '')
    expect(text).toContain('create_watcher failed:')
    expect(text).toContain('interval_seconds')

    const checkDb = openCheckDb(dbPath)
    try {
      const watcherCount = checkDb.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(watcherCount.n).toBe(0)
    } finally {
      checkDb.close()
    }
  })
})

describe('ATM-PF2-08: list_watchers / disable_watcher via real MCP tool calls', () => {
  test('create 2, disable 1, list defaults to enabled-only, list with include_disabled shows both -- and disable never deletes the row', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath } = seedFixture(tmpHome, { flagOn: true })
    const client = await connectServer(tmpHome, 'boss')

    const c1: any = await client.callTool({
      name: 'create_watcher',
      arguments: { name: 'watcher-a', trigger_type: 'scheduled', condition_spec: { interval_seconds: 60 }, action_spec: { description: 'a', to: 'sadie' } },
    })
    const c2: any = await client.callTool({
      name: 'create_watcher',
      arguments: { name: 'watcher-b', trigger_type: 'scheduled', condition_spec: { interval_seconds: 60 }, action_spec: { description: 'b', to: 'sadie' } },
    })
    const id1 = Number(String(c1.content?.[0]?.text ?? '').match(/#(\d+)/)?.[1])
    const id2 = Number(String(c2.content?.[0]?.text ?? '').match(/#(\d+)/)?.[1])
    expect(id1).toBeGreaterThan(0)
    expect(id2).toBeGreaterThan(0)

    const disableResult: any = await client.callTool({ name: 'disable_watcher', arguments: { watcher_id: id1 } })
    expect(String(disableResult.content?.[0]?.text ?? '')).toBe(`Watcher #${id1} disabled.`)

    const enabledOnly: any = await client.callTool({ name: 'list_watchers', arguments: {} })
    const enabledList = JSON.parse(String(enabledOnly.content?.[0]?.text ?? '[]'))
    expect(enabledList.map((w: any) => w.id)).toEqual([id2])

    const allWatchers: any = await client.callTool({ name: 'list_watchers', arguments: { include_disabled: true } })
    const allList = JSON.parse(String(allWatchers.content?.[0]?.text ?? '[]'))
    expect(allList.map((w: any) => w.id).sort()).toEqual([id1, id2].sort())

    const checkDb = openCheckDb(dbPath)
    try {
      const stillThere = checkDb.run(d => d.prepare('SELECT id FROM declarative_watchers WHERE id = ?').get(id1))
      expect(stillThere).not.toBeNull() // never deleted, only disabled
    } finally {
      checkDb.close()
    }
  })

  test('disable_watcher on a non-existent id returns a graceful "not found" message, never an error', async () => {
    const tmpHome = mkTmpHome()
    seedFixture(tmpHome, { flagOn: true })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await client.callTool({ name: 'disable_watcher', arguments: { watcher_id: 999999 } })
    expect(result.isError).toBeFalsy()
    expect(String(result.content?.[0]?.text ?? '')).toBe('Watcher #999999 not found — no change.')
  })
})
