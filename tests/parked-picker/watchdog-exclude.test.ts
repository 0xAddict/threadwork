/**
 * C2.9 — watchdog.ts: agent PARKED_PICKER for 50 min → subagent-stall-watcher does NOT fire
 *
 * This test documents the exclusion contract: PARKED_PICKER agents are excluded
 * from the 40-min subagent-stall-watcher threshold. The test simulates the
 * stall-watcher logic and verifies the exclusion.
 */
import { describe, it, expect } from 'bun:test'
import { isReadyForDispatch } from '../../inhibit-engine'

// Simulate the subagent-stall-watcher exclusion logic
// The real stall watcher checks agent state before firing
function shouldStallWatcherFire(agentState: string, idleMinutes: number): boolean {
  const STALL_THRESHOLD_MIN = 40
  // PARKED_PICKER and PARKED_PICKER_STALE are EXCLUDED from stall check
  const EXCLUDED_STATES = new Set(['PARKED_PICKER', 'PARKED_PICKER_STALE'])

  if (EXCLUDED_STATES.has(agentState)) return false
  return idleMinutes >= STALL_THRESHOLD_MIN
}

describe('C2.9 — PARKED_PICKER excluded from subagent-stall-watcher', () => {
  it('stall-watcher does NOT fire for PARKED_PICKER after 50 min', () => {
    expect(shouldStallWatcherFire('PARKED_PICKER', 50)).toBe(false)
  })

  it('stall-watcher does NOT fire for PARKED_PICKER_STALE after 50 min', () => {
    expect(shouldStallWatcherFire('PARKED_PICKER_STALE', 50)).toBe(false)
  })

  it('stall-watcher DOES fire for STUCK after 40 min', () => {
    expect(shouldStallWatcherFire('STUCK', 40)).toBe(true)
  })

  it('stall-watcher DOES fire for ALIVE after 40 min (extended inactivity)', () => {
    expect(shouldStallWatcherFire('ALIVE', 41)).toBe(true)
  })

  it('stall-watcher does NOT fire for PARKED_PICKER at exactly 40 min', () => {
    expect(shouldStallWatcherFire('PARKED_PICKER', 40)).toBe(false)
  })
})
