/**
 * C1.4 — Group active, no new members for repeat_interval_sec → group re-notifies once at boundary
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.4 — repeat interval fires when no new members', () => {
  it('re-notifies at repeat_interval_sec boundary with no new members', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000

    // Ingest agents
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 5)

    // First flush after group_wait
    const firstFlush = engine.tick(t0 + 31)
    expect(firstFlush.length).toBe(1)

    // No new members — repeat_interval not yet elapsed: no flush
    const mid = engine.tick(t0 + 31 + 900)  // 900s after first flush
    expect(mid.length).toBe(0)

    // Still active members (re-ingest to keep them active)
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 1800)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 31 + 1800)

    // At repeat_interval boundary
    const repeatFlush = engine.tick(t0 + 31 + 1800 + 1)
    expect(repeatFlush.length).toBe(1)
    expect(repeatFlush[0].agents).toHaveLength(2)
  })
})
