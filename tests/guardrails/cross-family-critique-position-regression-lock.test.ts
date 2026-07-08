// tests/guardrails/cross-family-critique-position-regression-lock.test.ts —
// P7 Stage 6 (EPIC-04 wiring hook, REQ-013(a)(b)(c) / ATM-021) regression-lock
// + fault-injection guardrail.
//
// Reuses the same real-subprocess + MCP-client harness as
// tests/cross-family-critique-critique-position-integration.test.ts (ATM-020)
// — see that file's header for why a subprocess is required (server.ts's
// critique_position case is inside an unexported handler behind an
// unconditional `await mcp.connect(new StdioServerTransport())`). Duplicated
// locally (not imported from the ATM-020 file) so this guardrail has no
// test-time coupling to that file's fixtures — mirrors the house convention
// already used by tests/cross-family-critique-p6-integration.test.ts, which
// duplicates its own makeFailureClassification() rather than importing one.
//
// Covers:
//   (a) Regression-lock: decision_critiques' PRAGMA table_info is untouched
//       (byte-identical to its documented pre-P7 shape), and the
//       critique_position response text template is unchanged.
//   (b) Fault-injection: force persistCrossFamilyCritique()'s INSERT to throw
//       (flag ON) via a poisoned BEFORE INSERT trigger on cross_family_critiques
//       — a pure SQL fixture-level fault, no source-file mutation — and prove
//       the pre-existing response text, the decision_critiques row, and the
//       'decision_critique_submitted' audit_log row are completely
//       unaffected (REQ-013(a)), AND that no orphaned 'cross_family_critique_recorded'
//       audit row survives the rollback (REQ-019 atomicity corroboration).
//   (c) A call omitting producer_model_id/critic_model_id passes MCP
//       tools/list schema validation identically to before this change —
//       `required` is still exactly ['decision_id','critique'].

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TaskDB } from '../../db'
import { MemoryDB } from '../../memory'
import { DecisionDB } from '../../decision'

const WORKTREE_DIR = join(import.meta.dir, '..', '..')
const SERVER_TS_PATH = join(WORKTREE_DIR, 'server.ts')

const tmpDirs: string[] = []
const clients: Client[] = []

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'p7-cfc-regression-lock-'))
  tmpDirs.push(d)
  return d
}

function dbPathFor(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board', 'tasks.db')
}

