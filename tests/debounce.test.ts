import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
import { tryNudge, recordPendingEvent, buildWakeMessage } from '../debounce'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-debounce-test.db'

describe('debounce helper (v2-lite B2)', () => {
  let db: TaskDB
  const origEnabled = process.env.THREADWORK_DEBOUNCE_ENABLED
  const origWindow = process.env.THREADWORK_DEBOUNCE_WINDOW_SEC

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
    process.env.THREADWORK_DEBOUNCE_ENABLED = '1'
    // Use a 90s window so "suppressed" paths are clearly inside the window
    // for a single test tick.
    process.env.THREADWORK_DEBOUNCE_WINDOW_SEC = '90'
  })

  afterEach(() => {
    if (origEnabled === undefined) delete process.env.THREADWORK_DEBOUNCE_ENABLED
    else process.env.THREADWORK_DEBOUNCE_ENABLED = origEnabled
    if (origWindow === undefined) delete process.env.THREADWORK_DEBOUNCE_WINDOW_SEC
    else process.env.THREADWORK_DEBOUNCE_WINDOW_SEC = origWindow
  })

  test('fires immediately when no prior nudge recorded', () => {
    // The migration seeds boss/steve/sadie/kiera with last_nudged_at=NULL.
    const result = tryNudge(db, 'steve', 'normal')
    expect(result.shouldFire).toBe(true)
    expect(result.pendingCount).toBeGreaterThanOrEqual(1)
  })

  test('suppresses within debounce window for normal urgency', () => {
    tryNudge(db, 'steve', 'normal') // first fire
    const second = tryNudge(db, 'steve', 'normal')
    expect(second.shouldFire).toBe(false)
    expect(second.reason).toBe('debounced')
    expect(second.pendingCount).toBe(1)
    expect(second.windowRemainingMs ?? 0).toBeGreaterThan(0)
  })

  test('bypasses window for urgent urgency', () => {
    tryNudge(db, 'steve', 'normal')
    const urgent = tryNudge(db, 'steve', 'urgent')
    expect(urgent.shouldFire).toBe(true)
    expect(urgent.reason).toBe('urgent_bypass')
  })

  test('increments pending_count on suppressed nudges', () => {
    tryNudge(db, 'steve', 'normal') // fire, resets pending_count to 0
    tryNudge(db, 'steve', 'normal') // suppressed, pending_count=1
    tryNudge(db, 'steve', 'normal') // suppressed, pending_count=2
    const third = tryNudge(db, 'steve', 'normal') // suppressed, pending_count=3
    expect(third.shouldFire).toBe(false)
    expect(third.pendingCount).toBe(3)
  })

  test('resets pending_count and updates last_nudged_at on fire', () => {
    tryNudge(db, 'steve', 'normal')
    tryNudge(db, 'steve', 'normal') // suppressed
    tryNudge(db, 'steve', 'normal') // suppressed
    const urgent = tryNudge(db, 'steve', 'urgent') // fires, collapses batch
    expect(urgent.shouldFire).toBe(true)
    // pendingCount reported is the count we collapsed (prior 2 suppressed + this one)
    expect(urgent.pendingCount).toBe(3)

    // Subsequent normal nudge is now counted from zero.
    const after = tryNudge(db, 'steve', 'normal')
    expect(after.shouldFire).toBe(false)
    expect(after.pendingCount).toBe(1)
  })

  test('pass-through when THREADWORK_DEBOUNCE_ENABLED=0', () => {
    process.env.THREADWORK_DEBOUNCE_ENABLED = '0'
    const a = tryNudge(db, 'steve', 'normal')
    const b = tryNudge(db, 'steve', 'normal')
    const c = tryNudge(db, 'steve', 'normal')
    for (const r of [a, b, c]) {
      expect(r.shouldFire).toBe(true)
      expect(r.reason).toBe('disabled')
      expect(r.pendingCount).toBe(0)
    }
  })

  test('recordPendingEvent increments count without firing', () => {
    tryNudge(db, 'steve', 'normal') // fire, pending=0
    recordPendingEvent(db, 'steve', 'normal')
    recordPendingEvent(db, 'steve', 'high')
    const next = tryNudge(db, 'steve', 'normal') // suppressed, count=3
    expect(next.shouldFire).toBe(false)
    expect(next.pendingCount).toBe(3)
  })

  test('buildWakeMessage includes pending count', () => {
    expect(buildWakeMessage(1)).toContain('1 pending event')
    expect(buildWakeMessage(5)).toContain('5 pending events')
    // Never go below 1 — zero would be a degenerate wake payload.
    expect(buildWakeMessage(0)).toContain('1 pending event')
  })
})
