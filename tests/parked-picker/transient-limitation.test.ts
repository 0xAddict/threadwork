/**
 * C2.12 — Transient picker (resolves before next tick) → not detected (documented limitation)
 *
 * If a picker appears and resolves between two classifier ticks, it will not be detected.
 * This is a known limitation of the tick-based polling approach.
 * This test documents the limitation and verifies the behavior.
 */
import { describe, it, expect } from 'bun:test'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.12 — Transient picker is not detected (documented limitation)', () => {
  it('picker that resolves before next tick is not seen (documented limitation)', () => {
    const classifier = new ParkedPickerClassifier({ signaturesPath: null })

    // Tick 1: No picker (agent is working normally)
    const tick1Content = `Working on task...
Running bun test...
All tests pass.
> `  // Regular output, no picker

    const result1 = classifier.classify('boss', tick1Content)
    expect(result1.state).toBeNull()

    // BETWEEN TICKS: A picker appeared and was resolved by the operator
    // (We cannot observe this in the tick-based model)
    // Tick 2: Picker already resolved, agent is working again
    const tick2Content = `Permission granted. Continuing...
Running more commands...
> `

    const result2 = classifier.classify('boss', tick2Content)
    expect(result2.state).toBeNull()

    // DOCUMENTED LIMITATION:
    // The transient picker between tick1 and tick2 was never detected.
    // This is acceptable behavior because:
    // 1. The operator resolved it (so no action was needed from the monitoring system)
    // 2. The tick interval (300s default) is chosen to balance latency vs. polling cost
    // 3. Transient pickers that are quickly resolved don't need alerting anyway
    //
    // If the picker is NOT resolved, it WILL be detected on the next tick.
  })

  it('picker that persists beyond one tick IS detected', () => {
    const classifier = new ParkedPickerClassifier({ signaturesPath: null })

    // Tick 1: No picker
    classifier.classify('boss', 'Working normally...\n> ')

    // Tick 2: Picker appeared and is still present
    const pickerContent = `Some output...
Allow Claude to use Bash?
❯ Yes
  No`

    const result = classifier.classify('boss', pickerContent)
    expect(result.state).toBe('PARKED_PICKER')
  })
})
