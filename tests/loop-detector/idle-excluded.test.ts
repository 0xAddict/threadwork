/**
 * C2.4 — IDLE exclusion: 6 identical hashes while classifier state == IDLE → NO LOOP classification
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.4 — IDLE exclusion', () => {
  it('does not classify LOOP when agent state is IDLE, even with 6 identical hashes', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-idle-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
    })

    const agent = 'kiera'
    const t0 = 3000000
    const input = {
      classifierState: 'IDLE' as const,
      status_text: 'idle status',
      tool_call_signature: 'same-sig',
      pane_bottom_line: 'same pane',
    }

    let result
    for (let i = 0; i < 8; i++) {
      result = detector.tick(agent, input, t0 + i * 60)
      expect(result.is_loop).toBe(false)
      expect(result.skipped).toBe(true)  // IDLE is skipped
    }

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
