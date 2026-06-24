/**
 * C2.3 — Windowed-supermajority: 9 of last 12 non-null hashes identical (but not consecutive) → LOOP
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.3 — Windowed supermajority trigger', () => {
  it('classifies LOOP when 9 of 12 non-null hashes are identical (non-consecutive)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-window-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
      windowSize: 12,
      majorityThreshold: 9,
    })

    const agent = 'boss'
    const t0 = 2000000

    // Pattern: AABAABABAAA = 8 A's then on 9th = LOOP via windowed (not consecutive)
    // Use: A, A, B, A, A, B, A, A, B, A → 7 A's, 3 B's → no loop yet
    // Then: A, A = 9 A's in last 12 → LOOP
    const inputA = { classifierState: 'STUCK' as const, status_text: 'status-A', tool_call_signature: 'sig-A', pane_bottom_line: 'pane-A' }
    const inputB = { classifierState: 'STUCK' as const, status_text: 'status-B', tool_call_signature: 'sig-B', pane_bottom_line: 'pane-B' }

    // tick 1-3: A, A, B
    expect(detector.tick(agent, inputA, t0 + 0).is_loop).toBe(false)
    expect(detector.tick(agent, inputA, t0 + 60).is_loop).toBe(false)
    expect(detector.tick(agent, inputB, t0 + 120).is_loop).toBe(false)
    // tick 4-6: A, A, B
    expect(detector.tick(agent, inputA, t0 + 180).is_loop).toBe(false)
    expect(detector.tick(agent, inputA, t0 + 240).is_loop).toBe(false)
    expect(detector.tick(agent, inputB, t0 + 300).is_loop).toBe(false)
    // tick 7-9: A, A, B
    expect(detector.tick(agent, inputA, t0 + 360).is_loop).toBe(false)
    expect(detector.tick(agent, inputA, t0 + 420).is_loop).toBe(false)
    expect(detector.tick(agent, inputB, t0 + 480).is_loop).toBe(false)
    // Window now: A,A,B,A,A,B,A,A,B = 6A, 3B — no 9-majority yet
    // tick 10-12: A, A, A → window: A,A,B,A,A,B,A,A,A,A = 8A, 2B → still no
    // Actually need 9A in the last 12. Let's add 3 more A's
    expect(detector.tick(agent, inputA, t0 + 540).is_loop).toBe(false)
    // Window: A,A,B,A,A,B,A,A,B,A = 7A, 3B — no
    expect(detector.tick(agent, inputA, t0 + 600).is_loop).toBe(false)
    // Window: A,A,B,A,A,B,A,A,A,A = 8A, 3B truncated to last 12... wait
    // Let me count: we've added 11 entries. All last 11 non-null.
    // At tick 12, adding A: history = [A,A,B,A,A,B,A,A,B,A,A,?]
    // Last 12: A,A,B,A,A,B,A,A,B,A,A,A = 9A, 3B → 9A >= 9 threshold → LOOP!
    const result = detector.tick(agent, inputA, t0 + 660)
    expect(result.is_loop).toBe(true)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
