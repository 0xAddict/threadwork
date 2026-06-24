/**
 * C1.5 — Two DIFFERENT alerts → both emit
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

describe('C1.5 — Different fingerprints both emit', () => {
  it('different agent → both emit', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })
    const now = Math.floor(Date.now() / 1000)

    const alert1 = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const alert2 = { agent: 'steve', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }

    const r1 = engine.evaluate(alert1, now)
    const r2 = engine.evaluate(alert2, now + 1)

    expect(r1.suppressed).toBe(false)
    expect(r2.suppressed).toBe(false)
  })

  it('different state → both emit', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })
    const now = Math.floor(Date.now() / 1000)

    const alert1 = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const alert2 = { agent: 'boss', state: 'IDLE', reason_class: 'IDLE_TIMEOUT' as const }

    const r1 = engine.evaluate(alert1, now)
    const r2 = engine.evaluate(alert2, now + 1)

    expect(r1.suppressed).toBe(false)
    expect(r2.suppressed).toBe(false)
  })

  it('different reason_class → both emit', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })
    const now = Math.floor(Date.now() / 1000)

    const alert1 = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const alert2 = { agent: 'boss', state: 'STUCK', reason_class: 'TMUX_DEAD' as const }

    const r1 = engine.evaluate(alert1, now)
    const r2 = engine.evaluate(alert2, now + 1)

    expect(r1.suppressed).toBe(false)
    expect(r2.suppressed).toBe(false)
  })
})
