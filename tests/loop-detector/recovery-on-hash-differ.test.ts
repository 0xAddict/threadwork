/**
 * C2.8 — Recovery: agent in LOOP writes a different hash next tick → LOOP clears immediately
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.8 — Recovery on hash differ', () => {
  it('clears LOOP immediately when hash differs from triggering hash', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-recover-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
    })

    const agent = 'steve'
    const t0 = 6000000
    const loopInput = {
      classifierState: 'STUCK' as const,
      status_text: 'looping',
      tool_call_signature: 'same-sig',
      pane_bottom_line: 'same',
    }

    // Trigger LOOP with 6 identical
    for (let i = 0; i < 6; i++) {
      detector.tick(agent, loopInput, t0 + i * 60)
    }
    let result = detector.tick(agent, loopInput, t0 + 6 * 60)
    // Should already be in LOOP from tick 6 (consecutive-6)
    const beforeResult = detector.getAgentState(agent)
    expect(beforeResult?.is_loop).toBe(true)

    // Write a DIFFERENT hash → recovery
    const newInput = {
      classifierState: 'STUCK' as const,
      status_text: 'new activity',
      tool_call_signature: 'different-sig',
      pane_bottom_line: 'different pane',
    }
    result = detector.tick(agent, newInput, t0 + 7 * 60)
    expect(result.is_loop).toBe(false)
    expect(result.recovery).toBe(true)

    const afterState = detector.getAgentState(agent)
    expect(afterState?.is_loop).toBe(false)
    expect(afterState?.loop_triggering_hash).toBeNull()

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
