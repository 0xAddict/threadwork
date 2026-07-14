// tests/t3-epic03-critique-attribution.test.ts — T3 EPIC-03 (critic-side
// model-id adoption wrapper). Covers ATM-008 (REQ-009: resolveCallerModelId
// unit contract) and ATM-009 (REQ-010/REQ-011: the 3-branch critic_model_id
// fallback chain at the critique_position call site).
//
// PRECEDENCE UNDER TEST (ATM-009): explicit critic_model_id arg (highest,
// unchanged) > resolveCallerModelId() reading AGENT_MODEL_ID (new) >
// agent-based resolveAgentDefaultFamily(SELF_LABEL, registry) (EPIC-02).
// Producer-side is out of scope, so producer resolution is unaffected here.
//
// Integration harness: same real-subprocess + MCP-client approach as
// tests/t3-epic02-critique-position-attribution.test.ts (see that file's header
// for WHY a subprocess is required). The ONE addition is a per-connection
// AGENT_MODEL_ID control: when a case wants it unset we DELETE it from the
// child env (never inherit the parent's), and when a case wants it set we assign
// the exact value — so the fallback branch under test is deterministic
// regardless of the ambient environment.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB } from '../decision'
import { resolveCallerModelId } from '../verification/critique-attribution'

// ---------------------------------------------------------------------------
// ATM-008 / REQ-009 [P1] — resolveCallerModelId() unit contract
// ---------------------------------------------------------------------------
describe('ATM-008: resolveCallerModelId() reads AGENT_MODEL_ID, pure/never-throws (REQ-009)', () => {
  const ORIGINAL = process.env.AGENT_MODEL_ID

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGENT_MODEL_ID
    else process.env.AGENT_MODEL_ID = ORIGINAL
  })

  test('unset -> undefined', () => {
    delete process.env.AGENT_MODEL_ID
    expect(resolveCallerModelId()).toBeUndefined()
  })

  test('empty string -> undefined', () => {
    process.env.AGENT_MODEL_ID = ''
    expect(resolveCallerModelId()).toBeUndefined()
  })

  test('whitespace-only -> undefined', () => {
    process.env.AGENT_MODEL_ID = '   \t  '
    expect(resolveCallerModelId()).toBeUndefined()
  })

  test('present -> the value', () => {
    process.env.AGENT_MODEL_ID = 'gpt-5.5'
    expect(resolveCallerModelId()).toBe('gpt-5.5')
  })

  test('present with surrounding whitespace -> trimmed value', () => {
    process.env.AGENT_MODEL_ID = '  claude-opus-4-6  '
    expect(resolveCallerModelId()).toBe('claude-opus-4-6')
  })

  test('never throws across the matrix', () => {
    for (const v of [undefined, '', '   ', 'gpt-5.5', '  x  ']) {
      if (v === undefined) delete process.env.AGENT_MODEL_ID
      else process.env.AGENT_MODEL_ID = v
      expect(() => resolveCallerModelId()).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-009 / REQ-010,REQ-011 [P1] — 3-branch fallback chain (integration)
// ---------------------------------------------------------------------------
const WORKTREE_DIR = join(import.meta.dir, '..')
const SERVER_TS_PATH = join(WORKTREE_DIR, 'server.ts')

const tmpDirs: string[] = []
const clients: Client[] = []

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 't3-epic03-'))
  tmpDirs.push(d)
  return d
}

function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

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
  const decision = dec.openDecision('T3 EPIC-03 fixture decision', null, opts.openedBy ?? 'steve')
  taskDb.run(db => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
  taskDb.close()

  return { dbPath, decisionId: decision.id }
}

/**
 * Connect a server subprocess. `agentModelId === undefined` DELETES AGENT_MODEL_ID
 * from the child env (guaranteeing the "unset" branch even if the parent has it
 * set); a string value assigns it verbatim.
 */
async function connectServer(
  tmpHome: string,
  agentLabel: string,
  agentModelId: string | undefined,
): Promise<Client> {
  const MAX_ATTEMPTS = 4
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      AGENT_LABEL: agentLabel,
      NODE_ENV: 'test',
      THREADWORK_NUDGE_DISABLE: '1',
    }
    if (agentModelId === undefined) delete env.AGENT_MODEL_ID
    else env.AGENT_MODEL_ID = agentModelId

    const transport = new StdioClientTransport({
      command: 'bun',
      args: [SERVER_TS_PATH],
      cwd: WORKTREE_DIR,
      env,
    })
    const client = new Client({ name: 't3-epic03-test-client', version: '0.0.1' })
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

