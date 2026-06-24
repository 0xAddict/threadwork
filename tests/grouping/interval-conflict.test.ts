/**
 * C1.12 — group_interval vs repeat_interval conflict:
 * group_interval=300, repeat_interval=1800, addition at t=305 → fires at 305
 * (group_interval wins because it fires earlier)
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.12 — earlier interval wins (group_interval vs repeat_interval)', () => {
  it('group_interval wins when addition arrives at t=305 (after group_interval=300)', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)

    // First flush
    const first = engine.tick(t0 + 31)
    expect(first.length).toBe(1)

    // New member arrives at t0+31+305 (305s after first flush, just past group_interval=300)
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 305)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 305)

    // Tick at t=305 — group_interval elapsed AND new member → fires immediately
    const second = engine.tick(t0 + 31 + 305 + 1)
    expect(second.length).toBe(1)
    expect(second[0].agents).toContain('steve')

    // The second flush should have happened well BEFORE repeat_interval (1800s)
    const timeSinceFirst = t0 + 31 + 305 + 1 - (t0 + 31)
    expect(timeSinceFirst).toBeLessThan(1800)
  })

  it('repeat_interval fires at 1800s with no new additions', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)

    // First flush
    const first = engine.tick(t0 + 31)
    expect(first.length).toBe(1)

    // No new members for a long time
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 1799)

    // Before repeat_interval: no flush
    const noFlush = engine.tick(t0 + 31 + 1799)
    expect(noFlush.length).toBe(0)

    // Keep boss active
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 1800)

    // At repeat_interval: flush
    const repeatFlush = engine.tick(t0 + 31 + 1801)
    expect(repeatFlush.length).toBe(1)
  })
})
