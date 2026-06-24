/**
 * C2.6 — Silence with empty matchers array is rejected
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.6 — empty matchers rejected', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects silence with empty matchers array', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-empty-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const metaAlerts: string[] = []
    const engine = new SilencesEngine({
      silencesPath,
      auditLogPath,
      metaAlertCallback: (msg) => metaAlerts.push(msg),
    })

    const now = Date.now()

    const result = engine.addSilence({
      id: 'empty-matchers',
      matchers: [],  // empty!
      starts_at: new Date(now - 1000).toISOString(),
      ends_at: new Date(now + 3600 * 1000).toISOString(),
      created_by: 'test',
    }, now)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('empty matchers')
    expect(metaAlerts.length).toBeGreaterThan(0)
  })
})
