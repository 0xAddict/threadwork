/**
 * C1.4 — Same alert at t=0 and t=1801 → both emit; second-window suppress_count starts at 0
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

describe('C1.4 — Cooldown expiry', () => {
  it('same alert at t=0 and t=1801 → both emitted; second-window suppress_count starts at 0', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const t0 = Math.floor(Date.now() / 1000)

    // First emission at t=0
    const result1 = engine.evaluate(alert, t0)
    expect(result1.suppressed).toBe(false)

    // Second emission at t=1801 (outside cooldown window)
    const result2 = engine.evaluate(alert, t0 + 1801)
    expect(result2.suppressed).toBe(false)

    // Verify second-window suppress_count starts at 0
    const state = engine.loadState()
    const fp = engine.fingerprint(alert)
    expect(state[fp]?.suppress_count).toBe(0)
    expect(state[fp]?.last_emit_at_wallclock).toBe(t0 + 1801)
  })
})
