/**
 * C2.5 — PARKED_PICKER exclusion: agent in PARKED_PICKER → loop detector SKIPPED entirely
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.5 — PARKED_PICKER exclusion', () => {
  it('skips loop detection when agent is PARKED_PICKER', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-parked-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
    })

    const agent = 'sadie'
    const t0 = 4000000
    const input = { classifierState: 'PARKED_PICKER' as const, status_text: 'same', tool_call_signature: 'same', pane_bottom_line: 'same' }

    for (let i = 0; i < 10; i++) {
      const result = detector.tick(agent, input, t0 + i * 60)
      expect(result.is_loop).toBe(false)
      expect(result.skipped).toBe(true)
    }

    // Also test PARKED_PICKER_STALE
    const inputStale = { classifierState: 'PARKED_PICKER_STALE' as const, status_text: 'same', tool_call_signature: 'same', pane_bottom_line: 'same' }
    const result = detector.tick(agent, inputStale, t0 + 1000)
    expect(result.is_loop).toBe(false)
    expect(result.skipped).toBe(true)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
