import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler } from '../watchdog'
import { unlinkSync } from 'fs'

// nudgeAgent and postToGroup already no-op in test mode
// (NUDGE_DISABLED / POST_DISABLED guards in nudge.ts and notify.ts)

const TEST_DB = '/tmp/subagent-attribution-test.db'

describe('S2.1: subagent heartbeat overdue does not fault parent', () => {
  let taskDb: TaskDB
  let audit: AuditLog
  let reconciler: TaskReconciler

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    audit = new AuditLog(taskDb)
    reconciler = new TaskReconciler(taskDb, audit)
  })

  test('subagent child heartbeat overdue does NOT increment parent fault_count', async () => {
    // Create an agent session for the parent so isSessionDead returns false
    taskDb.upsertAgentSession('boss', 'session-boss', 'alive')

    // Create a normal parent task (in_progress)
    const parentTask = taskDb.createTask({
      from: 'boss',
      to: 'boss',
      description: 'Parent orchestration task',
      priority: 'normal',
    })
    taskDb.claimTask(parentTask.id, 'boss')

    // Create a subagent child task
    const childTask = taskDb.createSubagentTask({
      description: 'Subagent research task',
      parent_task_id: parentTask.id,
      supervisor_agent: 'boss',
      heartbeat_timeout_sec: 60,
    })

    // Verify it's a subagent task
    expect(childTask.kind).toBe('subagent')
    expect(childTask.to_agent).toBe('boss')

    // Set child task's heartbeat and next_check_at to be overdue
    taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          last_heartbeat_at = datetime('now', '-300 seconds'),
          next_check_at = datetime('now', '-1 seconds')
        WHERE id = ?
      `).run(childTask.id)
    })

    // Check boss fault_count before
    const beforeFault = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('boss') as any
    )
    expect(beforeFault.fault_count ?? 0).toBe(0)

    // Run the reconciler — this should trigger handleHeartbeatOverdue for the child
    await reconciler.reconcileDueTasks()

    // Check boss fault_count after — should still be 0 because child is subagent
    const afterFault = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('boss') as any
    )
    expect(afterFault.fault_count ?? 0).toBe(0)
  })

  test('normal task heartbeat overdue DOES increment agent fault_count', async () => {
    // Create an agent session for the worker
    taskDb.upsertAgentSession('steve', 'session-steve', 'alive')

    // Create a normal task assigned to steve
    const task = taskDb.createTask({
      from: 'boss',
      to: 'steve',
      description: 'Normal work task',
      priority: 'normal',
    })
    taskDb.claimTask(task.id, 'steve')

    // Set heartbeat and next_check_at to be overdue
    taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          last_heartbeat_at = datetime('now', '-300 seconds'),
          next_check_at = datetime('now', '-1 seconds')
        WHERE id = ?
      `).run(task.id)
    })

    // Check steve fault_count before
    const beforeFault = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('steve') as any
    )
    expect(beforeFault.fault_count ?? 0).toBe(0)

    // Run the reconciler
    await reconciler.reconcileDueTasks()

    // Check steve fault_count after — should be incremented to 1
    const afterFault = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('steve') as any
    )
    expect(afterFault.fault_count).toBe(1)
  })
})
