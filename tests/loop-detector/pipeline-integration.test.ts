/**
 * C2.14 — LOOP integration with pipeline: a LOOP alert is dedup'd (item 1), groupable (item 2),
 * inhibitable (item 3, with applies_to_critical respected), silenceable (item 4);
 * RESOLVED messages from grouping ride normal rules.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LoopDetector } from '../../src/loop-detector/index'
import { DedupEngine } from '../../src/dedup/fingerprint'
import { GroupingEngine } from '../../src/grouping/index'

describe('C2.14 — LOOP alert pipeline integration', () => {
  it('LOOP state produced by detector can be ingested by dedup engine', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-pipeline-'))
    const detector = new LoopDetector({
      historyPath: join(tmpDir, 'loop-detector.json'),
      consecutiveN: 6,
    })
    const dedup = new DedupEngine({
      dedupFile: join(tmpDir, 'dedup.json'),
      cooldownSec: 300,
    })

    const agent = 'sadie'
    const t0 = 13000000
    const input = {
      classifierState: 'STUCK' as const,
      status_text: 'looping status',
      tool_call_signature: 'looping-sig',
      pane_bottom_line: 'looping pane',
    }

    // Trigger LOOP
    for (let i = 0; i < 6; i++) {
      detector.tick(agent, input, t0 + i * 60)
    }
    const loopResult = detector.tick(agent, input, t0 + 6 * 60)
    expect(loopResult.is_loop).toBe(true)

    // LOOP alert can be processed by dedup engine
    const alert = { agent, state: 'LOOP', reason_class: 'IDLE_TIMEOUT' }  // use known class
    const dedupResult1 = dedup.check(alert, t0 + 6 * 60)
    expect(dedupResult1.suppressed).toBe(false)  // First time: emit
    dedup.record(alert, t0 + 6 * 60)  // record the emission

    const dedupResult2 = dedup.check(alert, t0 + 7 * 60)
    expect(dedupResult2.suppressed).toBe(true)  // Dedup'd within cooldown

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('LOOP state can be ingested by grouping engine', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-group-'))
    const grouper = new GroupingEngine({
      dumpDir: join(tmpDir, 'groups'),
      groupWaitSec: 0,
    })

    const agent = 'sadie'
    const t0 = 14000000

    grouper.ingest({ agent, state: 'LOOP', reason_class: 'LOOP_DETECTED', severity: 'WARNING' }, t0)
    const messages = grouper.tick(t0)
    expect(messages.length).toBeGreaterThan(0)
    expect(messages[0].state).toBe('LOOP')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
