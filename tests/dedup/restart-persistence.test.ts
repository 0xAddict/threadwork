/**
 * C1.10 — Process restart persistence: kill heartbeat-v2, restart, same alert within 1800s → suppressed
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
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

describe('C1.10 — Restart persistence', () => {
  it('dedup.json survives process restart; same alert still suppressed after restart', () => {
    const dedupFile = join(tmpDir, 'dedup.json')
    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
    const now = Math.floor(Date.now() / 1000)

    // Simulate first process instance
    const engine1 = new DedupEngine({ dedupFile, cooldownSec: 1800 })
    const r1 = engine1.evaluate(alert, now)
    expect(r1.suppressed).toBe(false)

    // Verify dedup.json was written to disk
    expect(existsSync(dedupFile)).toBe(true)

    // Simulate process restart: new engine instance reading same file
    const engine2 = new DedupEngine({ dedupFile, cooldownSec: 1800 })

    // Same alert 60s after first emission — still within 1800s window
    const r2 = engine2.evaluate(alert, now + 60)
    expect(r2.suppressed).toBe(true)
  })
})
