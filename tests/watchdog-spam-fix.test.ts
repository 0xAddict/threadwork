// Tests for watchdog spam fix (#823): sibling-completion auto-resolution
// + long-block relay cap. See /tmp/watchdog-spam-fix-spec.md.

import { describe, test, expect } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler } from '../watchdog'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/watchdog-spam-fix-test.db'

// Note: we let dispatchAgentNudge / postToGroup run for real. They look up
// agent sessions / tmux panes which simply no-op when those aren't present in
// the synthetic test DB, so the side effects are harmless for these tests.

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

function createBlockedChild(taskDb: TaskDB, opts: {
  parentId: number | null
  blockedOn?: string
  blockedAtOffsetSec?: number
  toAgent?: string
  supervisor?: string
}): number {
  const db = rawDb(taskDb)
  const offset = opts.blockedAtOffsetSec ?? -120 // blocked 2 minutes ago
  const blockedOn = opts.blockedOn ?? 'human'
  const toAgent = opts.toAgent ?? 'steve'
  const supervisor = opts.supervisor ?? 'boss'

  // Build the modifier inline so negative offsets become '-N seconds' and
  // positive ones become '+N seconds' — sqlite rejects '+-N seconds'.
  const modifier = (offset >= 0 ? `+${offset} seconds` : `${offset} seconds`)
  const insert = db.prepare(`
    INSERT INTO tasks (from_agent, to_agent, description, priority, status,
      parent_task_id, supervisor_agent, blocked_at, blocked_on,
      blocked_reason, claimed_at, next_check_at)
    VALUES (?, ?, ?, 'normal', 'in_progress', ?, ?,
      datetime('now', ?), ?, 'test block',
      datetime('now', '-300 seconds'), datetime('now', '-1 second'))
  `)
  const result = insert.run(
    'boss', toAgent, 'blocked child', opts.parentId, supervisor, modifier, blockedOn,
  )
  return Number(result.lastInsertRowid)
}

function createCompletedSibling(taskDb: TaskDB, parentId: number, completedOffsetSec: number): number {
  const db = rawDb(taskDb)
  const modifier = completedOffsetSec >= 0 ? `+${completedOffsetSec} seconds` : `${completedOffsetSec} seconds`
  const insert = db.prepare(`
    INSERT INTO tasks (from_agent, to_agent, description, priority, status,
      parent_task_id, supervisor_agent, completed_at, claimed_at, result)
    VALUES ('boss', 'steve', 'sibling that shipped', 'normal', 'completed',
      ?, 'boss',
      datetime('now', ?),
      datetime('now', '-600 seconds'), 'shipped')
  `)
  const result = insert.run(parentId, modifier)
  return Number(result.lastInsertRowid)
}

function createParent(taskDb: TaskDB): number {
  const db = rawDb(taskDb)
  const result = db.prepare(`
    INSERT INTO tasks (from_agent, to_agent, description, priority, status)
    VALUES ('boss', 'boss', 'parent', 'normal', 'in_progress')
  `).run()
  return Number(result.lastInsertRowid)
}

