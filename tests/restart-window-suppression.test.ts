// Tests for restart-window false-positive suppression (TG #5371 / task #1134).
//
// When an agent's session restarts (SessionStart hook fires after /clear or
// MCP reconnect), the agent's main thread is silent for 60–300s while the new
// session boots. During that gap, the watchdog was firing:
//   1. Heartbeat-overdue worker nudges
//   2. Circuit-OPEN alerts (after recordFault tripped the breaker)
// Both alerts page GweiSprayer on Telegram. session-boot.sh / context-budget-
// watch.sh now touch ~/.claude/state/restart-window/{agent}.flag; the watchdog
// reads that flag's mtime and suppresses both alerts while it's < 300s old.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler } from '../watchdog'
import { unlinkSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const TEST_DB = '/tmp/restart-window-test.db'
const FLAG_DIR = join(homedir(), '.claude', 'state', 'restart-window')
const TEST_AGENT = 'steve'
const FLAG_PATH = join(FLAG_DIR, `${TEST_AGENT}.flag`)

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

// Insert an in_progress task that is OVERDUE on heartbeat (last_heartbeat_at
// 600s ago, with heartbeat_timeout_sec = 120). That forces the watchdog into
// handleHeartbeatOverdue when reconcileTask runs.
function createOverdueTask(taskDb: TaskDB, agent: string): number {
  const db = rawDb(taskDb)
  const result = db.prepare(`
    INSERT INTO tasks (from_agent, to_agent, description, priority, status,
      claimed_at, last_heartbeat_at, heartbeat_timeout_sec, next_check_at,
      supervisor_agent, escalation_level)
    VALUES ('boss', ?, 'overdue task', 'normal', 'in_progress',
      datetime('now', '-1200 seconds'),
      datetime('now', '-600 seconds'),
      120,
      datetime('now', '-1 second'),
      'boss', 0)
  `).run(agent)
  return Number(result.lastInsertRowid)
}

function setFlagAge(seconds: number): void {
  mkdirSync(FLAG_DIR, { recursive: true })
  writeFileSync(FLAG_PATH, '')
  const t = (Date.now() - seconds * 1000) / 1000
  utimesSync(FLAG_PATH, t, t)
}

function clearFlag(): void {
  try { unlinkSync(FLAG_PATH) } catch {}
}

function emptyReconcileResult() {
  return {
    checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
    dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
    decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0,
  }
}

describe('restart-window suppression (task #1134)', () => {
  beforeEach(() => clearFlag())
  afterEach(() => clearFlag())

  test('flag absent → heartbeat-overdue nudge fires, fault is recorded', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    clearFlag()

    const taskId = createOverdueTask(taskDb, TEST_AGENT)
    const result = emptyReconcileResult()
    await (reconciler as any).reconcileTask(
      rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(taskId),
      result,
    )

    expect(result.nudged).toBe(1)

    // No suppression audit entry should have been written.
    const suppressed = rawDb(taskDb).prepare(`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'restart_window_suppressed' AND task_id = ?
    `).get(taskId) as { n: number }
    expect(suppressed.n).toBe(0)
  })

  test('fresh flag (< 300s) → nudge suppressed, fault NOT recorded, audit logged', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    setFlagAge(30) // 30s old, well inside the 300s TTL

    const taskId = createOverdueTask(taskDb, TEST_AGENT)
    const result = emptyReconcileResult()
    await (reconciler as any).reconcileTask(
      rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(taskId),
      result,
    )

    expect(result.nudged).toBe(0)
    expect(result.escalated).toBe(0)

    // Two suppression audit entries: one for fault_record skip, one for
    // heartbeat_overdue_nudge skip.
    const rows = rawDb(taskDb).prepare(`
      SELECT detail FROM audit_log
      WHERE action = 'restart_window_suppressed' AND task_id = ?
      ORDER BY id
    `).all(taskId) as { detail: string }[]
    expect(rows.length).toBe(2)
    const kinds = rows.map(r => JSON.parse(r.detail).suppressed).sort()
    expect(kinds).toEqual(['fault_record', 'heartbeat_overdue_nudge'])
  })

  test('expired flag (> 300s) → behaves as if flag absent', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    setFlagAge(400) // older than the 300s TTL

    const taskId = createOverdueTask(taskDb, TEST_AGENT)
    const result = emptyReconcileResult()
    await (reconciler as any).reconcileTask(
      rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(taskId),
      result,
    )

    expect(result.nudged).toBe(1)
    const suppressed = rawDb(taskDb).prepare(`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'restart_window_suppressed' AND task_id = ?
    `).get(taskId) as { n: number }
    expect(suppressed.n).toBe(0)
  })

  test('flag for OTHER agent does not suppress alerts for this agent', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    // Touch the flag for a different agent
    mkdirSync(FLAG_DIR, { recursive: true })
    const otherFlag = join(FLAG_DIR, 'kiera.flag')
    writeFileSync(otherFlag, '')
    try {
      const taskId = createOverdueTask(taskDb, TEST_AGENT)
      const result = emptyReconcileResult()
      await (reconciler as any).reconcileTask(
        rawDb(taskDb).prepare('SELECT * FROM tasks WHERE id = ?').get(taskId),
        result,
      )

      expect(result.nudged).toBe(1)
    } finally {
      try { unlinkSync(otherFlag) } catch {}
    }
  })

  test('flag does NOT block level-3 boss escalation', async () => {
    const { taskDb, audit, reconciler } = freshDb()
    setFlagAge(30)

    const db = rawDb(taskDb)
    // Task is already at escalation_level 2 — next overdue tick goes to level 3
    // which calls escalateToBoss (NOT gated by restart window).
    const inserted = db.prepare(`
      INSERT INTO tasks (from_agent, to_agent, description, priority, status,
        claimed_at, last_heartbeat_at, heartbeat_timeout_sec, next_check_at,
        supervisor_agent, escalation_level)
      VALUES ('boss', ?, 'almost-escalated task', 'normal', 'in_progress',
        datetime('now', '-1200 seconds'),
        datetime('now', '-600 seconds'),
        120,
        datetime('now', '-1 second'),
        'boss', 2)
    `).run(TEST_AGENT)
    const taskId = Number(inserted.lastInsertRowid)

    const result = emptyReconcileResult()
    await (reconciler as any).reconcileTask(
      db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId),
      result,
    )

    expect(result.escalated).toBe(1)
    expect(result.nudged).toBe(0)
  })
})
