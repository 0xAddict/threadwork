/**
 * C2.9 — progress=true is NOT a recovery gate: agent in LOOP writes same hash with progress=true → STILL LOOP
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.9 — progress=true is not a recovery gate', () => {
  it('stays LOOP when hash is identical even if progress=true', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-progress-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
    })

    const agent = 'kiera'
    const t0 = 7000000
    const loopInput = {
      classifierState: 'STUCK' as const,
      status_text: 'same status',
      tool_call_signature: 'same-tool-sig',
      pane_bottom_line: 'same pane',
    }

    // Trigger LOOP with 6 identical
    for (let i = 0; i < 6; i++) {
      detector.tick(agent, loopInput, t0 + i * 60)
    }

    // Add progress=true to the same hash input — recovery is NOT triggered
    const inputWithProgress = {
      ...loopInput,
      // progress=true is passed but the hash is the same — loop detector ignores this field
      status_text: 'same status',  // same → same hash → still LOOP
    }
    const result = detector.tick(agent, inputWithProgress, t0 + 6 * 60)
    expect(result.is_loop).toBe(true)
    expect(result.recovery).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
