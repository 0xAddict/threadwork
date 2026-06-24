/**
 * C2.12 — Empty sentinel: empty status_text AND null tool_call_signature → recorded as "EMPTY";
 * 6 consecutive EMPTYs → LOOP
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.12 — Empty sentinel', () => {
  it('records "EMPTY" for empty status + null tool_call_signature', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-empty-'))
    const histPath = join(tmpDir, 'loop-detector.json')
    const detector = new LoopDetector({ historyPath: histPath, consecutiveN: 6 })

    const agent = 'steve'
    const t0 = 10000000
    const emptyInput = {
      classifierState: 'STUCK' as const,
      status_text: '',
      tool_call_signature: null,
      pane_bottom_line: 'some pane',
    }

    const result = detector.tick(agent, emptyInput, t0)
    expect(result.hash).toBe('EMPTY')
    expect(result.is_loop).toBe(false)
  })

  it('classifies LOOP on 6 consecutive EMPTY entries', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-empty-loop-'))
    const detector = new LoopDetector({ historyPath: join(tmpDir, 'loop-detector.json'), consecutiveN: 6 })

    const agent = 'boss'
    const t0 = 11000000
    const emptyInput = {
      classifierState: 'STUCK' as const,
      status_text: '',
      tool_call_signature: null,
      pane_bottom_line: '',
    }

    let result
    for (let i = 0; i < 5; i++) {
      result = detector.tick(agent, emptyInput, t0 + i * 60)
      expect(result.hash).toBe('EMPTY')
      expect(result.is_loop).toBe(false)
    }

    result = detector.tick(agent, emptyInput, t0 + 5 * 60)
    expect(result.hash).toBe('EMPTY')
    expect(result.is_loop).toBe(true)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
