/**
 * C2.8 — RESOLVED message during an active silence covering the recovered agent
 * → still emits (silences MUST NOT suppress RESOLVED)
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.8 — RESOLVED is not suppressed by silences', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('RESOLVED alert passes through even when agent is silenced', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-resolved-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({ silencesPath, auditLogPath })

    const now = Date.now()
    engine.addSilence({
      id: 'silence-steve',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: new Date(now - 1000).toISOString(),
      ends_at: new Date(now + 3600 * 1000).toISOString(),
      created_by: 'test',
    }, now)

    // Normal STUCK alert for steve: silenced
    const { silenced: normalSilenced, survivors: normalSurvivors } = engine.apply(
      [{ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1', is_resolved: false }],
      now + 100
    )
    expect(normalSilenced.length).toBe(1)

    // RESOLVED alert for steve: NOT silenced
    const { silenced: resolvedSilenced, survivors: resolvedSurvivors } = engine.apply(
      [{ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1', is_resolved: true }],
      now + 200
    )
    expect(resolvedSilenced.length).toBe(0)
    expect(resolvedSurvivors.length).toBe(1)
    expect(resolvedSurvivors[0].is_resolved).toBe(true)
  })
})
