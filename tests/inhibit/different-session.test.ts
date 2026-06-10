/**
 * C1.2 — STUCK in different session (alive) is NOT inhibited
 */
import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.2 — STUCK in different session is NOT inhibited', () => {
  it('does not suppress STUCK alert from different session', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const alerts: AlertLabel[] = [
      // SESSION_DEAD for claude-boss
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      // STUCK for claude-boss (same session — SHOULD be suppressed)
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      // STUCK for claude-steve (different session — should NOT be suppressed)
      { agent: 'steve', session: 'claude-steve', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    const result = engine.applyInhibition(alerts, rules)

    // SESSION_DEAD survives, boss STUCK suppressed, steve STUCK survives
    expect(result.survivors.length).toBe(2)
    const survivorStates = result.survivors.map(a => `${a.agent}:${a.state}`)
    expect(survivorStates).toContain('boss:SESSION_DEAD')
    expect(survivorStates).toContain('steve:STUCK')

    // Only boss STUCK is suppressed
    expect(result.suppressed.length).toBe(1)
    expect(result.suppressed[0].agent).toBe('boss')
    expect(result.suppressed[0].state).toBe('STUCK')
  })
})
