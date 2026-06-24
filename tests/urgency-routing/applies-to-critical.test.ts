/**
 * C3.8 — Inhibit rule SESSION_DEAD→STUCK without applies_to_critical → CRITICAL STUCK NOT inhibited;
 * same rule with applies_to_critical:true → CRITICAL STUCK IS inhibited
 */

import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C3.8 — applies_to_critical inhibit flag', () => {
  it('CRITICAL STUCK is NOT inhibited without applies_to_critical', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
      // applies_to_critical NOT set (default false)
    }]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      // CRITICAL STUCK alert (severity=CRITICAL)
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook', severity: 'CRITICAL' },
    ]

    const result = engine.applyInhibition(alerts, rules)

    // CRITICAL STUCK should NOT be suppressed
    expect(result.survivors.some(a => a.state === 'STUCK')).toBe(true)
    expect(result.suppressed.filter(a => a.state === 'STUCK').length).toBe(0)
  })

  it('CRITICAL STUCK IS inhibited when applies_to_critical:true', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck-critical',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
      applies_to_critical: true,  // explicitly enabled for CRITICAL
    }]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook', severity: 'CRITICAL' },
    ]

    const result = engine.applyInhibition(alerts, rules)

    // CRITICAL STUCK SHOULD be suppressed (rule has applies_to_critical:true)
    expect(result.suppressed.some(a => a.state === 'STUCK')).toBe(true)
    expect(result.survivors.filter(a => a.state === 'STUCK').length).toBe(0)
  })

  it('non-critical STUCK alerts are still inhibited by normal rules', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
      // no applies_to_critical
    }]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      // WARNING STUCK (no severity field)
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    const result = engine.applyInhibition(alerts, rules)

    // Non-critical STUCK SHOULD be suppressed (normal behavior preserved)
    expect(result.suppressed.some(a => a.state === 'STUCK')).toBe(true)
  })
})
