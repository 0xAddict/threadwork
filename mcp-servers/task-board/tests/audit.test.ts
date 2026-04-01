import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/audit-test.db'

describe('AuditLog', () => {
  let taskDb: TaskDB
  let audit: AuditLog

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    audit = new AuditLog(taskDb)
  })

  test('log creates an audit entry', () => {
    audit.log('boss', 'task_created', { to: 'steve', description: 'test' }, 1)
    const entries = audit.query({})
    expect(entries).toHaveLength(1)
    expect(entries[0].agent).toBe('boss')
    expect(entries[0].action).toBe('task_created')
    expect(JSON.parse(entries[0].detail!)).toEqual({ to: 'steve', description: 'test' })
    expect(entries[0].task_id).toBe(1)
  })

  test('query filters by agent', () => {
    audit.log('boss', 'task_created', {}, 1)
    audit.log('steve', 'task_claimed', {}, 1)
    const bossEntries = audit.query({ agent: 'boss' })
    expect(bossEntries).toHaveLength(1)
    expect(bossEntries[0].agent).toBe('boss')
  })

  test('query filters by action', () => {
    audit.log('boss', 'task_created', {}, 1)
    audit.log('boss', 'memory_saved', {}, undefined, 5)
    const memEntries = audit.query({ action: 'memory_saved' })
    expect(memEntries).toHaveLength(1)
    expect(memEntries[0].memory_id).toBe(5)
  })

  test('query filters by task_id', () => {
    audit.log('boss', 'task_created', {}, 1)
    audit.log('boss', 'task_created', {}, 2)
    const entries = audit.query({ taskId: 1 })
    expect(entries).toHaveLength(1)
  })

  test('query respects limit', () => {
    for (let i = 0; i < 20; i++) {
      audit.log('boss', 'task_created', {}, i)
    }
    const entries = audit.query({ limit: 5 })
    expect(entries).toHaveLength(5)
  })

  test('getAgentActivity returns recent entries', () => {
    audit.log('steve', 'task_claimed', {}, 1)
    audit.log('steve', 'note_added', {}, 1)
    const activity = audit.getAgentActivity('steve', 60)
    expect(activity).toHaveLength(2)
  })
})
