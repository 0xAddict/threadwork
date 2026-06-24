/**
 * C2.5 — Silence with ends_at < starts_at is rejected at load with stderr error and meta-alert
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.5 — invalid time window rejected', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects silence with ends_at < starts_at with stderr error and meta-alert', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-invalid-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const metaAlerts: string[] = []
    const engine = new SilencesEngine({
      silencesPath,
      auditLogPath,
      metaAlertCallback: (msg) => metaAlerts.push(msg),
    })

    const now = Date.now()
    const starts = new Date(now + 3600 * 1000).toISOString()  // 1 hour from now
    const ends = new Date(now + 1000).toISOString()             // only 1 second from now (< starts)

    const result = engine.addSilence({
      id: 'invalid-window',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: starts,
      ends_at: ends,
      created_by: 'test',
    }, now)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('ends_at')

    // Meta-alert should have fired
    expect(metaAlerts.length).toBeGreaterThan(0)
    expect(metaAlerts[0]).toContain('Invalid silence rejected')
  })

  it('also rejects when loading from file with invalid window', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-invalid2-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    // Write bad silence directly to file
    const now = Date.now()
    const bad = {
      silences: [{
        id: 'bad-1',
        matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
        starts_at: new Date(now + 3600 * 1000).toISOString(),
        ends_at: new Date(now + 1000).toISOString(),
        created_by: 'test',
      }]
    }
    writeFileSync(silencesPath, JSON.stringify(bad), 'utf-8')

    const metaAlerts: string[] = []
    const engine = new SilencesEngine({
      silencesPath,
      auditLogPath,
      metaAlertCallback: (msg) => metaAlerts.push(msg),
    })

    const loaded = engine.loadSilences(now)
    // Invalid silence should be rejected
    expect(loaded.length).toBe(0)
    expect(metaAlerts.length).toBeGreaterThan(0)
  })
})
