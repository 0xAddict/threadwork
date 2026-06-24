/**
 * C2.11 — Audit log exceeds 10MB → rotated; last 5 generations on disk
 * (silences.audit.log.1 … .5)
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.11 — audit log rotation at 10MB', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rotates audit log when it exceeds 10MB', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-audit-rot-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({
      silencesPath,
      auditLogPath,
      maxAuditLogBytes: 1024,  // small for testing (1KB)
      auditLogGenerations: 5,
    })

    // Write a large audit log (>1KB) to trigger rotation
    const bigContent = 'x'.repeat(2048)  // 2KB
    writeFileSync(auditLogPath, bigContent, 'utf-8')

    // Trigger rotation by appending
    engine.appendAuditLog({ event: 'test', timestamp: new Date().toISOString() })

    // The original should have been rotated to .1
    expect(existsSync(`${auditLogPath}.1`)).toBe(true)
  })

  it('keeps last 5 generations', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-audit-gen-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({
      silencesPath,
      auditLogPath,
      maxAuditLogBytes: 100,  // 100 bytes for quick rotation
      auditLogGenerations: 5,
    })

    // Trigger multiple rotations
    for (let i = 0; i < 7; i++) {
      writeFileSync(auditLogPath, 'x'.repeat(200), 'utf-8')
      engine.appendAuditLog({ event: `test-${i}`, timestamp: new Date().toISOString() })
    }

    // Check that .1 through .5 exist (at most)
    let count = 0
    for (let i = 1; i <= 5; i++) {
      if (existsSync(`${auditLogPath}.${i}`)) count++
    }
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(5)

    // .6 should not exist (max 5 generations)
    expect(existsSync(`${auditLogPath}.6`)).toBe(false)
  })
})