describe('watchdog spam fix (#823)', () => {
  describe('sibling-completion auto-resolution', () => {
    test('T-sibling-completion: blocked task with completed sibling auto-resolves', async () => {
      const { taskDb, audit, reconciler } = freshDb()
      const parent = createParent(taskDb)
      // sibling completed 60s AFTER child was blocked (blocked at -120s, sib completed at -60s)
      const sibling = createCompletedSibling(taskDb, parent, -60)
      const child = createBlockedChild(taskDb, { parentId: parent, blockedOn: 'human' })

      // Force watchdog to pick up the task
      const result = { checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
        dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
        decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0 }
      const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(child)
      await (reconciler as any).reconcileTask(task, result)

      const updated = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(child)
      expect(updated.status).toBe('completed')
      expect(updated.result).toContain('[auto: superseded by sibling]')
      expect(updated.blocked_at).toBeNull()
      expect(updated.next_check_at).toBeNull()

      const auditRows = audit.query({ taskId: child, action: 'auto_resolved_via_sibling' })
      expect(auditRows.length).toBe(1)

      // Should NOT have relayed: this is the whole point.
      expect(result.blocked_relayed).toBe(0)
    })

    test('T-no-sibling-no-resolution: parent but no completed sibling → BLOCKED branch fires', async () => {
      const { taskDb, audit, reconciler } = freshDb()
      const parent = createParent(taskDb)
      // No sibling created
      const child = createBlockedChild(taskDb, { parentId: parent, blockedOn: 'human' })

      const result = { checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
        dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
        decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0 }
      const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(child)
      await (reconciler as any).reconcileTask(task, result)

      const updated = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(child)
      expect(updated.status).toBe('in_progress') // still blocked / not auto-resolved
      expect(updated.blocked_at).not.toBeNull()
      expect(result.blocked_relayed).toBe(1) // long-block path fired

      const auto = audit.query({ taskId: child, action: 'auto_resolved_via_sibling' })
      expect(auto.length).toBe(0)
    })

    test('T-no-parent-no-resolution: blocked task with no parent → BLOCKED branch fires', async () => {
      const { taskDb, audit, reconciler } = freshDb()
      const child = createBlockedChild(taskDb, { parentId: null, blockedOn: 'human' })

      const result = { checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
        dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
        decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0 }
      const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(child)
      await (reconciler as any).reconcileTask(task, result)

      const auto = audit.query({ taskId: child, action: 'auto_resolved_via_sibling' })
      expect(auto.length).toBe(0)
      expect(result.blocked_relayed).toBe(1)
    })

    test('sibling-completion guard ignores siblings completed BEFORE the block', async () => {
      const { taskDb, audit, reconciler } = freshDb()
      const parent = createParent(taskDb)
      // sibling completed BEFORE the child was blocked (child blocked at -120s, sib completed at -300s)
      createCompletedSibling(taskDb, parent, -300)
      const child = createBlockedChild(taskDb, { parentId: parent, blockedOn: 'human' })

      const result = { checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
        dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
        decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0 }
      const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(child)
      await (reconciler as any).reconcileTask(task, result)

      const auto = audit.query({ taskId: child, action: 'auto_resolved_via_sibling' })
      expect(auto.length).toBe(0)
      expect(result.blocked_relayed).toBe(1)
    })
  })

  describe('long-block relay cap', () => {
    function makeRunner(taskDb: TaskDB, audit: AuditLog, reconciler: TaskReconciler, taskId: number) {
      return async () => {
        const result = { checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
          dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
          decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0 }
        const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
        await (reconciler as any).reconcileTask(task, result)
        return result
      }
    }

    test('T-relay-cap-fires-3-times: relays 3x, escalates-once on 4th', async () => {
      const { taskDb, audit, reconciler } = freshDb()
      // No parent, no sibling — exercises the long-block path purely
      const child = createBlockedChild(taskDb, { parentId: null, blockedOn: 'human' })
      const run = makeRunner(taskDb, audit, reconciler, child)

      // Cycles 1, 2, 3: each should relay and bump the counter
      const r1 = await run()
      expect(r1.blocked_relayed).toBe(1)
      let row: any = rawDb(taskDb).prepare('SELECT blocked_relay_count FROM tasks WHERE id = ?').get(child)
      expect(row.blocked_relay_count).toBe(1)

      // Bypass dedup cooldown by clearing watchdog_alert_state
      rawDb(taskDb).prepare('DELETE FROM watchdog_alert_state').run()

      const r2 = await run()
      expect(r2.blocked_relayed).toBe(1)
      row = rawDb(taskDb).prepare('SELECT blocked_relay_count FROM tasks WHERE id = ?').get(child)
      expect(row.blocked_relay_count).toBe(2)

      rawDb(taskDb).prepare('DELETE FROM watchdog_alert_state').run()
      const r3 = await run()
      expect(r3.blocked_relayed).toBe(1)
      row = rawDb(taskDb).prepare('SELECT blocked_relay_count FROM tasks WHERE id = ?').get(child)
      expect(row.blocked_relay_count).toBe(3)

      // Cycle 4: cap reached → no relay, audit row, next_check_at NULL
      rawDb(taskDb).prepare('DELETE FROM watchdog_alert_state').run()
      const r4 = await run()
      expect(r4.blocked_relayed).toBe(0)
      row = rawDb(taskDb).prepare('SELECT blocked_relay_count, next_check_at FROM tasks WHERE id = ?').get(child)
      expect(row.next_check_at).toBeNull()

      const cap = audit.query({ taskId: child, action: 'blocked_relay_cap_reached' })
      expect(cap.length).toBe(1)
    })

    test('T-relay-cap-resets-on-heartbeat: heartbeat after blocked_at resets counter', async () => {
      const { taskDb, audit, reconciler } = freshDb()
      const child = createBlockedChild(taskDb, { parentId: null, blockedOn: 'human' })
      const run = makeRunner(taskDb, audit, reconciler, child)

      // Drive the counter to 3 via 3 reconcile cycles
      for (let i = 0; i < 3; i++) {
        rawDb(taskDb).prepare('DELETE FROM watchdog_alert_state').run()
        await run()
      }
      let row: any = rawDb(taskDb).prepare('SELECT blocked_relay_count FROM tasks WHERE id = ?').get(child)
      expect(row.blocked_relay_count).toBe(3)

      // Inject a heartbeat dated AFTER blocked_at
      rawDb(taskDb).prepare(`
        UPDATE tasks SET last_heartbeat_at = datetime('now', '+1 second')
        WHERE id = ?
      `).run(child)
      // Reset alert dedup
      rawDb(taskDb).prepare('DELETE FROM watchdog_alert_state').run()

      // Next cycle: counter resets to 0, then bumps to 1, relay fires
      const r4 = await run()
      expect(r4.blocked_relayed).toBe(1)
      row = rawDb(taskDb).prepare('SELECT blocked_relay_count FROM tasks WHERE id = ?').get(child)
      expect(row.blocked_relay_count).toBe(1)

      const cap = audit.query({ taskId: child, action: 'blocked_relay_cap_reached' })
      expect(cap.length).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Task #850: heartbeat-overdue terminal-status guard (Layer 1) + shouldAlert
// dedup (Layer 2). Mirrors the #823/#615 hardening already on the blocked_relay
// path. Layer 3 (heartbeat_relay_count column) is intentionally NOT implemented.
// ---------------------------------------------------------------------------

function emptyResult() {
  return {
    checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
    dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
    decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0,
  }
}

// Create an in_progress task with a stale heartbeat and a due next_check_at so
// reconcileTask routes it into handleHeartbeatOverdue.
function createHeartbeatStaleTask(taskDb: TaskDB, opts: {
  toAgent?: string
  heartbeatStaleSec?: number
  escalationLevel?: number
} = {}): number {
  const db = rawDb(taskDb)
  const toAgent = opts.toAgent ?? 'steve'
  const stale = opts.heartbeatStaleSec ?? 200
  const level = opts.escalationLevel ?? 0
  const result = db.prepare(`
    INSERT INTO tasks (from_agent, to_agent, description, priority, status,
      supervisor_agent, claimed_at, last_heartbeat_at, heartbeat_timeout_sec,
      escalation_level, next_check_at)
    VALUES ('boss', ?, 'hb stale task', 'normal', 'in_progress',
      'boss', datetime('now', '-600 seconds'),
      datetime('now', ?), 60, ?, datetime('now', '-1 second'))
  `).run(toAgent, `-${stale} seconds`, level)
  return Number(result.lastInsertRowid)
}

describe('watchdog heartbeat-overdue hardening (#850)', () => {
  function makeRunner(taskDb: TaskDB, reconciler: TaskReconciler, taskId: number) {
    return async () => {
      const result = emptyResult()
      const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
      await (reconciler as any).reconcileTask(task, result)
      return { result, task }
    }
  }

  test('T-hb-completed-no-escalation: task completed mid-cycle is skipped, no escalation', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    const id = createHeartbeatStaleTask(taskDb)

    // Snapshot the task as the batch query would (status still in_progress)...
    const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    // ...then complete it AFTER the snapshot but BEFORE reconcile (TOCTOU race).
    rawDb(taskDb).prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(id)

    const result = emptyResult()
    await (reconciler as any).reconcileTask(task, result)

    expect(result.nudged).toBe(0)
    expect(result.escalated).toBe(0)

    const updated = rawDb(taskDb).prepare('SELECT escalation_level, next_check_at FROM tasks WHERE id = ?').get(id) as any
    expect(updated.escalation_level).toBe(0) // unchanged
    expect(updated.next_check_at).toBeNull() // disarmed

    const skip = audit.query({ taskId: id, action: 'heartbeat_overdue_skipped_terminal' })
    expect(skip.length).toBe(1)

    // No heartbeat nudge/escalation audit rows.
    expect(audit.query({ taskId: id, action: 'heartbeat_nudge' }).length).toBe(0)
    expect(audit.query({ taskId: id, action: 'heartbeat_escalation' }).length).toBe(0)
  })

  test('T-hb-cancelled-no-escalation: cancelled task is skipped, no escalation', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    const id = createHeartbeatStaleTask(taskDb)

    const task = rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    rawDb(taskDb).prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`).run(id)

    const result = emptyResult()
    await (reconciler as any).reconcileTask(task, result)

    expect(result.nudged).toBe(0)
    expect(result.escalated).toBe(0)

    const updated = rawDb(taskDb).prepare('SELECT escalation_level, next_check_at FROM tasks WHERE id = ?').get(id) as any
    expect(updated.escalation_level).toBe(0)
    expect(updated.next_check_at).toBeNull()

    const skip = audit.query({ taskId: id, action: 'heartbeat_overdue_skipped_terminal' })
    expect(skip.length).toBe(1)
  })

  test('T-hb-live-in-progress-still-escalates: live stale task still nudges (no over-suppression)', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    const id = createHeartbeatStaleTask(taskDb) // stays in_progress
    const run = makeRunner(taskDb, reconciler, id)

    const { result } = await run()

    // level 1 → worker nudge fires (no restart window), level bumps to 1
    expect(result.nudged).toBe(1)
    expect(result.escalated).toBe(0)

    const updated = rawDb(taskDb).prepare('SELECT escalation_level, next_check_at FROM tasks WHERE id = ?').get(id) as any
    expect(updated.escalation_level).toBe(1)
    expect(updated.next_check_at).not.toBeNull() // re-armed, NOT disarmed

    expect(audit.query({ taskId: id, action: 'heartbeat_overdue_skipped_terminal' }).length).toBe(0)
    expect(audit.query({ taskId: id, action: 'heartbeat_nudge' }).length).toBe(1)
  })

  test('T-hb-dedup-cooldown: repeat heartbeat-overdue at same level within cooldown is suppressed', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    const id = createHeartbeatStaleTask(taskDb)
    const run = makeRunner(taskDb, reconciler, id)

    // Cycle 1: nudge fires (level 1)
    const r1 = await run()
    expect(r1.result.nudged).toBe(1)

    // Force the task back to level 0 and re-arm next_check_at so cycle 2 lands
    // at the SAME newLevel=1 with the SAME shouldAlert payload, inside cooldown.
    rawDb(taskDb).prepare(`
      UPDATE tasks SET escalation_level = 0,
        last_heartbeat_at = datetime('now', '-200 seconds'),
        next_check_at = datetime('now', '-1 second')
      WHERE id = ?
    `).run(id)

    // Cycle 2: same payload {agent, level:1} within 1800s → suppressed.
    const r2 = await run()
    expect(r2.result.nudged).toBe(0)

    const state = rawDb(taskDb).prepare(
      `SELECT fire_count FROM watchdog_alert_state WHERE task_id = ? AND alert_type = 'heartbeat_overdue'`
    ).get(id) as any
    expect(state.fire_count).toBe(1) // fired once, not twice
  })
})
