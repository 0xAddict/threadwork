/**
 * C1.11 — Two distinct group keys (different reason_class) → each is its own
 * independent group with independent timing
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.11 — distinct group keys are independent', () => {
  it('two different reason_classes create independent groups', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'IDLE_TIMEOUT', severity: 'WARNING' }, t0 + 2)

    // Before group_wait: no flush
    const early = engine.tick(t0 + 15)
    expect(early.length).toBe(0)

    // After group_wait: both flush independently (t0+2 + 30 = t0+32, so tick at t0+33)
    const msgs = engine.tick(t0 + 33)
    expect(msgs.length).toBe(2)

    const keys = msgs.map(m => m.reason_class)
    expect(keys).toContain('PICKER_PARK')
    expect(keys).toContain('IDLE_TIMEOUT')

    // Each group has 1 member
    const pp = msgs.find(m => m.reason_class === 'PICKER_PARK')!
    const it_ = msgs.find(m => m.reason_class === 'IDLE_TIMEOUT')!
    expect(pp.agents).toHaveLength(1)
    expect(it_.agents).toHaveLength(1)
  })
})
