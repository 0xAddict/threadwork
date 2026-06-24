/**
 * C2.8 — Two PARKED_PICKER agents same tick → both info-level alerts (dedup/group respected)
 */
import { describe, it, expect } from 'bun:test'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'
import { InhibitionEngine, type AlertLabel } from '../../inhibit-engine'

describe('C2.8 — Two PARKED_PICKER agents on same tick', () => {
  it('both agents classified as PARKED_PICKER independently', () => {
    const classifier = new ParkedPickerClassifier({ signaturesPath: null })

    const paneContent = `Allow Claude to use Bash?
❯ Yes
  No`

    const resultBoss = classifier.classify('boss', paneContent)
    const resultSteve = classifier.classify('steve', paneContent)

    expect(resultBoss.state).toBe('PARKED_PICKER')
    expect(resultSteve.state).toBe('PARKED_PICKER')
    expect(resultBoss.agent).toBe('boss')
    expect(resultSteve.agent).toBe('steve')
  })

  it('two PARKED_PICKER alerts from different agents survive dedup (different fingerprints)', () => {
    const engine = new InhibitionEngine({ rulesPath: null, inhibitLogPath: null })

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'PARKED_PICKER', reason_class: 'PICKER_DETECTED', host: 'macbook', picker_subtype: 'tool_permission_prompt' },
      { agent: 'steve', session: 'claude-steve', state: 'PARKED_PICKER', reason_class: 'PICKER_DETECTED', host: 'macbook', picker_subtype: 'tool_permission_prompt' },
    ]

    // No rules to inhibit PARKED_PICKER
    const inhibited = engine.applyInhibition(alerts, [])
    expect(inhibited.survivors.length).toBe(2)

    // Both survive dedup (different agents → different fingerprints)
    const deduped = engine.deduplicate(inhibited.survivors)
    expect(deduped.length).toBe(2)

    // Grouped by agent|host — 2 groups
    const grouped = engine.group(deduped)
    expect(Object.keys(grouped).length).toBe(2)
  })
})
