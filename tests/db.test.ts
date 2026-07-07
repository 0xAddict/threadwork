import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-test.db'

// P5 (ATM-025): both new write-ordering / directed-messaging flags default OFF.
describe('P5 write-ordering / directed-messaging feature flags (ATM-025)', () => {
  let flagsDbPath: string

  beforeEach(() => {
    flagsDbPath = `/tmp/p5-flags-${crypto.randomUUID()}.db`
  })

  test('a fresh TaskDB seeds memory_write_ordering_enabled and directed_messaging_enabled both false', () => {
    const db = new TaskDB(flagsDbPath)
    try {
      expect(db.isFeatureEnabled('memory_write_ordering_enabled')).toBe(false)
      expect(db.isFeatureEnabled('directed_messaging_enabled')).toBe(false)
    } finally {
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(flagsDbPath + suffix) } catch {}
      }
    }
  })
})

describe('TaskDB', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('createTask returns a task with id and pending status', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'Update landing page', priority: 'normal' })
    expect(task.id).toBeGreaterThan(0)
    expect(task.status).toBe('pending')
    expect(task.from_agent).toBe('boss')
    expect(task.to_agent).toBe('steve')
    expect(task.description).toBe('Update landing page')
  })

  test('claimTask sets status to in_progress', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    const claimed = db.claimTask(task.id, 'steve')
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.claimed_at).toBeTruthy()
  })

  test('claimTask fails on already claimed task', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')
    const second = db.claimTask(task.id, 'sadie')
    expect(second).toBeNull()
  })

  test('completeTask sets status to completed with result', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')
    const completed = db.completeTask(task.id, 'Done — updated hero text', 'steve')
    expect(completed?.status).toBe('completed')
    expect(completed?.result).toBe('Done — updated hero text')
    expect(completed?.completed_at).toBeTruthy()
  })

  test('listTasks filters by assignee', () => {
    db.createTask({ from: 'boss', to: 'steve', description: 'task 1', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'sadie', description: 'task 2', priority: 'normal' })
    const steveTasks = db.listTasks({ assignee: 'steve' })
    expect(steveTasks).toHaveLength(1)
    expect(steveTasks[0].to_agent).toBe('steve')
  })

  test('listTasks filters by status', () => {
    const t = db.createTask({ from: 'boss', to: 'steve', description: 'task 1', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'steve', description: 'task 2', priority: 'normal' })
    db.claimTask(t.id, 'steve')
    const pending = db.listTasks({ status: 'pending' })
    expect(pending).toHaveLength(1)
  })

  test('addNote appends a note to a task', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.addNote(task.id, 'boss', 'Make sure to update the CTA too')
    const notes = db.getNotes(task.id)
    expect(notes).toHaveLength(1)
    expect(notes[0].from_agent).toBe('boss')
    expect(notes[0].message).toBe('Make sure to update the CTA too')
  })
})

describe('fault_count decay on successful heartbeat', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('successful heartbeat decrements fault_count by 1', () => {
    // Register agent with fault_count=3
    db.upsertAgentSession('steve', 'sess-1', 'active')
    db.run(d => {
      d.prepare('UPDATE agent_sessions SET fault_count = 3 WHERE agent = ?').run('steve')
    })

    // Create and claim a task for steve
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')

    // First successful (non-blocked) heartbeat -> fault_count should go from 3 to 2
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    let state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(2)

    // Second successful heartbeat -> 2 to 1
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(1)

    // Third -> 1 to 0
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(0)

    // Fourth -> bounded at 0, should NOT go negative
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(0)
  })

  test('blocked heartbeat does NOT decay fault_count', () => {
    db.upsertAgentSession('steve', 'sess-1', 'active')
    db.run(d => {
      d.prepare('UPDATE agent_sessions SET fault_count = 3 WHERE agent = ?').run('steve')
    })

    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')

    // Blocked heartbeat should NOT decay
    db.updateHeartbeat({ taskId: task.id, agent: 'steve', isBlocked: true, blockedReason: 'waiting on API' })
    const state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(3)
  })
})
