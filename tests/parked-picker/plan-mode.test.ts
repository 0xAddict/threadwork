/**
 * C2.3 — Plan-mode-confirm screen → PARKED_PICKER, subtype=plan_mode_confirm
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.3 — Plan mode confirm → PARKED_PICKER plan_mode_confirm', () => {
  let tmpDir: string
  let sigPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'picker-plan-'))
    sigPath = join(tmpDir, 'picker-signatures.json')
    writeFileSync(sigPath, JSON.stringify({
      version: '1.0.0',
      updated: '2026-05-27',
      signatures: [{
        id: 'plan-mode-confirm',
        picker_subtype: 'plan_mode_confirm',
        patterns: ['Execute the plan?', 'Approve plan', 'Plan mode enabled'],
      }]
    }))
  })

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('classifies plan-mode confirm screen as PARKED_PICKER plan_mode_confirm', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
    })

    const paneContent = `
Plan mode enabled. Reviewing plan...
Step 1: Edit files
Step 2: Run tests
Step 3: Commit

Execute the plan?
❯ Yes
  No, abort`

    const result = classifier.classify('steve', paneContent)

    expect(result.state).toBe('PARKED_PICKER')
    expect(result.picker_subtype).toBe('plan_mode_confirm')
    expect(result.agent).toBe('steve')
  })
})
