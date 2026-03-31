import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { buildNudgeCommand, resolveSession } from '../nudge'
import { formatTaskCreated, formatTaskCompleted } from '../notify'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-integration.db'

describe('integration: full task lifecycle', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('boss creates task → steve claims → steve completes', () => {
    // Boss creates
    const task = db.createTask({
      from: 'boss',
      to: 'steve',
      description: 'Pull Shopify sales report',
      priority: 'high',
    })
    expect(task.status).toBe('pending')

    // Verify nudge would target correct session
    const session = resolveSession('steve')
    expect(session).toBe('claude-steve')
    const cmd = buildNudgeCommand(session!, `New task #${task.id}`)
    expect(cmd[3]).toBe('claude-steve')

    // Verify notification format
    const createMsg = formatTaskCreated(task)
    expect(createMsg).toContain('boss')
    expect(createMsg).toContain('steve')

    // Steve claims
    const claimed = db.claimTask(task.id, 'steve')
    expect(claimed?.status).toBe('in_progress')

    // Sadie can't double-claim
    const doubleClaim = db.claimTask(task.id, 'sadie')
    expect(doubleClaim).toBeNull()

    // Steve adds a note
    db.addNote(task.id, 'steve', 'Working on it, pulling data now')
    const notes = db.getNotes(task.id)
    expect(notes).toHaveLength(1)

    // Steve completes
    const completed = db.completeTask(task.id, '5 orders, $289.80 revenue')
    expect(completed?.status).toBe('completed')
    expect(completed?.result).toBe('5 orders, $289.80 revenue')

    // Verify completion notification
    const completeMsg = formatTaskCompleted(completed!)
    expect(completeMsg).toContain('$289.80')

    // Verify listing
    const steveTasks = db.listTasks({ assignee: 'steve' })
    expect(steveTasks).toHaveLength(1)
    expect(steveTasks[0].status).toBe('completed')
  })

  test('concurrent tasks across multiple agents', () => {
    db.createTask({ from: 'boss', to: 'steve', description: 'Task A', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'sadie', description: 'Task B', priority: 'high' })
    db.createTask({ from: 'boss', to: 'kiera', description: 'Task C', priority: 'normal' })

    const all = db.listTasks({})
    expect(all).toHaveLength(3)

    const pending = db.listTasks({ status: 'pending' })
    expect(pending).toHaveLength(3)

    // Each agent claims their own
    db.claimTask(1, 'steve')
    db.claimTask(2, 'sadie')

    const inProgress = db.listTasks({ status: 'in_progress' })
    expect(inProgress).toHaveLength(2)

    const stillPending = db.listTasks({ status: 'pending' })
    expect(stillPending).toHaveLength(1)
    expect(stillPending[0].to_agent).toBe('kiera')
  })
})
