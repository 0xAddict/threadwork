/**
 * C2.5 — PARKED_PICKER for 3601s → next tick returns PARKED_PICKER_STALE with full payload
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.5 — PARKED_PICKER_STALE after TTL', () => {
  let tmpDir: string
  let sigPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'picker-stale-'))
    sigPath = join(tmpDir, 'picker-signatures.json')
    writeFileSync(sigPath, JSON.stringify({
      version: '1.0.0',
      updated: '2026-05-27',
      signatures: [{
        id: 'tool-permission-bash',
        picker_subtype: 'tool_permission_prompt',
        patterns: ['Allow Claude to use Bash?'],
      }]
    }))
  })

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('transitions to PARKED_PICKER_STALE after TTL seconds', () => {
    // Use short TTL for testing (10s instead of 3601s)
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
      staleTtlSec: 10,
    })

    const paneContent = `Allow Claude to use Bash?
❯ Yes
  No`

    // Tick 1: first detection, not yet stale
    const t1 = new Date(Date.now() - 11000).toISOString() // 11 seconds ago
    // Simulate: agent was first detected 11 seconds ago
    // We do this by calling classify at t1 to set state_entered_at
    const initialNow = new Date(Date.now() - 11000).toISOString()
    const result1 = classifier.classify('boss', paneContent, initialNow)
    expect(result1.state).toBe('PARKED_PICKER')

    // Tick 2: 11s later — should be STALE
    const laterNow = new Date().toISOString()
    const result2 = classifier.classify('boss', paneContent, laterNow)
    expect(result2.state).toBe('PARKED_PICKER_STALE')
    expect(result2.picker_subtype).toBe('tool_permission_prompt')
    expect(result2.state_entered_at).toBe(result1.state_entered_at) // same entry time
    expect(result2.agent).toBe('boss')
  })
})
