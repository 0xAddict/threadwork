import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-stall-counter-test.db'

// These tests exercise the DB-level invariant that updateHeartbeat resets
// stall_miss_count, and that the column persists. The full watchdog loop
// (which does the increment) is covered by the integration smoke test.

describe('stall_miss_count on tasks (v2-lite B5)', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('new tasks default to stall_miss_count=0', () => {
    const t = db.createTask({ from: 'steve', to: 'steve', description: 'test', priority: 'normal' })
    const row = db.run(s =>
      s.prepare('SELECT stall_miss_count FROM tasks WHERE id = ?').get(t.id) as { stall_miss_count: number }
    )
    expect(row.stall_miss_count).toBe(0)
  })

  test('updateHeartbeat resets stall_miss_count to 0', () => {
    const t = db.createTask({ from: 'steve', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(t.id, 'steve')

    // Manually bump the counter to simulate a prior missed cycle.
    db.run(s => s.prepare('UPDATE tasks SET stall_miss_count = 3 WHERE id = ?').run(t.id))

    db.updateHeartbeat({ taskId: t.id, agent: 'steve', detail: 'alive', isProgress: true })

    const row = db.run(s =>
      s.prepare('SELECT stall_miss_count FROM tasks WHERE id = ?').get(t.id) as { stall_miss_count: number }
    )
    expect(row.stall_miss_count).toBe(0)
  })

  test('blocked heartbeat also resets stall_miss_count', () => {
    const t = db.createTask({ from: 'steve', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(t.id, 'steve')
    db.run(s => s.prepare('UPDATE tasks SET stall_miss_count = 5 WHERE id = ?').run(t.id))

    db.updateHeartbeat({
      taskId: t.id,
      agent: 'steve',
      detail: 'blocked',
      isBlocked: true,
      blockedReason: 'waiting on X',
    })

    const row = db.run(s =>
      s.prepare('SELECT stall_miss_count, blocked_at FROM tasks WHERE id = ?').get(t.id) as { stall_miss_count: number; blocked_at: string | null }
    )
    expect(row.stall_miss_count).toBe(0)
    expect(row.blocked_at).toBeTruthy()
  })

  test('manual miss count increment persists across reads', () => {
    const t = db.createTask({ from: 'steve', to: 'steve', description: 'test', priority: 'normal' })
    db.run(s => s.prepare('UPDATE tasks SET stall_miss_count = 1 WHERE id = ?').run(t.id))

    const row = db.run(s =>
      s.prepare('SELECT stall_miss_count FROM tasks WHERE id = ?').get(t.id) as { stall_miss_count: number }
    )
    expect(row.stall_miss_count).toBe(1)
  })
})
