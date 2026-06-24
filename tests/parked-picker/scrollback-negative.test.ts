/**
 * C2.2 — Same string in scrollback (no active prompt) → NOT PARKED_PICKER
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.2 — Scrollback-only match is NOT PARKED_PICKER', () => {
  let tmpDir: string
  let sigPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'picker-scrollback-'))
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

  it('does not classify as PARKED_PICKER when picker string is in scrollback only', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
    })

    // Picker string is in scrollback but NOT in last 5 lines
    // Last 5 lines show the agent is actively running
    const paneContent = `
Allow Claude to use Bash?
Yes

The tool permission was granted. Now running bash commands...
Executing: ls -la
total 24
drwxr-xr-x  5 user staff  160 May 27 08:00 .
Running more commands...
> `  // Active bash prompt — NOT a picker

    const result = classifier.classify('boss', paneContent)

    expect(result.state).toBeNull()
  })

  it('returns null state when pane shows regular bash prompt (not picker)', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: join(tmpDir, 'picker-others.log'),
    })

    const paneContent = `
Last login: Mon May 27 08:00:00 on ttys001
coachstokes@macbook ~ % `

    const result = classifier.classify('boss', paneContent)
    expect(result.state).toBeNull()
  })
})
