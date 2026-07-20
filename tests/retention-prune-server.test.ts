// tests/retention-prune-server.test.ts — T1 KO-SWEEP (#10376215) server-surface
// coverage: ATM-013 (REQ-014 / M-011) run_hygiene rendered output, and ATM-016
// (REQ-017 / M-015) the retention_prune_run audit entry.
//
// server.ts's run_hygiene case lives inside the UNEXPORTED anonymous handler
// passed to mcp.setRequestHandler(CallToolRequestSchema, ...), and the module
// unconditionally connects a StdioServerTransport at import time — so the only
// faithful way to exercise the deployed code path is to spawn the REAL server.ts
// as a child process (`bun server.ts`) with HOME redirected to an isolated
// per-test fixture dir, and drive it over a real MCP stdio session. Pattern
// mirrors tests/ternary-reward-finalize-integration.test.ts.

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

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try { await c.close() } catch {}
  }
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 't1-prune-server-'))
  tmpDirs.push(d)
  return d
}
function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

function seedFC(db: TaskDB, ageDays: number): void {
  db.run(d => d.prepare(
    `INSERT INTO failure_classifications
       (taxonomy_version, failure_class, severity, transience, domain, signal_source, summary, created_at)
     VALUES (1, 'verification_failure', 'high', 'transient', 'agent', 'verify_check', 'fixture',
             datetime('now', '-' || ? || ' days'))`,
  ).run(ageDays))
}
function seedCFC(db: TaskDB, ageDays: number): void {
  db.run(d => d.prepare(
    `INSERT INTO cross_family_critiques
       (taxonomy_version, decision_id, producer_agent, producer_family, critic_agent, critic_family,
        is_cross_family, verdict, created_at)
     VALUES (1, 1, 'steve', 'openai', 'boss', 'anthropic', 1, 'block',
             datetime('now', '-' || ? || ' days'))`,
  ).run(ageDays))
}

// Seed an isolated fixture db: migrate()'d schema, the retention flag per opts,
// and optional eligible fc/cfc rows. WAL-checkpoints + closes before the server
// subprocess opens the db.
function seedFixture(tmpHome: string, opts: { pruneFlagOn: boolean; eligibleRows: boolean }): string {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new TaskDB(dbPath)
  db.setFeatureFlag('retention_prune_enabled', opts.pruneFlagOn)
  if (opts.eligibleRows) {
    seedFC(db, 100); seedFC(db, 100)
    seedCFC(db, 100)
  }
  db.run(d => d.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
  db.close()
  return dbPath
}

async function connectServer(tmpHome: string): Promise<Client> {
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
        AGENT_LABEL: 'boss',
        NODE_ENV: 'test',
        THREADWORK_NUDGE_DISABLE: '1',
      } as Record<string, string>,
    })
    const client = new Client({ name: 't1-prune-server-test-client', version: '0.0.1' })
    try {
      await client.connect(transport)
      await client.listTools()
      clients.push(client)
      return client
    } catch (err) {
      lastErr = err
      try { await client.close() } catch {}
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 100 + attempt * 50))
        continue
      }
    }
  }
  throw lastErr
}

async function runHygiene(client: Client, dryRun: boolean): Promise<string> {
  const res: any = await client.callTool({ name: 'run_hygiene', arguments: { dry_run: dryRun } })
  return (res.content ?? []).map((c: any) => c.text ?? '').join('\n')
}

function countRetentionAuditRows(dbPath: string): number {
  const db = new TaskDB(dbPath)
  try {
    return db.run(d =>
      (d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'retention_prune_run'`).get() as { n: number }).n,
    )
  } finally {
    db.close()
  }
}

const NEW_LINE_LABELS = [
  'Failure classifications to prune',
  'Cross-family critiques to prune',
  'Ternary rewards to archive',
]

describe('ATM-013: run_hygiene renders retention lines (both flag states)', () => {
  test('flag OFF — 3 new lines rendered with 0', async () => {
    const tmpHome = mkTmpHome()
    seedFixture(tmpHome, { pruneFlagOn: false, eligibleRows: true })
    const client = await connectServer(tmpHome)
    const text = await runHygiene(client, true)
    for (const label of NEW_LINE_LABELS) expect(text).toContain(label)
    // Existing 5 lines still present.
    expect(text).toContain('Tasks to archive (>14d):')
    expect(text).toContain('Vacuumed:')
    // Flag OFF ⇒ the 3 new counts render 0.
    expect(text).toContain('Failure classifications to prune (>90d): 0')
    expect(text).toContain('Cross-family critiques to prune (>90d): 0')
    expect(text).toContain('Ternary rewards to archive (>90d, consumed): 0')
  })

  test('flag ON — 3 new lines rendered with eligible counts', async () => {
    const tmpHome = mkTmpHome()
    seedFixture(tmpHome, { pruneFlagOn: true, eligibleRows: true })
    const client = await connectServer(tmpHome)
    const text = await runHygiene(client, true) // dryRun: counts only
    for (const label of NEW_LINE_LABELS) expect(text).toContain(label)
    expect(text).toContain('Failure classifications to prune (>90d): 2')
    expect(text).toContain('Cross-family critiques to prune (>90d): 1')
  })
})

describe('ATM-016: retention_prune_run audit entry on affected live runs only', () => {
  test('live run with ≥1 affected row → exactly one audit row', async () => {
    const tmpHome = mkTmpHome()
    const dbPath = seedFixture(tmpHome, { pruneFlagOn: true, eligibleRows: true })
    const client = await connectServer(tmpHome)
    await runHygiene(client, false) // LIVE, 3 rows affected
    await client.close()
    expect(countRetentionAuditRows(dbPath)).toBe(1)
  })

  test('dryRun run → zero audit rows', async () => {
    const tmpHome = mkTmpHome()
    const dbPath = seedFixture(tmpHome, { pruneFlagOn: true, eligibleRows: true })
    const client = await connectServer(tmpHome)
    await runHygiene(client, true) // dryRun
    await client.close()
    expect(countRetentionAuditRows(dbPath)).toBe(0)
  })

  test('live run with 0 affected rows → zero audit rows', async () => {
    const tmpHome = mkTmpHome()
    const dbPath = seedFixture(tmpHome, { pruneFlagOn: true, eligibleRows: false })
    const client = await connectServer(tmpHome)
    await runHygiene(client, false) // LIVE but nothing eligible
    await client.close()
    expect(countRetentionAuditRows(dbPath)).toBe(0)
  })
})
