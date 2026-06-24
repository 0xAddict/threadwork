/**
 * C2.7 — Two overlapping silences for same matcher, deletion of one (by ID)
 * → other still applies
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.7 — overlapping silences are independent', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deleting one silence does not affect the other', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-overlap-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({ silencesPath, auditLogPath })

    const now = Date.now()
    const starts = new Date(now - 1000).toISOString()
    const ends1 = new Date(now + 3600 * 1000).toISOString()
    const ends2 = new Date(now + 7200 * 1000).toISOString()

    engine.addSilence({
      id: 'silence-a',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: starts,
      ends_at: ends1,
      created_by: 'test',
    }, now)

    engine.addSilence({
      id: 'silence-b',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: starts,
      ends_at: ends2,
      created_by: 'test',
    }, now)

    // Both apply: steve is silenced
    const { silenced: before } = engine.apply(
      [{ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1' }],
      now + 100
    )
    expect(before.length).toBe(1)

    // Delete silence-a
    engine.deleteSilenceById('silence-a')

    // silence-b still applies: steve should still be silenced
    const { silenced: after } = engine.apply(
      [{ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1' }],
      now + 200
    )
    expect(after.length).toBe(1)
    expect(after[0].agent).toBe('steve')
  })
})
