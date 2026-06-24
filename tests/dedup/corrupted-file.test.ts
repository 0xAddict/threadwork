/**
 * C1.11 — Corrupted dedup.json → emits, no crash, stderr warning logged
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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

describe('C1.11 — Corrupted dedup file', () => {
  it('garbage dedup.json → emits, no crash, stderr warning logged', () => {
    const dedupFile = join(tmpDir, 'dedup.json')

    // Write garbage to dedup.json
    writeFileSync(dedupFile, 'NOT_VALID_JSON{{{{', 'utf-8')

    // Capture stderr
    const stderrChunks: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }

    let result: { suppressed: boolean } | undefined
    try {
      const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })
      const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
      result = engine.evaluate(alert, Math.floor(Date.now() / 1000))
    } finally {
      process.stderr.write = origWrite
    }

    // Should NOT be suppressed (treating corrupted file as empty)
    expect(result).toBeDefined()
    expect(result!.suppressed).toBe(false)

    // Stderr warning should have been logged
    const stderrOutput = stderrChunks.join('')
    expect(stderrOutput).toContain('[dedup]')
  })

  it('truncated dedup.json (empty) → emits, no crash', () => {
    const dedupFile = join(tmpDir, 'dedup.json')

    // Write empty file
    writeFileSync(dedupFile, '', 'utf-8')

    const stderrChunks: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }

    let result: { suppressed: boolean } | undefined
    try {
      const engine = new DedupEngine({ dedupFile, cooldownSec: 1800 })
      const alert = { agent: 'boss', state: 'STUCK', reason_class: 'IDLE_TIMEOUT' as const }
      result = engine.evaluate(alert, Math.floor(Date.now() / 1000))
    } finally {
      process.stderr.write = origWrite
    }

    expect(result).toBeDefined()
    expect(result!.suppressed).toBe(false)
  })
})
