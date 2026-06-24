/**
 * C1.8 — Env hot-reload: HEARTBEAT_V2_DEDUP_COOLDOWN_SEC=60 takes effect on next tick
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DedupEngine } from '../../src/dedup/fingerprint'

let tmpDir: string
let savedEnv: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dedup-test-'))
  savedEnv = process.env['HEARTBEAT_V2_DEDUP_COOLDOWN_SEC']
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (savedEnv === undefined) {
    delete process.env['HEARTBEAT_V2_DEDUP_COOLDOWN_SEC']
  } else {
    process.env['HEARTBEAT_V2_DEDUP_COOLDOWN_SEC'] = savedEnv
  }
})

describe('C1.8 — Env hot-reload', () => {
  it('HEARTBEAT_V2_DEDUP_COOLDOWN_SEC=60: fire at t=0, fire at t=61 → second emits', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    // Set cooldown to 60s via env
    process.env['HEARTBEAT_V2_DEDUP_COOLDOWN_SEC'] = '60'
    const engine = new DedupEngine({ dedupFile })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const now = Math.floor(Date.now() / 1000)

    // First emission at t=0
    const r1 = engine.evaluate(alert, now)
    expect(r1.suppressed).toBe(false)

    // At t=30 → still in 60s window → suppressed
    const r2 = engine.evaluate(alert, now + 30)
    expect(r2.suppressed).toBe(true)

    // At t=61 → outside 60s window → emits
    const r3 = engine.evaluate(alert, now + 61)
    expect(r3.suppressed).toBe(false)
  })

  it('env change mid-run: from 60s to 1800s — next evaluation picks up new value', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    process.env['HEARTBEAT_V2_DEDUP_COOLDOWN_SEC'] = '60'
    const engine = new DedupEngine({ dedupFile })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const now = Math.floor(Date.now() / 1000)

    // First emission
    engine.evaluate(alert, now)

    // Change env to 1800s — next tick should use new cooldown
    process.env['HEARTBEAT_V2_DEDUP_COOLDOWN_SEC'] = '1800'

    // At t=61 → outside old 60s window but engine re-reads env → now uses 1800s cooldown
    // BUT: first emission was at t=0; at t=61 with cooldown=1800, we're still in window
    const r2 = engine.evaluate(alert, now + 61)
    expect(r2.suppressed).toBe(true)  // now within 1800s cooldown

    // Verify engine indeed reads env dynamically
    expect(engine.getCooldownSec()).toBe(1800)
  })
})
