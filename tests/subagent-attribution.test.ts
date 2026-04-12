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

  test('subagent successful heartbeat does NOT decay parent fault_count', () => {
    // S2.1/S2.2 parity: if subagent faults don't CHARGE parent, subagent
    // heartbeats must not CREDIT (decay) the parent either, otherwise the
    // parent's fault_count walks downward on child activity.
    taskDb.upsertAgentSession('boss', 'session-boss', 'alive')

    // Seed boss fault_count to 3
    taskDb.run(db => {
      db.prepare('UPDATE agent_sessions SET fault_count = 3 WHERE agent = ?').run('boss')
    })

    // Parent + subagent child
    const parentTask = taskDb.createTask({
      from: 'boss', to: 'boss', description: 'Parent', priority: 'normal',
    })
    taskDb.claimTask(parentTask.id, 'boss')
    const childTask = taskDb.createSubagentTask({
      description: 'Subagent work',
      parent_task_id: parentTask.id,
      supervisor_agent: 'boss',
    })

    // Subagent reports a successful heartbeat via updateHeartbeat
    taskDb.updateHeartbeat({
      taskId: childTask.id,
      agent: 'boss',
      detail: 'progress',
      isProgress: true,
      isBlocked: false,
    })

    // Boss fault_count must still be 3 — subagent activity does not decay parent
    const after = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('boss') as any
    )
    expect(after.fault_count).toBe(3)
  })

  test('dead parent session with multiple subagent children does NOT multiply fault_count', async () => {
    // S2.1 multiplier regression (flagged by Codex adversarial-review):
    // createSubagentTask sets child.to_agent = supervisor_agent. If the parent's
    // session dies, reconcileTask routes each subagent child through
    // handleDeadSession, which called recordFault(child.to_agent, 'crash') BEFORE
    // the guard — charging a crash fault to the parent for EACH open child row.
    // A parent dying with N open subagents would take N+1 faults instead of 1
    // (1 from the parent's own task, N from the children), inflating the
    // circuit breaker state and causing spurious OPEN transitions.
    //
    // Fix: handleDeadSession now checks task.kind === 'subagent' and routes
    // subagent child crashes through an audit-only branch without touching
    // parent fault_count. This test proves the multiplier no longer occurs.

    // Mark boss session as DEAD — isSessionDead returns true for state === 'dead'
    taskDb.upsertAgentSession('boss', 'session-boss', 'dead')

    // Create parent task (in_progress, due for reconciliation)
    const parentTask = taskDb.createTask({
      from: 'boss',
      to: 'boss',
      description: 'Parent orchestration task',
      priority: 'normal',
    })
    taskDb.claimTask(parentTask.id, 'boss')

    // Create 3 subagent children rooted on the dead parent
    const childIds: number[] = []
    for (let i = 1; i <= 3; i++) {
      const child = taskDb.createSubagentTask({
        description: `Subagent work ${i}`,
        parent_task_id: parentTask.id,
        supervisor_agent: 'boss',
      })
      expect(child.kind).toBe('subagent')
      expect(child.to_agent).toBe('boss')
      childIds.push(child.id)
    }

    // Force all 4 tasks (parent + 3 children) to be due for reconciliation
    taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          last_heartbeat_at = datetime('now', '-600 seconds'),
          next_check_at = datetime('now', '-10 seconds')
        WHERE id IN (?, ?, ?, ?)
      `).run(parentTask.id, childIds[0], childIds[1], childIds[2])
    })

    // Baseline fault_count = 0
    const before = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('boss') as any
    )
    expect(before.fault_count ?? 0).toBe(0)

    // Run reconciler — processes all 4 due tasks. Each hits isSessionDead('boss')
    // which returns true, routing each into handleDeadSession.
    await reconciler.reconcileDueTasks()

    const after = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('boss') as any
    )

    // Without the fix: 1 (parent) + 3 (children) = 4 faults
    // With the fix: 1 (parent only, children exempt via kind='subagent' guard)
    expect(after.fault_count).toBe(1)
  })

  test('normal task heartbeat overdue eventually increments agent fault_count', async () => {
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

    // First overdue cycle: v2-lite stall suppression records the miss but does not
    // charge fault_count yet.
    await reconciler.reconcileDueTasks()

    let afterFault = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('steve') as any
    )
    expect(afterFault.fault_count ?? 0).toBe(0)

    // Force a second overdue cycle so the watchdog treats this as a consecutive miss.
    taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET next_check_at = datetime('now', '-1 seconds')
        WHERE id = ?
      `).run(task.id)
    })

    await reconciler.reconcileDueTasks()

    // Second consecutive miss should charge one fault to the normal worker.
    afterFault = taskDb.run(db =>
      db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('steve') as any
    )
    expect(afterFault.fault_count).toBe(1)
  })
})
