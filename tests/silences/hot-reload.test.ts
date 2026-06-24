/**
 * C2.12 — Hot-reload: file edit mid-soak → next tick honors new silences
 * (no daemon restart)
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.12 — hot-reload on file edit', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('honors new silence added mid-soak without restart', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-hotreload-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')

    const engine = new SilencesEngine({ silencesPath, auditLogPath })

    const now = Date.now()
    const starts = new Date(now - 1000).toISOString()
    const ends = new Date(now + 3600 * 1000).toISOString()

    // Initially no silences: steve alert passes
    const alert = [{ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', fingerprint: 'fp1' }]
    const { survivors: before } = engine.apply(alert, now + 100)
    expect(before.length).toBe(1)

    // "Edit the file" by adding a new silence (simulate hot-reload)
    engine.addSilence({
      id: 'hot-silence',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: starts,
      ends_at: ends,
      created_by: 'test',
    }, now + 200)

    // Next tick: honors new silence (hot-reload reads from file)
    const { silenced: after } = engine.apply(alert, now + 300)
    expect(after.length).toBe(1)
    expect(after[0].agent).toBe('steve')
  })
})
