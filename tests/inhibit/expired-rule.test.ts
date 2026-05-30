/**
 * C1.6 — Rule with expires_at in past → no inhibition + stderr warning lists expired rule
 */
import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.6 — Expired rule is skipped', () => {
  it('does not inhibit when rule expires_at is in the past', () => {
    const stderrLines: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr as any).write = (data: string | Buffer) => {
      stderrLines.push(typeof data === 'string' ? data : data.toString())
      return true
    }

    let result
    try {
      const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

      const rules: InhibitRule[] = [{
        id: 'expired-session-dead-rule',
        source_match: { state: 'SESSION_DEAD' },
        target_match: { state: 'STUCK' },
        equal_labels: ['session'],
        expires_at: '2020-01-01T00:00:00Z', // far in the past
      }]

      const alerts: AlertLabel[] = [
        { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
        { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      ]

      result = engine.applyInhibition(alerts, rules)
    } finally {
      ;(process.stderr as any).write = origWrite
    }

    // No inhibition because rule is expired
    expect(result!.suppressed.length).toBe(0)
    expect(result!.survivors.length).toBe(2)

    // stderr should contain a warning about the expired rule
    const hasExpiredWarning = stderrLines.some(l =>
      l.includes('expired-session-dead-rule') && (l.includes('expired') || l.includes('WARN'))
    )
    expect(hasExpiredWarning).toBe(true)
  })

  it('applies non-expired rules normally when mixed with expired rules', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    // Future date for non-expired rule
    const futureDate = new Date(Date.now() + 86400000).toISOString()

    const rules: InhibitRule[] = [
      {
        id: 'expired-rule',
        source_match: { state: 'CRASHED' },
        target_match: { state: 'STUCK' },
        equal_labels: ['agent'],
        expires_at: '2020-01-01T00:00:00Z',
      },
      {
        id: 'active-rule',
        source_match: { state: 'SESSION_DEAD' },
        target_match: { state: 'STUCK' },
        equal_labels: ['session'],
        expires_at: futureDate,
      },
    ]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    const result = engine.applyInhibition(alerts, rules)

    // active-rule fires; STUCK is suppressed
    expect(result.suppressed.length).toBe(1)
    expect(result.suppressed[0].state).toBe('STUCK')
  })
})
