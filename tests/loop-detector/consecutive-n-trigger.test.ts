/**
 * C2.2 — Consecutive-N trigger: 6 consecutive identical hashes → tick 6 classifies LOOP
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.2 — Consecutive-N trigger', () => {
  it('classifies LOOP on 6th consecutive identical hash', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-n-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
    })

    const agent = 'steve'
    const t0 = 1000000
    const input = {
      classifierState: 'STUCK' as const,
      status_text: 'doing thing',
      tool_call_signature: 'abc123',
      pane_bottom_line: 'same line',
    }

    let result
    for (let i = 0; i < 5; i++) {
      result = detector.tick(agent, input, t0 + i * 60)
      expect(result.is_loop).toBe(false)
    }

    // 6th tick → LOOP
    result = detector.tick(agent, input, t0 + 5 * 60)
    expect(result.is_loop).toBe(true)
    expect(result.skipped).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
