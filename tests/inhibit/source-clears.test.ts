/**
 * C1.9 — Source clears next tick → targets emit normally next tick
 */
import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.9 — Source clears → targets emit normally on next tick', () => {
  it('suppresses targets while source is present, releases them when source clears', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    // Tick 1: SOURCE present — STUCK is suppressed
    const tick1Alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]
    const result1 = engine.applyInhibition(tick1Alerts, rules)
    expect(result1.suppressed.length).toBe(1)
    expect(result1.suppressed[0].state).toBe('STUCK')

    // Tick 2: SOURCE cleared — STUCK emits normally
    const tick2Alerts: AlertLabel[] = [
      // SESSION_DEAD is gone (session recovered)
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]
    const result2 = engine.applyInhibition(tick2Alerts, rules)
    expect(result2.suppressed.length).toBe(0)
    expect(result2.survivors.length).toBe(1)
    expect(result2.survivors[0].state).toBe('STUCK')
  })

  it('resets rule active-tick counter when source clears', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const activeAlerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // Run 3 ticks with source
    for (let i = 0; i < 3; i++) {
      engine.applyInhibition(activeAlerts, rules)
    }
    expect(engine.getRuleActiveTicks('session-dead-inhibits-stuck')).toBe(3)

    // Source clears — counter resets
    const clearedAlerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]
    engine.applyInhibition(clearedAlerts, rules)
    expect(engine.getRuleActiveTicks('session-dead-inhibits-stuck')).toBe(0)
  })
})
