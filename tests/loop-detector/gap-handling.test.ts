/**
 * C2.11 — System sleep gap: 30-min tick gap recorded as null entries; on wake,
 * window re-accumulates non-null hashes; no spurious LOOP from the gap.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.11 — Gap handling (system sleep)', () => {
  it('gap entries do not count as identical hashes; no spurious LOOP after gap', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-gap-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
    })

    const agent = 'sadie'
    const t0 = 9000000
    const stuckInput = {
      classifierState: 'STUCK' as const,
      status_text: 'status',
      tool_call_signature: 'sig',
      pane_bottom_line: 'pane',
    }

    // 4 real ticks before sleep
    for (let i = 0; i < 4; i++) {
      const result = detector.tick(agent, stuckInput, t0 + i * 60)
      expect(result.is_loop).toBe(false)
    }

    // Simulate 30-min sleep gap: null entries
    // This happens externally (heartbeat records null gaps during sleep)
    // We simulate via boot guard (no transcript/write_status)
    for (let i = 0; i < 3; i++) {
      const result = detector.tick(agent, {
        ...stuckInput,
        has_transcript_entry: false,
        has_write_status: true,
      }, t0 + 300 + i * 600)
      expect(result.hash).toBeNull()
      expect(result.is_loop).toBe(false)
    }

    // After wake: 3 more real ticks with same hash
    // Total non-null = 4 + 3 = 7, but not 6 consecutive (gaps interrupted)
    // After gap, only 3 consecutive → no LOOP
    for (let i = 0; i < 3; i++) {
      const result = detector.tick(agent, stuckInput, t0 + 2500 + i * 60)
      expect(result.is_loop).toBe(false)
    }

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
