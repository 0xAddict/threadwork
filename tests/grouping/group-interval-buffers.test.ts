/**
 * C1.6 — Group active, new agent joins BEFORE group_interval_sec elapsed
 * → addition buffered; flushes at group_interval boundary
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.6 — new member before group_interval is buffered', () => {
  it('buffers new member and flushes at group_interval boundary', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)

    // First flush at t0 + 31
    const first = engine.tick(t0 + 31)
    expect(first.length).toBe(1)

    // New member joins at t0 + 31 + 100 (only 100s after last flush, < group_interval=300)
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 100)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 100)

    // Tick at t0+31+150: still within group_interval → buffered, no flush
    const mid = engine.tick(t0 + 31 + 150)
    expect(mid.length).toBe(0)

    // Keep members active
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 299)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 299)

    // Tick at t0+31+300+1: group_interval elapsed → flush
    const second = engine.tick(t0 + 31 + 301)
    expect(second.length).toBe(1)
    expect(second[0].agents).toContain('steve')
  })
})
