/**
 * C1.2 — Same alert fired twice within 1800s → second suppressed; suppress_count=1
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

describe('C1.2 — Same alert suppressed within 1800s', () => {
  it('second emission of identical alert is suppressed; suppress_count=1', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const now = Math.floor(Date.now() / 1000)

    // First emission: should NOT be suppressed
    const result1 = engine.evaluate(alert, now)
    expect(result1.suppressed).toBe(false)
    expect(result1.meta_alert).toBe(false)

    // Second emission 30s later: should be suppressed
    const result2 = engine.evaluate(alert, now + 30)
    expect(result2.suppressed).toBe(true)
    expect(result2.meta_alert).toBe(false)

    // Verify persisted suppress_count=1
    const state = engine.loadState()
    const fp = engine.fingerprint(alert)
    expect(state[fp]?.suppress_count).toBe(1)
  })
})
