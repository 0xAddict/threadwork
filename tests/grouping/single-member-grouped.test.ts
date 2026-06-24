/**
 * C1.3 — Single agent STUCK alone → after group_wait_sec, one grouped message
 * with N=1 is sent (single-member must still use grouped-format)
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.3 — single agent grouped message', () => {
  it('emits one grouped message with N=1 after group_wait_sec', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT', severity: 'WARNING' }, t0)

    // Before group_wait: no flush
    const early = engine.tick(t0 + 15)
    expect(early.length).toBe(0)

    // After group_wait: flush
    const msgs = engine.tick(t0 + 31)
    expect(msgs.length).toBe(1)
    expect(msgs[0].agents).toHaveLength(1)
    expect(msgs[0].agents).toContain('boss')
    // Must use grouped format
    expect(msgs[0].message).toContain('[grouped alert]')
    expect(msgs[0].message).toContain('N=1')
  })
})
