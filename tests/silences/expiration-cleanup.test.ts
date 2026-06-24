/**
 * C2.4 — Silence expires at t=3600 → at t=3601, file no longer contains it;
 * an audit entry records expiration.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.4 — silence expiration cleanup', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes expired silence from file and logs to audit', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-expiry-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({ silencesPath, auditLogPath })

    const t0Ms = 1000000  // arbitrary base time in ms
    const t0 = t0Ms
    const t3600 = t0 + 3600 * 1000  // ends_at = t0 + 3600s
    const t3601 = t0 + 3601 * 1000  // 1ms after expiry

    // Add silence with ends_at = t0 + 3600s
    // We set creation time to t0 so ends_at > now-at-creation
    engine.addSilence({
      id: 'expiry-test-1',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: new Date(t0).toISOString(),
      ends_at: new Date(t3600).toISOString(),
      created_by: 'test',
    }, t0)

    // At t=3599: still in file
    const activeAtT3599 = engine.loadSilences(t0 + 3599 * 1000)
    expect(activeAtT3599.length).toBe(1)

    // At t=3601: expired → file should no longer contain it
    engine.expireSilences(t3601)
    const activeAtT3601 = engine.loadSilences(t3601)
    expect(activeAtT3601.length).toBe(0)

    // Audit log should have expiration entry
    expect(existsSync(auditLogPath)).toBe(true)
    const auditContent = readFileSync(auditLogPath, 'utf-8')
    const lines = auditContent.trim().split('\n').filter(l => l)
    const expiredEntry = lines.map(l => JSON.parse(l)).find((e: any) => e.event === 'expired')
    expect(expiredEntry).toBeDefined()
    expect(expiredEntry.silence_id).toBe('expiry-test-1')
  })
})
