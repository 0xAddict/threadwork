/**
 * C2.3 — Silence with matcher_type=regex and value `^claude-.*` (JS RegExp)
 * → all `claude-*` agents silenced; `boss` (no prefix) is not.
 * This verifies JS RegExp semantics (NOT POSIX-ERE).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.3 — JS RegExp regex matcher', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('silences claude-* agents with ^claude-.* pattern, not boss', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-regex-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({ silencesPath, auditLogPath })

    const now = Date.now()
    const endsAt = new Date(now + 3600 * 1000).toISOString()
    const startsAt = new Date(now - 1000).toISOString()

    engine.addSilence({
      id: 'regex-silence-1',
      matchers: [{ label: 'agent', matcher_type: 'regex', value: '^claude-.*' }],
      starts_at: startsAt,
      ends_at: endsAt,
      created_by: 'test',
    }, now)

    const alerts = [
      { agent: 'claude-steve', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1' },
      { agent: 'claude-sadie', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp2' },
      { agent: 'claude-boss', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp3' },
      { agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp4' },
    ]

    const { survivors, silenced } = engine.apply(alerts, now + 100)

    // All claude-* should be silenced
    expect(silenced.length).toBe(3)
    expect(silenced.map(a => a.agent)).toContain('claude-steve')
    expect(silenced.map(a => a.agent)).toContain('claude-sadie')
    expect(silenced.map(a => a.agent)).toContain('claude-boss')

    // boss (no prefix) should NOT be silenced
    expect(survivors.length).toBe(1)
    expect(survivors[0].agent).toBe('boss')
  })

  it('JS RegExp allows substring match (^.* anchored test)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-regex2-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({ silencesPath, auditLogPath })

    const now = Date.now()
    const endsAt = new Date(now + 3600 * 1000).toISOString()
    const startsAt = new Date(now - 1000).toISOString()

    // Without anchors, regex matches substring
    engine.addSilence({
      id: 'regex-substr',
      matchers: [{ label: 'agent', matcher_type: 'regex', value: 'steve' }],
      starts_at: startsAt,
      ends_at: endsAt,
      created_by: 'test',
    }, now)

    const alerts = [
      { agent: 'claude-steve-runner', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1' },
      { agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp2' },
    ]

    const { survivors, silenced } = engine.apply(alerts, now + 100)

    // claude-steve-runner should be silenced (contains "steve")
    expect(silenced.length).toBe(1)
    expect(silenced[0].agent).toBe('claude-steve-runner')
    expect(survivors[0].agent).toBe('boss')
  })
})
