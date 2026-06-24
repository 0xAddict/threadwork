/**
 * C2.11 — Add new signature to picker-signatures.json → next tick recognises without restart
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.11 — picker-signatures.json hot-reload', () => {
  let tmpDir: string
  let sigPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'picker-sig-reload-'))
    sigPath = join(tmpDir, 'picker-signatures.json')
    // Start with empty signatures
    writeFileSync(sigPath, JSON.stringify({
      version: '1.0.0',
      updated: '2026-05-27',
      signatures: [],
    }))
  })

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('picks up new signature without restart', async () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
    })

    const paneContent = `
New Claude Code feature: Switch project?
❯ Yes, switch project
  No, stay here`

    // Tick 1: no matching signature → 'other' subtype
    const result1 = classifier.classify('boss', paneContent)
    expect(result1.picker_subtype).toBe('other')

    // Add new signature to picker-signatures.json
    await new Promise(r => setTimeout(r, 50)) // ensure different mtime

    writeFileSync(sigPath, JSON.stringify({
      version: '1.0.0',
      updated: '2026-05-27',
      signatures: [{
        id: 'switch-project',
        picker_subtype: 'tool_permission_prompt',
        patterns: ['Switch project?', 'Yes, switch project'],
      }]
    }))

    // Clear state so we get a fresh classification
    classifier.clearAgentState('boss')

    // Tick 2: new signature should be picked up → correct subtype
    const result2 = classifier.classify('boss', paneContent)
    expect(result2.picker_subtype).toBe('tool_permission_prompt')
    expect(result2.state).toBe('PARKED_PICKER')
  })
})
