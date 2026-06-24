/**
 * C2.2 — Add silence agent=steve for next hour → no steve alerts emit during window;
 * matching events logged in silences.audit.log
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.2 — eq matcher silences agent=steve', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('silences steve alerts and logs to audit log', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-test-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({ silencesPath, auditLogPath })

    const now = Date.now()
    const endsAt = new Date(now + 3600 * 1000).toISOString()
    const startsAt = new Date(now - 1000).toISOString()

    engine.addSilence({
      id: 'test-silence-1',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: startsAt,
      ends_at: endsAt,
      created_by: 'test',
      comment: 'deploying steve',
    }, now)

    const alerts = [
      { agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1' },
      { agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp2' },
    ]

    const { survivors, silenced } = engine.apply(alerts, now + 100)

    // Steve should be silenced
    expect(silenced.length).toBe(1)
    expect(silenced[0].agent).toBe('steve')

    // Boss should survive
    expect(survivors.length).toBe(1)
    expect(survivors[0].agent).toBe('boss')

    // Audit log should exist
    expect(existsSync(auditLogPath)).toBe(true)
    const auditContent = readFileSync(auditLogPath, 'utf-8')
    const auditLines = auditContent.trim().split('\n').filter(l => l)
    expect(auditLines.length).toBeGreaterThan(0)
    const auditEntry = JSON.parse(auditLines[auditLines.length - 1])
    expect(auditEntry.agent).toBe('steve')
    expect(auditEntry.silence_id).toBe('test-silence-1')
  })
})
