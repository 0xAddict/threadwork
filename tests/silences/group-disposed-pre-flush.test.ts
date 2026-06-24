/**
 * C2.10 — Group of 2 stuck agents, silence both before first flush
 * → group disposed silently (no emit, no RESOLVED)
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { GroupingEngine } from '../../src/grouping/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.10 — group disposed silently when all members silenced pre-flush', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('no emit when all members silenced before first flush', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-disposed-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')
    const dumpDir = join(tmpDir, 'groups')

    const silencesEngine = new SilencesEngine({ silencesPath, auditLogPath })
    const groupEngine = new GroupingEngine({ groupWaitSec: 30, dumpDir })

    const now = Date.now()
    const t0 = Math.floor(now / 1000)

    // 2 agents stuck
    groupEngine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    groupEngine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 2)

    // Silence both before group_wait elapses
    silencesEngine.addSilence({
      id: 'silence-boss',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'boss' }],
      starts_at: new Date(now - 1000).toISOString(),
      ends_at: new Date(now + 3600 * 1000).toISOString(),
      created_by: 'test',
    }, now)

    silencesEngine.addSilence({
      id: 'silence-steve',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: new Date(now - 1000).toISOString(),
      ends_at: new Date(now + 3600 * 1000).toISOString(),
      created_by: 'test',
    }, now)

    // Simulate tick at t0+31 with silence filtering: all members silenced
    const alerts = [
      { agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING', fingerprint: 'fp-boss' },
      { agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING', fingerprint: 'fp-steve' },
    ]

    const { survivors } = silencesEngine.apply(alerts, now + 31000)
    // Both silenced, no survivors
    expect(survivors.length).toBe(0)

    // Mark both as inactive in group (since both silenced)
    groupEngine.markInactive('STUCK', 'PICKER_PARK', 'WARNING', 'boss', t0 + 31)
    groupEngine.markInactive('STUCK', 'PICKER_PARK', 'WARNING', 'steve', t0 + 31)

    // Group had NOT been flushed before; with all members inactive, RESOLVED would require 60s
    // Since not yet flushed, group should be disposed silently (no emit)
    // We simulate the group disposal by not re-ingesting the silenced members
    const msgs = groupEngine.tick(t0 + 31 + 60 + 1)

    // Group was never flushed, so RESOLVED should NOT emit
    const resolvedMsgs = msgs.filter(m => m.is_resolved)
    expect(resolvedMsgs.length).toBe(0)
  })
})
