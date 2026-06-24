/**
 * C2.10 — Restart resilience: heartbeat-v2 restart mid-LOOP → history loaded from loop-detector.json;
 * agent remains LOOP if next tick still matches.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.10 — Restart resilience', () => {
  it('persists LOOP state across restarts; agent remains LOOP if next tick matches', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-restart-'))
    const histPath = join(tmpDir, 'loop-detector.json')

    // Instance 1: trigger LOOP
    const detector1 = new LoopDetector({ historyPath: histPath, consecutiveN: 6 })
    const agent = 'boss'
    const t0 = 8000000
    const loopInput = {
      classifierState: 'STUCK' as const,
      status_text: 'loop-state',
      tool_call_signature: 'loop-sig',
      pane_bottom_line: 'loop-pane',
    }

    for (let i = 0; i < 6; i++) {
      detector1.tick(agent, loopInput, t0 + i * 60)
    }
    expect(detector1.getAgentState(agent)?.is_loop).toBe(true)

    // Simulate restart: create a NEW detector instance reading from same file
    const detector2 = new LoopDetector({ historyPath: histPath, consecutiveN: 6 })
    // Should still see LOOP state from file
    const stateAfterRestart = detector2.getAgentState(agent)
    expect(stateAfterRestart?.is_loop).toBe(true)

    // Next tick with same hash → still LOOP
    const result = detector2.tick(agent, loopInput, t0 + 7 * 60)
    expect(result.is_loop).toBe(true)
    expect(result.recovery).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
