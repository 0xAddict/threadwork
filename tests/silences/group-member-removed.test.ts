/**
 * C2.9 — Group of 5 stuck agents, then silence one → next tick, group has 4 members;
 * emission reflects
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { SilencesEngine } from '../../src/silences/index'
import { GroupingEngine } from '../../src/grouping/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C2.9 — silenced member removed from group', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('group has 4 members after one is silenced', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silences-group-rm-'))
    const silencesPath = join(tmpDir, 'silences.json')
    const auditLogPath = join(tmpDir, 'silences.audit.log')
    const dumpDir = join(tmpDir, 'groups')

    const silencesEngine = new SilencesEngine({ silencesPath, auditLogPath })
    const groupEngine = new GroupingEngine({ groupWaitSec: 30, dumpDir })

    const now = Date.now()
    const t0 = Math.floor(now / 1000)

    // 5 agents stuck
    const agents = ['boss', 'steve', 'sadie', 'kiera', 'snoopy']
    for (const agent of agents) {
      groupEngine.ingest({ agent, state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    }

    // Before first flush (group_wait not yet elapsed)
    const earlyTick = groupEngine.tick(t0 + 20)
    expect(earlyTick.length).toBe(0)

    // Silence steve
    silencesEngine.addSilence({
      id: 'silence-steve',
      matchers: [{ label: 'agent', matcher_type: 'eq', value: 'steve' }],
      starts_at: new Date(now - 1000).toISOString(),
      ends_at: new Date(now + 3600 * 1000).toISOString(),
      created_by: 'test',
    }, now)

    // Simulate next tick: re-ingest, but filter out silenced members
    const nextTickAlerts = agents.map(agent => ({
      agent,
      state: 'STUCK',
      reason_class: 'PICKER_PARK',
      severity: 'WARNING',
      fingerprint: `fp-${agent}`,
    }))

    const { survivors } = silencesEngine.apply(nextTickAlerts, now + 31000)

    // Re-ingest only survivors into grouping engine
    for (const alert of survivors) {
      groupEngine.ingest(alert as any, t0 + 31)
    }
    // Mark steve as inactive (silenced)
    groupEngine.markInactive('STUCK', 'PICKER_PARK', 'WARNING', 'steve', t0 + 31)

    // Now flush
    const msgs = groupEngine.tick(t0 + 31)
    expect(msgs.length).toBe(1)
    // 4 members (steve removed)
    expect(msgs[0].agents.length).toBe(4)
    expect(msgs[0].agents).not.toContain('steve')
  })
})
