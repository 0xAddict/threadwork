import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/state-contracts-test.db'

// Priority map mirrors spec §3: mcp > hook > heartbeat > boot
const PRIORITY: Record<string, number> = { mcp: 3, hook: 2, heartbeat: 1, boot: 0 }

type AgentRow = {
  agent: string
  state: string
  state_source: string
  state_changed_at: string | null
  current_task_id: number | null
  current_tool: string | null
}

function getRow(db: TaskDB, agent: string): AgentRow | null {
  const raw = (db as any).db as Database
  return raw.query(
    'SELECT agent, state, state_source, state_changed_at, current_task_id, current_tool FROM agent_sessions WHERE agent = ?'
  ).get(agent) as AgentRow | null
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

describe('declareAgentState — core helper', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const s of ['', '-shm', '-wal']) { try { unlinkSync(TEST_DB + s) } catch {} }
    db = new TaskDB(TEST_DB)
  })

  afterEach(() => {
    ;(db as any).db?.close()
    for (const s of ['', '-shm', '-wal']) { try { unlinkSync(TEST_DB + s) } catch {} }
  })

  test('inserts a new row when agent does not exist', () => {
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'mcp', { taskId: 42 })
    const row = getRow(db, 'testbot')
    expect(row).not.toBeNull()
    expect(row!.state).toBe('ACTIVE_THINKING')
    expect(row!.state_source).toBe('mcp')
    expect(row!.current_task_id).toBe(42)
    expect(row!.state_changed_at).toBeTruthy()
  })

  test('updates existing row with new state', () => {
    db.declareAgentState('testbot', 'IDLE_BOOT', 'boot', {})
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'hook', {})
    const row = getRow(db, 'testbot')
    expect(row!.state).toBe('ACTIVE_THINKING')
    expect(row!.state_source).toBe('hook')
  })

  test('touch-only (state=undefined) refreshes state_changed_at without changing state', async () => {
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'hook', {})
    const before = getRow(db, 'testbot')!.state_changed_at
    await sleep(1100)  // ensure timestamp advances by >1s
    db.declareAgentState('testbot', undefined, 'mcp', {})
    const after = getRow(db, 'testbot')!
    expect(after.state).toBe('ACTIVE_THINKING')  // state unchanged
    expect(after.state_changed_at).not.toBe(before)  // timestamp updated
  })
})

describe('declareAgentState — conflict resolution (mcp > hook > heartbeat)', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const s of ['', '-shm', '-wal']) { try { unlinkSync(TEST_DB + s) } catch {} }
    db = new TaskDB(TEST_DB)
  })

  afterEach(() => {
    ;(db as any).db?.close()
    for (const s of ['', '-shm', '-wal']) { try { unlinkSync(TEST_DB + s) } catch {} }
  })

  test('mcp overwrites hook within same second', () => {
    db.declareAgentState('testbot', 'TOOL_IN_FLIGHT', 'hook', {})
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'mcp', { taskId: 1 })
    const row = getRow(db, 'testbot')!
    expect(row.state).toBe('ACTIVE_THINKING')
    expect(row.state_source).toBe('mcp')
  })

  test('hook does NOT overwrite mcp within same second', () => {
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'mcp', { taskId: 1 })
    db.declareAgentState('testbot', 'TOOL_IN_FLIGHT', 'hook', {})
    const row = getRow(db, 'testbot')!
    expect(row.state).toBe('ACTIVE_THINKING')  // mcp state preserved
    expect(row.state_source).toBe('mcp')
  })

  test('heartbeat does NOT overwrite hook within same second', () => {
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'hook', {})
    db.declareAgentState('testbot', 'IDLE_BOOT', 'heartbeat', {})
    const row = getRow(db, 'testbot')!
    expect(row.state).toBe('ACTIVE_THINKING')  // hook state preserved
    expect(row.state_source).toBe('hook')
  })

  test('lower-priority CAN overwrite stale higher-priority row (>1s old)', async () => {
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'mcp', {})
    await sleep(1100)  // let the row go stale
    db.declareAgentState('testbot', 'WAITING_HUMAN', 'hook', {})
    const row = getRow(db, 'testbot')!
    expect(row.state).toBe('WAITING_HUMAN')
    expect(row.state_source).toBe('hook')
  })

  test('equal-priority source always overwrites', () => {
    db.declareAgentState('testbot', 'ACTIVE_THINKING', 'hook', {})
    db.declareAgentState('testbot', 'TOOL_IN_FLIGHT', 'hook', { tool: 'Bash' })
    const row = getRow(db, 'testbot')!
    expect(row.state).toBe('TOOL_IN_FLIGHT')
    expect(row.current_tool).toBe('Bash')
  })
})

describe('declareAgentState — wire-up states (simulating tool handler calls)', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const s of ['', '-shm', '-wal']) { try { unlinkSync(TEST_DB + s) } catch {} }
    db = new TaskDB(TEST_DB)
  })

  afterEach(() => {
    ;(db as any).db?.close()
    for (const s of ['', '-shm', '-wal']) { try { unlinkSync(TEST_DB + s) } catch {} }
  })

  test('claim_task: ACTIVE_THINKING with current_task_id', () => {
    db.declareAgentState('steve', 'ACTIVE_THINKING', 'mcp', { taskId: 99 })
    const row = getRow(db, 'steve')!
    expect(row.state).toBe('ACTIVE_THINKING')
    expect(row.state_source).toBe('mcp')
    expect(row.current_task_id).toBe(99)
  })

  test('complete_task: COMPLETED with no task_id', () => {
    db.declareAgentState('steve', 'ACTIVE_THINKING', 'mcp', { taskId: 99 })
    db.declareAgentState('steve', 'COMPLETED', 'mcp', {})
    const row = getRow(db, 'steve')!
    expect(row.state).toBe('COMPLETED')
    expect(row.state_source).toBe('mcp')
  })

  test('spawn_subagent: SUBAGENT_RUNNING with child task_id', () => {
    db.declareAgentState('sadie', 'ACTIVE_THINKING', 'mcp', { taskId: 5 })
    db.declareAgentState('sadie', 'SUBAGENT_RUNNING', 'mcp', { taskId: 42 })
    const row = getRow(db, 'sadie')!
    expect(row.state).toBe('SUBAGENT_RUNNING')
    expect(row.current_task_id).toBe(42)
  })

  test('close_subagent: back to ACTIVE_THINKING', () => {
    db.declareAgentState('sadie', 'SUBAGENT_RUNNING', 'mcp', { taskId: 42 })
    db.declareAgentState('sadie', 'ACTIVE_THINKING', 'mcp', {})
    const row = getRow(db, 'sadie')!
    expect(row.state).toBe('ACTIVE_THINKING')
  })

  test('write_status touch: refreshes state_changed_at, preserves state', async () => {
    db.declareAgentState('kiera', 'TOOL_IN_FLIGHT', 'hook', { tool: 'Bash' })
    const before = getRow(db, 'kiera')!.state_changed_at
    await sleep(1100)
    db.declareAgentState('kiera', undefined, 'mcp', {})
    const row = getRow(db, 'kiera')!
    expect(row.state).toBe('TOOL_IN_FLIGHT')  // unchanged
    expect(row.state_changed_at).not.toBe(before)  // refreshed
    expect(row.current_tool).toBe('Bash')  // tool preserved
  })
})
