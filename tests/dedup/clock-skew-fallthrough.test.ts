/**
 * C1.9 — Clock-skew fallthrough: wall-clock delta negative OR >24h → emit (cooldown ignored)
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

describe('C1.9 — Clock-skew fallthrough', () => {
  it('negative wall-clock delta (NTP jump backward) → emit despite being in cooldown window', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const now = Math.floor(Date.now() / 1000)

    // First emission at now
    engine.evaluate(alert, now)

    // Simulate NTP jump: "now" is before last_emit — negative delta
    const backInTime = now - 3600 // 1 hour earlier

    const result = engine.check(alert, backInTime)
    expect(result.suppressed).toBe(false)
  })

  it('wall-clock delta > 24h → emit despite fingerprint matching', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 99999 })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const now = Math.floor(Date.now() / 1000)

    // First emission
    engine.evaluate(alert, now)

    // 25 hours later — > 24h delta → fallthrough
    const later = now + 25 * 3600

    const result = engine.check(alert, later)
    expect(result.suppressed).toBe(false)
  })
})
