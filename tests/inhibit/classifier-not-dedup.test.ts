/**
 * C1.8 — Source classifier-true but dedupped by item-1 → targets STILL inhibited
 * (INHIBIT stage uses classifier output, not dedup output, as source truth)
 */
import { describe, it, expect } from 'bun:test'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.8 — Inhibition uses classifier output (before dedup) as source truth', () => {
  it('still inhibits targets when source alert is a duplicate (dedup would remove it)', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    // Two identical SESSION_DEAD alerts (dedup would collapse to 1)
    // But INHIBIT must see both to know the source condition exists
    const classifierOutput: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' }, // duplicate
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // INHIBIT runs on classifier output (not deduped)
    const result = engine.applyInhibition(classifierOutput, rules)

    // STUCK should still be suppressed even though SOURCE is "duplicate"
    expect(result.suppressed.length).toBe(1)
    expect(result.suppressed[0].state).toBe('STUCK')

    // Both SESSION_DEADs survive (they are sources, not targets for this rule)
    expect(result.survivors.length).toBe(2)
    expect(result.survivors.every(a => a.state === 'SESSION_DEAD')).toBe(true)
  })

  it('dedup after inhibit correctly collapses surviving duplicates', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const classifierOutput: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // Stage 2: INHIBIT
    const inhibited = engine.applyInhibition(classifierOutput, rules)
    expect(inhibited.survivors.length).toBe(2) // both SESSION_DEADs

    // Stage 3: DEDUP (deduplication runs after inhibit)
    const deduped = engine.deduplicate(inhibited.survivors)
    expect(deduped.length).toBe(1) // collapsed to 1 SESSION_DEAD
    expect(deduped[0].state).toBe('SESSION_DEAD')
  })
})
