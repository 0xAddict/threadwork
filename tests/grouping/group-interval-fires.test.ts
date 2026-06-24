/**
 * C1.5 — Group active, new agent joins after group_interval_sec elapsed since last flush
 * → flushes immediately on next tick
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.5 — new member after group_interval fires immediately', () => {
  it('flushes immediately when new member joins after group_interval_sec elapsed', () => {
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

    // group_interval elapsed (300s), then new member arrives
    const tNew = t0 + 31 + 305  // 305s after first flush = after group_interval
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, tNew)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, tNew)

    // Next tick: should flush immediately (group_interval elapsed AND new member)
    const second = engine.tick(tNew + 1)
    expect(second.length).toBe(1)
    expect(second[0].agents).toContain('steve')
  })
})
