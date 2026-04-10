import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB } from '../decision'
import { AuditLog } from '../audit'
import { TaskReconciler, type ReconcileResult } from '../watchdog'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/idle-nudge-test.db'

function freshResult(): ReconcileResult {
  return {
    checked: 0,
    nudged: 0,
    escalated: 0,
    blocked_relayed: 0,
    dead_sessions: 0,
    decisions_expired: 0,
    decisions_nudged: 0,
    decisions_ready: 0,
    idle_nudges: 0,
  }
}

describe('idle agent board check nudging', () => {
  let taskDb: TaskDB
  let audit: AuditLog
  let mem: MemoryDB
  let dec: DecisionDB
  let reconciler: TaskReconciler

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    audit = new AuditLog(taskDb)
    mem = new MemoryDB(taskDb)
    dec = new DecisionDB(taskDb, mem)
    reconciler = new TaskReconciler(taskDb, audit, {
      cadenceSec: 30,
      sessionTimeoutSec: 180,
      leaseTimeoutSec: 120,
    })
  })

  // -----------------------------------------------------------------------
  // Helper: backdate an agent's last audit_log entry to simulate idle time
  // -----------------------------------------------------------------------

  function simulateAgentActivity(agent: string, minutesAgo: number): void {
    const db = (taskDb as any).db
    // Insert an activity entry backdated by the specified minutes
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, created_at)
      VALUES (?, 'task_claimed', '{"task_id":99}', datetime('now', '-' || ? || ' minutes'))
    `).run(agent, minutesAgo)
  }

  function createPendingTaskFor(agent: string): void {
    taskDb.createTask({ from: 'boss', to: agent, description: 'Test pending task', priority: 'normal' })
  }

  function createInProgressTaskFor(agent: string): void {
    const task = taskDb.createTask({ from: 'boss', to: agent, description: 'Active task', priority: 'normal' })
    taskDb.claimTask(task.id, agent)
  }

  // -----------------------------------------------------------------------
  // 1. Idle agent with pending tasks gets nudged after 15 min
  // -----------------------------------------------------------------------

  test('nudges idle agent with pending tasks after 15 min', async () => {
    simulateAgentActivity('steve', 20) // idle for 20 min
    createPendingTaskFor('steve')

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    expect(result.idle_nudges).toBe(1)
  })

  // -----------------------------------------------------------------------
  // 2. Agent with active in_progress tasks is NOT nudged
  // -----------------------------------------------------------------------

  test('does not nudge agents with active in_progress tasks', async () => {
    simulateAgentActivity('steve', 20) // idle for 20 min
    createPendingTaskFor('steve')
    createInProgressTaskFor('steve') // but has an active task

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    expect(result.idle_nudges).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 3. Agent nudged once is NOT nudged again within 30 min cooldown
  // -----------------------------------------------------------------------

  test('respects 30-minute cooldown between nudges', async () => {
    simulateAgentActivity('steve', 20)
    createPendingTaskFor('steve')

    const result1 = freshResult()
    await reconciler.monitorIdleAgents(result1)
    expect(result1.idle_nudges).toBe(1)

    // Run again immediately — should NOT nudge again (cooldown)
    const result2 = freshResult()
    await reconciler.monitorIdleAgents(result2)
    expect(result2.idle_nudges).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 4. Nudge message includes correct pending task and decision counts
  // -----------------------------------------------------------------------

  test('nudge audit entry includes pending task and decision counts', async () => {
    simulateAgentActivity('steve', 20)
    createPendingTaskFor('steve')
    createPendingTaskFor('steve') // 2 pending tasks

    // Also create an open decision
    dec.openDecision('Should we refactor?', null, 'boss')

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    expect(result.idle_nudges).toBe(1)

    // Verify audit entry has correct counts
    const auditEntries = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' })
    expect(auditEntries.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(auditEntries[0].detail!)
    expect(detail.agent).toBe('steve')
    expect(detail.pending_tasks).toBe(2)
    expect(detail.open_decisions).toBe(1)
    expect(detail.idle_min).toBeGreaterThanOrEqual(20)
  })

  // -----------------------------------------------------------------------
  // 5. idle_board_nudge action logged to audit trail
  // -----------------------------------------------------------------------

  test('logs idle_board_nudge to audit trail', async () => {
    simulateAgentActivity('sadie', 25)
    createPendingTaskFor('sadie')

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    const auditEntries = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' })
    expect(auditEntries.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(auditEntries[0].detail!)
    expect(detail.agent).toBe('sadie')
  })

  // -----------------------------------------------------------------------
  // 6. ReconcileResult includes idle_nudges field
  // -----------------------------------------------------------------------

  test('ReconcileResult includes idle_nudges field', () => {
    const result = freshResult()
    expect(result).toHaveProperty('idle_nudges')
    expect(typeof result.idle_nudges).toBe('number')
    expect(result.idle_nudges).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 7. Does not nudge agents who are recently active (< 15 min)
  // -----------------------------------------------------------------------

  test('does not nudge recently active agents', async () => {
    simulateAgentActivity('steve', 5) // active 5 min ago
    createPendingTaskFor('steve')

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    expect(result.idle_nudges).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 8. Does not nudge if no pending work exists
  // -----------------------------------------------------------------------

  test('does not nudge idle agent if no pending work exists', async () => {
    simulateAgentActivity('steve', 20) // idle for 20 min
    // No pending tasks or open decisions

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    expect(result.idle_nudges).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 9. Nudges agent when only open decisions exist (no pending tasks)
  // -----------------------------------------------------------------------

  test('nudges idle agent when only open decisions exist', async () => {
    simulateAgentActivity('kiera', 20)
    // No pending tasks, but an open decision
    dec.openDecision('Architecture review', null, 'boss')

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    // kiera should be nudged (open decisions count as pending work)
    const auditEntries = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' })
    const kieraNudge = auditEntries.find(e => {
      const detail = JSON.parse(e.detail ?? '{}')
      return detail.agent === 'kiera'
    })
    expect(kieraNudge).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // 10. Multiple idle agents can be nudged in the same cycle
  // -----------------------------------------------------------------------

  test('nudges multiple idle agents in the same cycle', async () => {
    simulateAgentActivity('steve', 20)
    simulateAgentActivity('sadie', 25)
    createPendingTaskFor('steve')
    createPendingTaskFor('sadie')

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    expect(result.idle_nudges).toBeGreaterThanOrEqual(2)
  })

  // -----------------------------------------------------------------------
  // 11. Agents with no audit history are skipped (not nudged)
  // -----------------------------------------------------------------------

  test('skips agents with no audit history', async () => {
    // Don't create any audit entries for steve
    createPendingTaskFor('steve')

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    expect(result.idle_nudges).toBe(0)
  })
})