function seedFixture(
  tmpHome: string,
  opts: { flagOn: boolean; poisonCrossFamilyInsert?: boolean },
): { dbPath: string; decisionId: number } {
  const dbPath = dbPathFor(tmpHome)
  mkdirSync(dirname(dbPath), { recursive: true })

  const taskDb = new TaskDB(dbPath)
  taskDb.setFeatureFlag('cross_family_critique_enabled', opts.flagOn)
  const mem = new MemoryDB(taskDb)
  const dec = new DecisionDB(taskDb, mem)
  const decision = dec.openDecision('P7 ATM-021 fixture decision', null, 'steve')

  if (opts.poisonCrossFamilyInsert) {
    // Fault injection (REQ-013(a)/ATM-021(b)): a BEFORE INSERT trigger that
    // unconditionally aborts. This persists in sqlite_master and survives
    // the server subprocess's own idempotent `CREATE TABLE IF NOT EXISTS
    // cross_family_critiques` (db.ts:1127) — it does NOT drop/recreate the
    // table, so the trigger is still armed when persistCrossFamilyCritique()
    // attempts its INSERT. This forces exactly that one write to throw,
    // without touching any source file.
    taskDb.run(db =>
      db.exec(`
        CREATE TRIGGER poison_cross_family_critiques
        BEFORE INSERT ON cross_family_critiques
        BEGIN
          SELECT RAISE(ABORT, 'ATM-021(b) fault-injection: poisoned insert');
        END;
      `),
    )
  }

  taskDb.close()
  return { dbPath, decisionId: decision.id }
}

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
  const client = new Client({ name: 'p7-atm021-test-client', version: '0.0.1' })
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
// ATM-021(a) — schema + response-format regression lock
// ---------------------------------------------------------------------------
describe('ATM-021(a): decision_critiques schema + response-text regression lock', () => {
  test('decision_critiques PRAGMA table_info is byte-identical to its documented pre-P7 shape', async () => {
    const tmpHome = mkTmpHome()
    const { dbPath } = seedFixture(tmpHome, { flagOn: true })
    const checkDb = openCheckDb(dbPath)
    try {
      const columns = checkDb.run(db => db.prepare("PRAGMA table_info('decision_critiques')").all()) as {
        name: string
      }[]
      expect(columns.map(c => c.name).sort()).toEqual(
        ['id', 'decision_id', 'position_id', 'agent', 'critique', 'severity', 'created_at'].sort(),
      )
    } finally {
      checkDb.close()
    }
  })

  test('critique_position response text template is unchanged for a flag-ON call with new fields supplied', async () => {
    const tmpHome = mkTmpHome()
    const { decisionId } = seedFixture(tmpHome, { flagOn: true })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await client.callTool({
      name: 'critique_position',
      arguments: {
        decision_id: decisionId,
        critique: 'regression-lock text-format critique',
        severity: 'concern',
        producer_model_id: 'gemini-2.5-pro',
        critic_model_id: 'grok-4',
      },
    })

    expect(result.isError).toBeFalsy()
    const text = String(result.content?.[0]?.text ?? '')
    expect(text).toMatch(/^Critique #\d+ submitted on decision #\d+ \(severity: concern\)\.$/)
  })
})

// ---------------------------------------------------------------------------
// ATM-021(b) — fault-injection: persistCrossFamilyCritique() throws
// ---------------------------------------------------------------------------
describe('ATM-021(b): fault-injection on the cross-family persist path (REQ-013(a))', () => {
  test(
    'poisoned cross_family_critiques INSERT (flag ON) does not alter the response, the decision_critiques row, or the decision_critique_submitted audit row — and leaves no orphaned cross_family_critique_recorded audit row',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, { flagOn: true, poisonCrossFamilyInsert: true })
      const client = await connectServer(tmpHome, 'boss')

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'fault-injection critique',
          severity: 'blocker',
          producer_model_id: 'gpt-5.5',
          critic_model_id: 'claude-opus-4-6',
        },
      })

      // The response is completely unaffected by the poisoned insert.
      expect(result.isError).toBeFalsy()
      const text = String(result.content?.[0]?.text ?? '')
      const m = text.match(/^Critique #(\d+) submitted on decision #(\d+) \(severity: blocker\)\.$/)
      expect(m).toBeTruthy()
      const critiqueId = Number(m![1])

      const checkDb = openCheckDb(dbPath)
      try {
        // decision_critiques: the base critique IS recorded, untouched.
        const critiqueRows = checkDb.run(db =>
          db.prepare('SELECT * FROM decision_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(critiqueRows.length).toBe(1)
        expect(critiqueRows[0].id).toBe(critiqueId)
        expect(critiqueRows[0].severity).toBe('blocker')
        expect(critiqueRows[0].agent).toBe('boss')

        // cross_family_critiques: the poisoned INSERT never landed (rolled back).
        const cfcRows = checkDb.run(db =>
          db.prepare('SELECT * FROM cross_family_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(cfcRows.length).toBe(0)

        // audit_log: the PRE-EXISTING 'decision_critique_submitted' row (written
        // by the handler's own audit.log() call, BEFORE the hook runs) is
        // present exactly once; the hook's OWN 'cross_family_critique_recorded'
        // row never landed either — same local transaction, same rollback
        // (REQ-019 atomicity: no orphan in either direction).
        const auditActions = (
          checkDb.run(db =>
            db
              .prepare(
                "SELECT action FROM audit_log WHERE task_id IS NULL AND action IN ('decision_critique_submitted','cross_family_critique_recorded') ORDER BY id",
              )
              .all(),
          ) as { action: string }[]
        ).map(r => r.action)
        expect(auditActions).toEqual(['decision_critique_submitted'])
      } finally {
        checkDb.close()
      }
    },
  )
})

// ---------------------------------------------------------------------------
// ATM-021(d) — fault-injection: the feature-gate READ ITSELF throws (Codex
// R1 HIGH / REQ-013(a)). db.isFeatureEnabled('cross_family_critique_enabled')
// must be swallowed by the SAME try/catch as the rest of the P7 hook body —
// not left exposed to the handler's OUTER catch (which would turn the
// response into "Critique failed: ..." and set isError, violating
// REQ-013(a)'s guarantee that the pre-existing critique_position
// response/behavior is COMPLETELY unaffected by anything in the P7 addition).
// ---------------------------------------------------------------------------
describe('ATM-021(d): fault-injection on the feature-gate read itself (Codex R1 HIGH / REQ-013(a))', () => {
  /**
   * Drops the feature_flags table via a FRESH, short-lived connection AFTER
   * the server subprocess has already booted (i.e. after its own TaskDB
   * constructor's migrate() — which itself reads feature_flags, for the 3
   * `requiredFlags` — has already run and already succeeded once). This is
   * deliberately sequenced post-boot: renaming/dropping the table BEFORE
   * spawning the server would make the SERVER'S OWN STARTUP migrate() throw
   * (crashing the whole subprocess), which would not isolate the fault to
   * just the P7 gate call.
   *
   * `db.isFeatureEnabled('cross_family_critique_enabled')` at server.ts:1672
   * is confirmed to be the SOLE isFeatureEnabled() call anywhere on the
   * critique_position code path — dec.addCritique() (decision.ts:111-141),
   * postToGroup()/postToGroupThreaded() (notify.ts), and audit.log()
   * (audit.ts) make no such call (grepped: zero hits). So poisoning
   * feature_flags after boot isolates the throw to exactly this one read.
   *
   * DROP (vs. renaming the `enabled` column) is deliberate: a rename would
   * ALSO break any LATER `new TaskDB(...)` this test opens for verification
   * — TaskDB's own migrate() unconditionally INSERTs against the `enabled`
   * column on every construction. A drop is harmless for those instead —
   * `CREATE TABLE IF NOT EXISTS` simply recreates the table fresh — while
   * still producing a clean, unrecoverable "no such table: feature_flags"
   * throw for the server subprocess's own ALREADY-OPEN connection the next
   * time it issues `SELECT enabled FROM feature_flags WHERE flag_name = ?`.
   * WAL mode + busy_timeout=5000 (set in TaskDB's constructor) make the
   * brief write lock this needs safe to take against a live, otherwise-idle
   * server (no setInterval/setTimeout/periodic job in server.ts touches the
   * db between requests, so there is no other writer to contend with).
   */
  function poisonFeatureFlagsAfterBoot(dbPath: string): void {
    const poisonDb = new TaskDB(dbPath)
    poisonDb.run(db => db.exec('DROP TABLE feature_flags'))
    poisonDb.close()
  }

  test(
    'poisoned feature_flags table (flag-gate read throws) leaves the response as the normal template — NOT "Critique failed: ..." — and the decision_critiques row is still written',
    async () => {
      const tmpHome = mkTmpHome()
      const { dbPath, decisionId } = seedFixture(tmpHome, { flagOn: true })
      const client = await connectServer(tmpHome, 'boss')

      // Poison AFTER the server has booted (its own migrate() already ran
      // clean against the intact table) and BEFORE invoking
      // critique_position, so only the live P7 gate read is affected.
      poisonFeatureFlagsAfterBoot(dbPath)

      const result: any = await client.callTool({
        name: 'critique_position',
        arguments: {
          decision_id: decisionId,
          critique: 'feature-gate-read fault-injection critique',
          severity: 'blocker',
        },
      })

      // The response must be the NORMAL success template — not routed to
      // the handler's outer catch (which would produce
      // "Critique failed: no such table: feature_flags" + isError: true).
      expect(result.isError).toBeFalsy()
      const text = String(result.content?.[0]?.text ?? '')
      const m = text.match(/^Critique #(\d+) submitted on decision #(\d+) \(severity: blocker\)\.$/)
      expect(m).toBeTruthy()
      const critiqueId = Number(m![1])
      expect(Number(m![2])).toBe(decisionId)

      // decision_critiques: the base critique IS recorded, untouched — the
      // pre-existing dec.addCritique()/postToGroup/audit.log calls already
      // ran and fully succeeded BEFORE the poisoned gate read was reached.
      const checkDb = new TaskDB(dbPath)
      try {
        const critiqueRows = checkDb.run(db =>
          db.prepare('SELECT * FROM decision_critiques WHERE decision_id = ?').all(decisionId),
        ) as any[]
        expect(critiqueRows.length).toBe(1)
        expect(critiqueRows[0].id).toBe(critiqueId)
        expect(critiqueRows[0].severity).toBe('blocker')
        expect(critiqueRows[0].agent).toBe('boss')
      } finally {
        checkDb.close()
      }
    },
  )
})

// ---------------------------------------------------------------------------
// ATM-021(c) — omitted optional fields pass MCP schema validation identically
// ---------------------------------------------------------------------------
describe('ATM-021(c): critique_position schema parity for omitted optional fields', () => {
  test('tools/list: critique_position.required is still exactly [decision_id, critique]; producer_model_id/critic_model_id are optional string properties', async () => {
    const tmpHome = mkTmpHome()
    seedFixture(tmpHome, { flagOn: true })
    const client = await connectServer(tmpHome, 'boss')

    const { tools } = await client.listTools()
    const critiquePositionTool = tools.find(t => t.name === 'critique_position')
    expect(critiquePositionTool).toBeTruthy()

    const schema = critiquePositionTool!.inputSchema as any
    expect(schema.required).toEqual(['decision_id', 'critique'])
    expect(schema.properties.producer_model_id).toBeTruthy()
    expect(schema.properties.producer_model_id.type).toBe('string')
    expect(schema.properties.critic_model_id).toBeTruthy()
    expect(schema.properties.critic_model_id.type).toBe('string')
    // The 4 pre-existing properties are still declared, unchanged in shape.
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['decision_id', 'critique', 'position_id', 'severity', 'producer_model_id', 'critic_model_id'].sort(),
    )
  })

  test('a call omitting both new fields succeeds identically to a pre-P7 call (no schema rejection, flag ON)', async () => {
    const tmpHome = mkTmpHome()
    const { decisionId } = seedFixture(tmpHome, { flagOn: true })
    const client = await connectServer(tmpHome, 'boss')

    const result: any = await client.callTool({
      name: 'critique_position',
      arguments: { decision_id: decisionId, critique: 'no new fields supplied' },
    })

    expect(result.isError).toBeFalsy()
    const text = String(result.content?.[0]?.text ?? '')
    expect(text).toMatch(/^Critique #\d+ submitted on decision #\d+ \(severity: observation\)\.$/)
  })
})
