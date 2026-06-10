/**
 * C1.10 — Missing 'session' label on candidate target → equal=[session] rule does NOT inhibit
 */
import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.10 — Missing equal-label on target prevents inhibition', () => {
  it('does not inhibit target missing the session equal_label', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    // Target is missing the 'session' label (or has empty string)
    // The engine should NOT inhibit it (per C1.10 / DoD §10)
    const targetWithoutSession: any = {
      agent: 'boss',
      state: 'STUCK',
      reason_class: 'TASK_OVERDUE',
      host: 'macbook',
      // session is intentionally absent
    }

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      targetWithoutSession,
    ]

    const result = engine.applyInhibition(alerts, rules)

    // Target lacking 'session' label should NOT be inhibited
    expect(result.suppressed.length).toBe(0)
    expect(result.survivors.length).toBe(2)
  })

  it('does not inhibit target with empty session label', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      // Target has empty session — should not match
      { agent: 'boss', session: '', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // The source has session='claude-boss', target has session='' — not equal, no inhibition
    const result = engine.applyInhibition(alerts, rules)
    expect(result.suppressed.length).toBe(0)
  })
})
