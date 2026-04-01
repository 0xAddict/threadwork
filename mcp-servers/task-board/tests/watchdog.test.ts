import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { findStaleTasks, findUnclaimedTasks, determineAction } from '../watchdog'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/watchdog-test.db'

describe('watchdog', () => {
  let taskDb: TaskDB
  let audit: AuditLog

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    audit = new AuditLog(taskDb)
  })

  test('findStaleTasks returns in-progress tasks older than threshold', () => {
    const task = taskDb.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    taskDb.claimTask(task.id, 'steve')
    const db = (taskDb as any).db
    db.prepare("UPDATE tasks SET claimed_at = datetime('now', '-15 minutes') WHERE id = ?").run(task.id)

    const stale = findStaleTasks(taskDb, 10)
    expect(stale).toHaveLength(1)
    expect(stale[0].id).toBe(task.id)
  })

  test('findStaleTasks excludes tasks with recent activity', () => {
    const task = taskDb.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    taskDb.claimTask(task.id, 'steve')
    const db = (taskDb as any).db
    db.prepare("UPDATE tasks SET claimed_at = datetime('now', '-15 minutes') WHERE id = ?").run(task.id)

    audit.log('steve', 'note_added', { message: 'working on it' }, task.id)

    const stale = findStaleTasks(taskDb, 10, audit)
    expect(stale).toHaveLength(0)
  })

  test('findUnclaimedTasks returns pending tasks older than threshold', () => {
    const task = taskDb.createTask({ from: 'boss', to: 'steve', description: 'old task', priority: 'normal' })
    const db = (taskDb as any).db
    db.prepare("UPDATE tasks SET created_at = datetime('now', '-20 minutes') WHERE id = ?").run(task.id)

    const unclaimed = findUnclaimedTasks(taskDb, 15)
    expect(unclaimed).toHaveLength(1)
  })

  test('determineAction returns first_nudge for nudge_count 0', () => {
    expect(determineAction(0)).toBe('first_nudge')
  })

  test('determineAction returns second_nudge for nudge_count 1', () => {
    expect(determineAction(1)).toBe('second_nudge')
  })

  test('determineAction returns escalate for nudge_count >= 2', () => {
    expect(determineAction(2)).toBe('escalate')
    expect(determineAction(5)).toBe('escalate')
  })
})
