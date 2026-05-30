/**
 * C1.7 — Rule active 12 consecutive ticks → meta-message emitted with cumulative suppressed count + rule_id
 */
import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.7 — Stale-inhibition meta-alert after 12 consecutive ticks', () => {
  it('emits meta-alert at tick 12 with cumulative suppressed count and rule_id', () => {
    const metaAlerts: Array<{ msg: string; ruleId: string; count: number }> = []

    const engine = new InhibitionEngine({
      rulesPath: null,
      inhibitLogPath: null,
      metaAlertCallback: (msg, ruleId, count) => {
        metaAlerts.push({ msg, ruleId, count })
      },
      staleTickThreshold: 12,
    })

    const rules: InhibitRule[] = [{
      id: 'persistent-session-dead',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // Run 11 ticks — no meta-alert yet
    for (let i = 0; i < 11; i++) {
      engine.applyInhibition(alerts, rules)
    }
    expect(metaAlerts.length).toBe(0)

    // Tick 12 — meta-alert fires
    engine.applyInhibition(alerts, rules)
    expect(metaAlerts.length).toBe(1)

    const alert = metaAlerts[0]
    expect(alert.ruleId).toBe('persistent-session-dead')
    expect(alert.count).toBeGreaterThan(0) // cumulative suppressed count
    expect(alert.msg).toContain('persistent-session-dead') // rule_id in message
  })

  it('fires meta-alert again at tick 24 (every staleTickThreshold ticks)', () => {
    const metaAlerts: Array<{ msg: string; ruleId: string; count: number }> = []

    const engine = new InhibitionEngine({
      rulesPath: null,
      inhibitLogPath: null,
      metaAlertCallback: (msg, ruleId, count) => {
        metaAlerts.push({ msg, ruleId, count })
      },
      staleTickThreshold: 12,
    })

    const rules: InhibitRule[] = [{
      id: 'persistent-session-dead',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // Run 24 ticks
    for (let i = 0; i < 24; i++) {
      engine.applyInhibition(alerts, rules)
    }

    // Should have fired at tick 12 and tick 24
    expect(metaAlerts.length).toBe(2)

    // Second meta-alert should show higher cumulative count
    expect(metaAlerts[1].count).toBeGreaterThan(metaAlerts[0].count)
  })
})
