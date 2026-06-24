/**
 * C1.2 — TDD test (written BEFORE implementation per C0.5 discipline)
 *
 * 3 agents STUCK/PICKER_PARK within 10s → after group_wait_sec=30s,
 * ONE grouped Telegram is sent listing all 3.
 */

import { describe, it, expect } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'

describe('C1.2 — three agents grouped into one message', () => {
  it('emits one grouped message for 3 agents after group_wait_sec', () => {
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
    })

    const t0 = 1000
    // Three agents all stuck within 10s
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 3)
    engine.ingest({ agent: 'sadie', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 9)

    // Before group_wait: no flush
    const earlyFlush = engine.tick(t0 + 20)
    expect(earlyFlush.length).toBe(0)

    // After group_wait_sec=30: flush
    const messages = engine.tick(t0 + 31)
    expect(messages.length).toBe(1)
    expect(messages[0].agents).toHaveLength(3)
    expect(messages[0].agents).toContain('boss')
    expect(messages[0].agents).toContain('steve')
    expect(messages[0].agents).toContain('sadie')
    expect(messages[0].state).toBe('STUCK')
    expect(messages[0].reason_class).toBe('PICKER_PARK')
  })
})
