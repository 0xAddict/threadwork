/**
 * C2.1 — Pane "Allow Claude to use Bash?" with active prompt → PARKED_PICKER, subtype=tool_permission_prompt
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.1 — Tool permission prompt → PARKED_PICKER', () => {
  let tmpDir: string
  let sigPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'picker-test-'))
    sigPath = join(tmpDir, 'picker-signatures.json')
    writeFileSync(sigPath, JSON.stringify({
      version: '1.0.0',
      updated: '2026-05-27',
      signatures: [{
        id: 'tool-permission-bash',
        picker_subtype: 'tool_permission_prompt',
        patterns: ['Allow Claude to use Bash?', 'Allow Claude to use bash?'],
      }]
    }))
  })

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('classifies "Allow Claude to use Bash?" with active prompt as PARKED_PICKER tool_permission_prompt', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
    })

    // Pane content with active prompt at bottom
    const paneContent = `
Some earlier output...
Running analysis...
╔══════════════════════════════════════════╗
│ Allow Claude to use Bash?                 │
│ ❯ Yes                                    │
│   No                                     │
╚══════════════════════════════════════════╝
❯`

    const result = classifier.classify('boss', paneContent)

    expect(result.state).toBe('PARKED_PICKER')
    expect(result.picker_subtype).toBe('tool_permission_prompt')
    expect(result.agent).toBe('boss')
    expect(result.state_entered_at).not.toBeNull()
  })
})
