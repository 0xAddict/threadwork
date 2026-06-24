/**
 * C1.8 — Flicker: members recover then re-fire within resolved_grace_sec
 * → group continues active; no RESOLVED+re-open spam
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.8 — flicker does not cause RESOLVED+re-open spam', () => {
  it('continues active group when member re-fires within resolved_grace_sec', () => {
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

    // Boss recovers at t0+40
    engine.markInactive('STUCK', 'PICKER_PARK', 'WARNING', 'boss', t0 + 40)

    // Boss re-fires at t0+40+30 (within resolved_grace=60)
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 40 + 30)

    // Tick at t0+40+61: would have been RESOLVED if not for re-fire
    const noResolved = engine.tick(t0 + 40 + 61)
    const resolvedMsgs = noResolved.filter(m => m.is_resolved)
    // Should NOT have RESOLVED since boss re-fired
    expect(resolvedMsgs.length).toBe(0)

    // Group should still be active
    const group = engine.getGroup('STUCK', 'PICKER_PARK', 'WARNING')
    expect(group).toBeDefined()
  })
})