function readCrossFamilyRow(dbPath: string, decisionId: number): any {
  const checkDb = new TaskDB(dbPath)
  try {
    const rows = checkDb.run(db =>
      db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
    ) as any[]
    return rows
  } finally {
    checkDb.close()
  }
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try { await c.close() } catch { /* already closed */ }
  }
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* already gone */ }
  }
})

describe('ATM-009: critic_model_id fallback chain at critique_position (REQ-010/011)', () => {
  test(
    '(a) explicit critic_model_id arg WINS even when AGENT_MODEL_ID is set to a different family',
    async () => {
      // Explicit critic_model_id=claude-opus-4-6 (->anthropic) vs AGENT_MODEL_ID=gpt-5.5
      // (->openai). If the explicit arg wins, critic_family MUST be 'anthropic'
      // (the AGENT_MODEL_ID path would instead yield 'openai').
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, {
        critiqueFlagOn: true,
        attributionFlagOn: true,
        openedBy: 'steve',
      })
      const client = await connectServer(tmpHome, 'boss', 'gpt-5.5')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'explicit-critic-model-id wins',
          severity: 'blocker',
          critic_model_id: 'claude-opus-4-6',
        },
      })
      expect(result.isError).toBeFalsy()

      const rows = readCrossFamilyRow(dbPath, decisionId)
      expect(rows.length).toBe(1)
      expect(rows[0].critic_family).toBe('anthropic') // from the explicit arg, not AGENT_MODEL_ID
      expect(rows[0].critic_agent).toBe('boss')
    },
  )

  test(
    "(b) no explicit critic_model_id + AGENT_MODEL_ID='gpt-5.5' -> critic_family='openai' via resolveCallerModelId()",
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, {
        critiqueFlagOn: true,
        attributionFlagOn: true,
        openedBy: 'steve',
      })
      const client = await connectServer(tmpHome, 'boss', 'gpt-5.5')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'agent-model-id fallback',
          severity: 'blocker',
        },
      })
      expect(result.isError).toBeFalsy()

      const rows = readCrossFamilyRow(dbPath, decisionId)
      expect(rows.length).toBe(1)
      // 'openai' is unreachable via the agent registry (agents map only to
      // 'anthropic') — it can ONLY come from resolveModelFamily('gpt-5.5'),
      // i.e. the resolveCallerModelId() branch fired.
      expect(rows[0].critic_family).toBe('openai')
      // producer stays on the registry-injected agent path -> anthropic.
      expect(rows[0].producer_family).toBe('anthropic')
      expect(rows[0].is_cross_family).toBe(1)
      expect(rows[0].verdict).toBe('block')
    },
  )

  test(
    '(REQ-006 parity) attribution flag OFF + AGENT_MODEL_ID set -> critic stays unknown (adoption is flag-gated, byte-identical to pre-T3)',
    async () => {
      // Regression for the codex iter2 finding: the AGENT_MODEL_ID adoption must
      // be gated on cross_family_attribution_enabled, so a set AGENT_MODEL_ID must
      // NOT shift attribution while the flag is OFF.
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, {
        critiqueFlagOn: true,
        attributionFlagOn: false, // OFF
        openedBy: 'steve',
      })
      const client = await connectServer(tmpHome, 'boss', 'gpt-5.5') // AGENT_MODEL_ID set

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'flag-off + AGENT_MODEL_ID must stay unknown',
          severity: 'blocker',
        },
      })
      expect(result.isError).toBeFalsy()

      const rows = readCrossFamilyRow(dbPath, decisionId)
      expect(rows.length).toBe(1)
      // Flag OFF -> resolveCallerModelId is NOT consulted -> agent path -> 'unknown'
      // (NOT 'openai'). Byte-identical to the pre-T3 baseline.
      expect(rows[0].critic_family).toBe('unknown')
      expect(rows[0].producer_family).toBe('unknown')
      expect(rows[0].is_cross_family).toBe(0)
    },
  )

  test(
    '(c) neither explicit arg nor AGENT_MODEL_ID -> falls through to the EPIC-02 registry/agent path unchanged',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, {
        critiqueFlagOn: true,
        attributionFlagOn: true,
        openedBy: 'steve',
      })
      const client = await connectServer(tmpHome, 'boss', undefined) // AGENT_MODEL_ID unset

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'agent-path fallthrough',
          severity: 'blocker',
        },
      })
      expect(result.isError).toBeFalsy()

      const rows = readCrossFamilyRow(dbPath, decisionId)
      expect(rows.length).toBe(1)
      // No model id anywhere -> resolveAgentDefaultFamily('boss', registry) ->
      // 'anthropic' (the EPIC-02 agent path, unchanged by EPIC-03).
      expect(rows[0].critic_family).toBe('anthropic')
      expect(rows[0].critic_agent).toBe('boss')
    },
  )
})
