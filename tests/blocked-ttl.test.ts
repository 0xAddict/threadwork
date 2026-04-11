import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler } from '../watchdog'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/blocked-ttl-test.db'

describe('S2.3: blocked state TTL — dead workers stop relaying', () => {
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

  test('stale blocked_at (>10min) with no fresh heartbeat clears blocked and falls through to crash/heartbeat handling', async () => {
    // Create agent session so isSessionDead returns false (alive but unresponsive)
    taskDb.upsertAgentSession('steve', 'session-steve', 'alive')

    // Create an in_progress task assigned to steve
    const task = taskDb.createTask({
      from: 'boss',
      to: 'steve',
      description: 'Work that got blocked then worker died',
      priority: 'normal',
    })
    taskDb.claimTask(task.id, 'steve')

    // Set blocked_at to 15 minutes ago, last_heartbeat_at to 15 minutes ago,
    // and next_check_at to now (so the watchdog picks it up)
    taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          blocked_at = datetime('now', '-900 seconds'),
          blocked_reason = 'Waiting for external API',
          last_heartbeat_at = datetime('now', '-900 seconds'),
          next_check_at = datetime('now', '-1 seconds')
        WHERE id = ?
      `).run(task.id)
    })

    // Run the reconciler
    const result = await reconciler.reconcileDueTasks()

    // The task should NOT have been merely relayed as blocked
    expect(result.blocked_relayed).toBe(0)

    // The blocked_at should have been cleared
    const updated = taskDb.run(db =>
      db.prepare('SELECT blocked_at, blocked_reason FROM tasks WHERE id = ?').get(task.id) as any
    )
    expect(updated.blocked_at).toBeNull()
    expect(updated.blocked_reason).toBeNull()

    // There should be an audit entry for blocked_ttl_expired
    const auditEntries = taskDb.run(db =>
      db.prepare("SELECT * FROM audit_log WHERE action = 'blocked_ttl_expired' AND task_id = ?").all(task.id)
    )
    expect(auditEntries.length).toBeGreaterThanOrEqual(1)
  })

  test('fresh blocked_at (<10min) still relays normally', async () => {
    // Create agent session
    taskDb.upsertAgentSession('steve', 'session-steve', 'alive')

    // Create an in_progress task
    const task = taskDb.createTask({
      from: 'boss',
      to: 'steve',
      description: 'Recently blocked task',
      priority: 'normal',
    })
    taskDb.claimTask(task.id, 'steve')

    // Set blocked_at to 2 minutes ago (well within TTL), heartbeat also 2 minutes ago
    taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          blocked_at = datetime('now', '-120 seconds'),
          blocked_reason = 'Waiting for approval',
          last_heartbeat_at = datetime('now', '-120 seconds'),
          next_check_at = datetime('now', '-1 seconds')
        WHERE id = ?
      `).run(task.id)
    })

    // Run the reconciler
    const result = await reconciler.reconcileDueTasks()

    // Should relay normally
    expect(result.blocked_relayed).toBe(1)

    // blocked_at should still be set
    const updated = taskDb.run(db =>
      db.prepare('SELECT blocked_at, blocked_reason FROM tasks WHERE id = ?').get(task.id) as any
    )
    expect(updated.blocked_at).not.toBeNull()
    expect(updated.blocked_reason).toBe('Waiting for approval')
  })

  test('stale blocked_at but fresh heartbeat since blocking keeps relaying', async () => {
    // Create agent session
    taskDb.upsertAgentSession('steve', 'session-steve', 'alive')

    // Create an in_progress task
    const task = taskDb.createTask({
      from: 'boss',
      to: 'steve',
      description: 'Blocked but still alive worker',
      priority: 'normal',
    })
    taskDb.claimTask(task.id, 'steve')

    // Set blocked_at to 15 minutes ago, but last_heartbeat_at to 1 minute ago
    // (worker is still alive, just genuinely blocked)
    taskDb.run(db => {
      db.prepare(`
        UPDATE tasks SET
          blocked_at = datetime('now', '-900 seconds'),
          blocked_reason = 'Waiting for manual approval',
          last_heartbeat_at = datetime('now', '-60 seconds'),
          next_check_at = datetime('now', '-1 seconds')
        WHERE id = ?
      `).run(task.id)
    })

    // Run the reconciler
    const result = await reconciler.reconcileDueTasks()

    // Should still relay — worker is alive (heartbeat is fresh relative to blocked_at)
    expect(result.blocked_relayed).toBe(1)

    // blocked_at should remain set
    const updated = taskDb.run(db =>
      db.prepare('SELECT blocked_at FROM tasks WHERE id = ?').get(task.id) as any
    )
    expect(updated.blocked_at).not.toBeNull()
  })
})
