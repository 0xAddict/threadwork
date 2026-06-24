/**
 * C1.6 — Two alerts same (agent, state) but different free-text reasons (RAW path) → both emit
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

describe('C1.6 — RAW reason distinct fingerprints', () => {
  it('same (agent, state) but different free-text reasons → both emit (RAW path)', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })
    const now = Math.floor(Date.now() / 1000)

    // Use an unknown reason_class to trigger RAW path
    const alert1 = {
      agent: 'boss',
      state: 'STUCK',
      reason_class: 'UNKNOWN_ERROR',
      full_reason_text: 'task #123 overdue by 2h',
    }
    const alert2 = {
      agent: 'boss',
      state: 'STUCK',
      reason_class: 'UNKNOWN_ERROR',
      full_reason_text: 'disk space low on /tmp',
    }

    // Different free-text → different fingerprints → both emit
    const fp1 = engine.fingerprint(alert1)
    const fp2 = engine.fingerprint(alert2)
    expect(fp1).not.toBe(fp2)

    const r1 = engine.evaluate(alert1, now)
    const r2 = engine.evaluate(alert2, now + 1)

    expect(r1.suppressed).toBe(false)
    expect(r2.suppressed).toBe(false)
  })

  it('same (agent, state, full_reason_text) on RAW path → second IS suppressed', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })
    const now = Math.floor(Date.now() / 1000)

    const alert = {
      agent: 'boss',
      state: 'STUCK',
      reason_class: 'UNKNOWN_ERROR',
      full_reason_text: 'task #123 overdue by 2h',
    }

    const r1 = engine.evaluate(alert, now)
    const r2 = engine.evaluate(alert, now + 30)

    expect(r1.suppressed).toBe(false)
    expect(r2.suppressed).toBe(true)
  })
})
