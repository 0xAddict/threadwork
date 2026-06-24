/**
 * C1.3 — Same alert fired 13 times → emissions 1 and 13 (meta-alert at multiple-of-12); 2-12 suppressed
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

describe('C1.3 — Meta-alert at multiple of 12', () => {
  it('13 firings: emissions 1 and 13 sent (13th is meta-alert); 2-12 suppressed', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    // Use a very long cooldown so all 13 fire within window
    const engine = new DedupEngine({ dedupFile, cooldownSec: 99999 })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const baseTime = Math.floor(Date.now() / 1000)

    const results: Array<{ suppressed: boolean; meta_alert: boolean; meta_alert_msg?: string }> = []

    for (let i = 0; i < 13; i++) {
      const result = engine.evaluate(alert, baseTime + i * 10)
      results.push({
        suppressed: result.suppressed,
        meta_alert: result.meta_alert,
        meta_alert_msg: result.meta_alert_msg,
      })
    }

    // First emission: not suppressed
    expect(results[0]!.suppressed).toBe(false)
    expect(results[0]!.meta_alert).toBe(false)

    // Emissions 2-12 (index 1-11): suppressed
    for (let i = 1; i <= 11; i++) {
      expect(results[i]!.suppressed).toBe(true)
    }

    // 13th (index 12): suppressed but also meta_alert (suppress_count hits 12)
    expect(results[12]!.suppressed).toBe(true)
    expect(results[12]!.meta_alert).toBe(true)
    expect(results[12]!.meta_alert_msg).toBeDefined()
    expect(results[12]!.meta_alert_msg).toContain('suppressed N=12')
  })
})
