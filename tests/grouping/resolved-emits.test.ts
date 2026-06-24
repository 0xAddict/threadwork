/**
 * C1.7 — All members recover. After resolved_grace_sec of continuous non-STUCK,
 * RESOLVED summary emits.
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.7 — RESOLVED emits after resolved_grace_sec', () => {
  it('emits RESOLVED after all members recover for resolved_grace_sec', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 5)

    // First flush
    const first = engine.tick(t0 + 31)
    expect(first.length).toBe(1)

    // Both members recover at t0+40 (all become inactive)
    engine.markInactive('STUCK', 'PICKER_PARK', 'WARNING', 'boss', t0 + 40)
    engine.markInactive('STUCK', 'PICKER_PARK', 'WARNING', 'steve', t0 + 40)

    // Before resolved_grace: no RESOLVED
    const tooEarly = engine.tick(t0 + 40 + 30)
    expect(tooEarly.filter(m => m.is_resolved).length).toBe(0)

    // After resolved_grace_sec=60: RESOLVED emits
    const resolved = engine.tick(t0 + 40 + 61)
    const resolvedMsgs = resolved.filter(m => m.is_resolved)
    expect(resolvedMsgs.length).toBe(1)
    expect(resolvedMsgs[0].message).toContain('RESOLVED')
    expect(resolvedMsgs[0].message).toContain('2 agents')
  })
})
