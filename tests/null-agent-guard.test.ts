// Regression tests for #832: `TypeError: null is not an object
// (evaluating 'agent.toLowerCase')` in resolveSession on null-agent
// unclaimed tasks.
//
// Two unguarded sites:
//   1. nudge.ts resolveSession(agent) — calls agent.toLowerCase() with no
//      null guard. This is the crash site.
//   2. watchdog.ts handleUnclaimed() — calls dispatchAgentNudge(task.to_agent)
//      with no null check. task.to_agent is nullable (migration 0007:
//      kanban backlog rows have to_agent = NULL).

import { describe, test, expect } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler } from '../watchdog'
import { resolveSession } from '../nudge'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/null-agent-guard-test.db'

function freshDb(): { taskDb: TaskDB; audit: AuditLog; reconciler: TaskReconciler } {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix) } catch {}
  }
  const taskDb = new TaskDB(TEST_DB)
  const audit = new AuditLog(taskDb)
  const reconciler = new TaskReconciler(taskDb, audit)
  return { taskDb, audit, reconciler }
}

function rawDb(taskDb: TaskDB): any {
  return (taskDb as any).db
}

describe('#832 — resolveSession null-agent guard', () => {
  test('resolveSession(null) returns null and does NOT throw', () => {
    expect(() => resolveSession(null as any)).not.toThrow()
    expect(resolveSession(null as any)).toBeNull()
  })

  test('resolveSession(undefined) returns null and does NOT throw', () => {
    expect(() => resolveSession(undefined as any)).not.toThrow()
    expect(resolveSession(undefined as any)).toBeNull()
  })

  test('resolveSession still maps real agent labels', () => {
    expect(resolveSession('steve')).toBe('claude-steve')
    expect(resolveSession('unknown-agent')).toBeNull()
  })
})

// A pending unclaimed task whose to_agent is NULL. Migration 0007 makes
// to_agent nullable for kanban backlog rows, but a freshly-created in-memory
// TaskDB still carries the original `to_agent TEXT NOT NULL` schema, so we
// insert a valid row and then override to_agent to null on the JS Task object
// handed to handleUnclaimed. handleUnclaimed reads task.to_agent / task.id /
// task.description off this object — this faithfully exercises the exact code
// path the production bug (#832) hits when a backlog row reaches the watchdog.
function nullAgentPendingTask(taskDb: TaskDB): { id: number; task: any } {
  const insert = rawDb(taskDb).prepare(`
    INSERT INTO tasks (from_agent, to_agent, description, priority, status)
    VALUES ('web-user', 'web-user', 'orphan backlog task', 'normal', 'pending')
  `).run()
  const id = Number(insert.lastInsertRowid)
  const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  task.to_agent = null
  return { id, task }
}

describe('#832 — watchdog handleUnclaimed null to_agent', () => {
  test('handleUnclaimed on a task with NULL to_agent does NOT throw', async () => {
    const { taskDb, reconciler } = freshDb()

    const { task } = nullAgentPendingTask(taskDb)
    expect(task.to_agent).toBeNull()

    const result = {
      checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
      dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
      decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0,
    }

    // Pre-fix: dispatchAgentNudge(null) -> resolveSession(null) ->
    //   null.toLowerCase() -> TypeError.
    await expect(
      (reconciler as any).handleUnclaimed(task, result),
    ).resolves.toBeUndefined()
  })

  test('handleUnclaimed with NULL to_agent does NOT escalate or count a nudge', async () => {
    const { taskDb, audit, reconciler } = freshDb()

    const { id: taskId, task } = nullAgentPendingTask(taskDb)

    const result = {
      checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
      dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
      decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0,
    }

    await (reconciler as any).handleUnclaimed(task, result)

    // A null-agent task has nobody to nudge — handleUnclaimed must skip
    // cleanly without firing a nudge or escalating.
    expect(result.nudged).toBe(0)
    expect(result.escalated).toBe(0)

    const unclaimedNudges = audit.query({ taskId, action: 'unclaimed_nudge' })
    expect(unclaimedNudges.length).toBe(0)
  })

  test('handleUnclaimed still nudges a normal task with a real to_agent', async () => {
    const { taskDb, audit, reconciler } = freshDb()

    const insert = rawDb(taskDb).prepare(`
      INSERT INTO tasks (from_agent, to_agent, description, priority, status, supervisor_agent)
      VALUES ('boss', 'steve', 'real assigned task', 'normal', 'pending', 'boss')
    `).run()
    const taskId = Number(insert.lastInsertRowid)
    const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)

    const result = {
      checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
      dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
      decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0,
    }

    await (reconciler as any).handleUnclaimed(task, result)

    // Real to_agent → the unclaimed-nudge path still runs.
    expect(result.nudged).toBe(1)
    const unclaimedNudges = audit.query({ taskId, action: 'unclaimed_nudge' })
    expect(unclaimedNudges.length).toBe(1)
  })
})
