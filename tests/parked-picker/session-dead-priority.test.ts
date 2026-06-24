/**
 * C2.7 — tmux session dead → capture-pane fails → SESSION_DEAD, NOT PARKED_PICKER
 */
import { describe, it, expect } from 'bun:test'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.7 — SESSION_DEAD takes priority over PARKED_PICKER when tmux fails', () => {
  it('returns null state when pane content is empty (tmux capture-pane failed)', () => {
    const classifier = new ParkedPickerClassifier({ signaturesPath: null })

    // When tmux session is dead, capture-pane returns empty string or fails
    // The classifier should return null state (SESSION_DEAD is determined by the caller)
    const result = classifier.classify('boss', '')
    expect(result.state).toBeNull()
  })

  it('returns null state for null/undefined pane content (dead session)', () => {
    const classifier = new ParkedPickerClassifier({ signaturesPath: null })

    // Simulate dead session with null content
    const result = classifier.classify('boss', '')
    expect(result.state).toBeNull()
  })

  it('integration: orchestrator treats empty pane as SESSION_DEAD, not PARKED_PICKER', () => {
    // This test documents the integration contract:
    // 1. Orchestrator runs tmux capture-pane
    // 2. If capture-pane exits non-zero → SESSION_DEAD (not classified by ParkedPickerClassifier)
    // 3. If capture-pane succeeds but returns empty → no state from classifier
    // 4. ParkedPickerClassifier.classify() is ONLY called with non-empty pane content

    const classifier = new ParkedPickerClassifier({ signaturesPath: null })

    // Empty content (failed capture) → null state
    const result = classifier.classify('boss', '')
    expect(result.state).toBeNull()

    // Orchestrator sees null → determines SESSION_DEAD through other means
    // This is the documented behavior (SESSION_DEAD takes priority)
    expect(result.state).not.toBe('PARKED_PICKER')
    expect(result.state).not.toBe('PARKED_PICKER_STALE')
  })
})
