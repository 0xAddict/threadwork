/**
 * C2.6 — STALE fires once per entry; re-fires only after non-PARKED tick + new full TTL
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.6 — STALE one-shot, re-fires after non-PARKED tick + new TTL', () => {
  let tmpDir: string
  let sigPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'picker-stale-oneshot-'))
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

  it('STALE fires once; subsequent ticks return PARKED_PICKER not STALE again', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
      staleTtlSec: 10,
    })

    const paneContent = `Allow Claude to use Bash?
❯ Yes
  No`

    // Initial detection
    const t0 = new Date(Date.now() - 12000).toISOString()
    classifier.classify('boss', paneContent, t0)

    // First stale tick — should be STALE
    const t1 = new Date().toISOString()
    const result1 = classifier.classify('boss', paneContent, t1)
    expect(result1.state).toBe('PARKED_PICKER_STALE')

    // Second stale tick — should be PARKED_PICKER (not STALE again)
    const t2 = new Date(Date.now() + 1000).toISOString()
    const result2 = classifier.classify('boss', paneContent, t2)
    expect(result2.state).toBe('PARKED_PICKER')
  })

  it('STALE re-fires after non-PARKED tick clears the state + new full TTL', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
      staleTtlSec: 10,
    })

    const paneContent = `Allow Claude to use Bash?
❯ Yes
  No`

    // Initial detection
    const t0 = new Date(Date.now() - 12000).toISOString()
    classifier.classify('boss', paneContent, t0)

    // STALE fires
    const t1 = new Date().toISOString()
    const result1 = classifier.classify('boss', paneContent, t1)
    expect(result1.state).toBe('PARKED_PICKER_STALE')

    // Non-PARKED tick — picker resolved
    classifier.clearAgentState('boss')

    // New picker appears (short TTL + immediate detect)
    const t2 = new Date(Date.now() - 12000).toISOString()
    classifier.classify('boss', paneContent, t2)

    // Stale again after new full TTL
    const t3 = new Date().toISOString()
    const result3 = classifier.classify('boss', paneContent, t3)
    expect(result3.state).toBe('PARKED_PICKER_STALE')
  })
})
