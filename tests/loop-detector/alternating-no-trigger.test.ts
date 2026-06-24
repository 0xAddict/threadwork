/**
 * C2.13 — Alternating non-trigger: A,B,A,B,A,B,A,B,A,B,A,B → neither consecutive-N
 * nor windowed-supermajority triggers.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.13 — Alternating non-trigger', () => {
  it('does not trigger LOOP on A,B,A,B,A,B,A,B,A,B,A,B pattern', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-alt-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
      windowSize: 12,
      majorityThreshold: 9,
    })

    const agent = 'kiera'
    const t0 = 12000000
    const inputA = { classifierState: 'STUCK' as const, status_text: 'A', tool_call_signature: 'sigA', pane_bottom_line: 'A' }
    const inputB = { classifierState: 'STUCK' as const, status_text: 'B', tool_call_signature: 'sigB', pane_bottom_line: 'B' }

    // 12 alternating A, B
    for (let i = 0; i < 12; i++) {
      const input = i % 2 === 0 ? inputA : inputB
      const result = detector.tick(agent, input, t0 + i * 60)
      expect(result.is_loop).toBe(false)
    }

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
