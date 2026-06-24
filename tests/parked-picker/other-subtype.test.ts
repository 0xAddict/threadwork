/**
 * C2.4 — Unrecognized picker → PARKED_PICKER, subtype=other; entry appended to picker-others.log
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ParkedPickerClassifier } from '../../parked-picker-classifier'

describe('C2.4 — Unrecognized picker → PARKED_PICKER other + logged', () => {
  let tmpDir: string
  let sigPath: string
  let othersLogPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'picker-other-'))
    sigPath = join(tmpDir, 'picker-signatures.json')
    othersLogPath = join(tmpDir, 'picker-others.log')
    // Empty signatures — everything will be 'other'
    writeFileSync(sigPath, JSON.stringify({
      version: '1.0.0',
      updated: '2026-05-27',
      signatures: [],
    }))
  })

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('classifies unrecognized picker as PARKED_PICKER with subtype=other', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: othersLogPath,
    })

    // Pane with active prompt but no matching signature
    const paneContent = `
Some new Claude Code feature picker...
Do you want to switch projects?
❯ Yes, switch
  No, stay here`

    const result = classifier.classify('kiera', paneContent)

    expect(result.state).toBe('PARKED_PICKER')
    expect(result.picker_subtype).toBe('other')
  })

  it('appends unrecognized picker snippet to picker-others.log', () => {
    const classifier = new ParkedPickerClassifier({
      signaturesPath: sigPath,
      pickerOthersLogPath: othersLogPath,
    })

    const paneContent = `
New unknown picker UI here
Do you want to switch projects?
❯ Yes, switch
  No, stay here`

    classifier.classify('kiera', paneContent)

    // picker-others.log should exist and have an entry
    expect(existsSync(othersLogPath)).toBe(true)
    const logContents = readFileSync(othersLogPath, 'utf-8')
    expect(logContents).toContain('agent=kiera')
    expect(logContents).toContain('snippet=')
  })
})
