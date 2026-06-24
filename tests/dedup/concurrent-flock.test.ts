/**
 * C1.12 — Concurrent flock: second heartbeat-v2 instance fails to acquire flock, exits non-zero with stderr
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DedupFileLock } from '../../src/dedup/fingerprint'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dedup-flock-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('C1.12 — Concurrent flock', () => {
  it('first instance acquires lock successfully', () => {
    const lockFile = join(tmpDir, 'dedup.lock')
    const lock1 = new DedupFileLock(lockFile)
    const acquired = lock1.tryAcquire()
    expect(acquired).toBe(true)
    lock1.release()
  })

  it('second instance fails when PID file points to running process', () => {
    const lockFile = join(tmpDir, 'dedup.lock')
    const pidFile = lockFile + '.pid'

    // Simulate: first instance wrote OUR OWN PID (current process)
    // We need to write a different "live" PID to simulate another process
    // Use PID 1 (launchd/init) which is always running on macOS/Linux
    writeFileSync(pidFile, '1', 'utf-8')

    // Capture stderr
    const stderrChunks: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }

    let acquired: boolean
    try {
      const lock2 = new DedupFileLock(lockFile)
      acquired = lock2.tryAcquire()
    } finally {
      process.stderr.write = origWrite
    }

    // Second should fail because PID 1 is always running
    expect(acquired).toBe(false)

    // Stderr should have an explanatory message
    const stderrOutput = stderrChunks.join('')
    expect(stderrOutput).toContain('dedup-flock')
  })

  it('stale PID file (dead process) → new instance acquires successfully', () => {
    const lockFile = join(tmpDir, 'dedup.lock')
    const pidFile = lockFile + '.pid'

    // Write a PID that definitely doesn't exist (very high number)
    writeFileSync(pidFile, '999999999', 'utf-8')

    const lock = new DedupFileLock(lockFile)
    const acquired = lock.tryAcquire()

    // Should succeed because the PID is dead/stale
    expect(acquired).toBe(true)
    lock.release()
  })
})
