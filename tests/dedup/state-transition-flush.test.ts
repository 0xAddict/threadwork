/**
 * C1.7 — State-transition bypass: STUCK→ALIVE→STUCK both emit; dedup-flush summary fires
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DedupEngine } from '../../src/dedup/fingerprint'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dedup-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('C1.7 — State-transition bypass + dedup-flush', () => {
  it('STUCK→ALIVE→STUCK: both STUCK emit; flush summary fires on ALIVE transition', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 99999 })
    const now = Math.floor(Date.now() / 1000)

    const stuck1 = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const alive = { agent: 'boss', state: 'ALIVE', reason_class: 'IDLE_TIMEOUT' as const }
    const stuck2 = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }

    // First STUCK — emits
    const r1 = engine.evaluate(stuck1, now)
    expect(r1.suppressed).toBe(false)

    // Suppress a couple of STUCK
    engine.evaluate(stuck1, now + 10)
    engine.evaluate(stuck1, now + 20)
    // suppress_count is now 2

    // ALIVE transition — bypasses dedup, fires flush summary
    const r3 = engine.evaluate(alive, now + 30)
    expect(r3.suppressed).toBe(false)
    expect(r3.bypass).toBe(true)
    // flush_summary should mention the STUCK fingerprint being flushed
    expect(r3.flush_summary).toBeDefined()
    expect(r3.flush_summary).toContain('dedup-flush')
    expect(r3.flush_summary).toContain('STUCK')

    // Second STUCK after ALIVE — should emit (bypass because state changed from ALIVE to STUCK)
    const r4 = engine.evaluate(stuck2, now + 40)
    expect(r4.suppressed).toBe(false)
  })

  it('no flush summary when there were 0 suppressions before transition', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 99999 })
    const now = Math.floor(Date.now() / 1000)

    const stuck = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const alive = { agent: 'boss', state: 'ALIVE', reason_class: 'IDLE_TIMEOUT' as const }

    // First STUCK — emits (no suppression yet)
    engine.evaluate(stuck, now)

    // ALIVE transition immediately — no suppressions to flush
    const r2 = engine.evaluate(alive, now + 1)
    expect(r2.suppressed).toBe(false)
    expect(r2.bypass).toBe(true)
    // flush_summary may be undefined or empty string when suppress_count was 0
    const fs = r2.flush_summary
    expect(!fs || fs.length === 0).toBe(true)
  })
})
