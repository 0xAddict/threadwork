/**
 * C2.6 — Boot guard: agent with no transcript entries → null gap recorded, NO LOOP until
 * both transcript entry AND write_status exist.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'

describe('C2.6 — Boot guard', () => {
  it('records null gaps and does not trigger LOOP until both transcript and write_status exist', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-boot-'))
    const histPath = join(tmpDir, 'loop-detector.json')
    const detector = new LoopDetector({
      historyPath: histPath,
      consecutiveN: 6,
    })

    const agent = 'boss'
    const t0 = 5000000
    const baseInput = {
      classifierState: 'STUCK' as const,
      status_text: 'status',
      tool_call_signature: 'sig',
      pane_bottom_line: 'pane',
    }

    // No transcript → gap entries, no LOOP
    for (let i = 0; i < 10; i++) {
      const result = detector.tick(agent, { ...baseInput, has_transcript_entry: false, has_write_status: true }, t0 + i * 60)
      expect(result.is_loop).toBe(false)
      expect(result.hash).toBeNull()
    }

    // Has transcript but no write_status → still gap
    const result2 = detector.tick(agent, { ...baseInput, has_transcript_entry: true, has_write_status: false }, t0 + 700)
    expect(result2.is_loop).toBe(false)
    expect(result2.hash).toBeNull()

    // Both present → real hash recorded
    const result3 = detector.tick(agent, { ...baseInput, has_transcript_entry: true, has_write_status: true }, t0 + 800)
    expect(result3.hash).not.toBeNull()
    expect(result3.hash).not.toBe('null')

    // Verify gap entries in history
    const state = JSON.parse(readFileSync(histPath, 'utf-8'))
    const history = state[agent].history
    const gapEntries = history.filter((e: any) => e.hash === null)
    expect(gapEntries.length).toBeGreaterThan(0)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
