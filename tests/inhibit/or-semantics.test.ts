/**
 * C1.5 — Two distinct rules apply to same target → suppressed (OR semantics)
 */
import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.5 — OR semantics: two rules can suppress same target', () => {
  it('suppresses target when either of two matching rules fires', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [
      {
        id: 'rule-1-session-dead-inhibits-stuck',
        source_match: { state: 'SESSION_DEAD' },
        target_match: { state: 'STUCK' },
        equal_labels: ['session'],
      },
      {
        id: 'rule-2-crashed-inhibits-stuck',
        source_match: { state: 'CRASHED' },
        target_match: { state: 'STUCK' },
        equal_labels: ['agent'],
      },
    ]

    // Both SESSION_DEAD and CRASHED are present — target STUCK should be suppressed by either rule
    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'CRASHED', reason_class: 'PROCESS_DIED', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    const result = engine.applyInhibition(alerts, rules)

    // STUCK should be suppressed (by one of the two rules)
    expect(result.suppressed.length).toBe(1)
    expect(result.suppressed[0].state).toBe('STUCK')
    // SESSION_DEAD and CRASHED survive
    expect(result.survivors.length).toBe(2)
  })

  it('suppresses target when only one of two rules matches', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [
      {
        id: 'rule-1-session-dead-inhibits-stuck',
        source_match: { state: 'SESSION_DEAD' },
        target_match: { state: 'STUCK' },
        equal_labels: ['session'],
      },
      {
        id: 'rule-2-crashed-inhibits-stuck',
        source_match: { state: 'CRASHED' },
        target_match: { state: 'STUCK' },
        equal_labels: ['agent'],
      },
    ]

    // Only SESSION_DEAD present (no CRASHED) — STUCK still suppressed by rule-1
    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    const result = engine.applyInhibition(alerts, rules)
    expect(result.suppressed.length).toBe(1)
    expect(result.suppressed[0].state).toBe('STUCK')
  })
})
