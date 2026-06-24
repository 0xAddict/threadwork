/**
 * C3.12 — Group bucket-key invariant: extended to (state, reason_class, severity)
 * so groups CANNOT span severity tiers; only one group object per triple
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.12 — group key includes severity (no cross-severity groups)', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('same state+reason_class but different severity → separate groups', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'grouping-severity-'))
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      dumpDir: join(tmpDir, 'groups'),
    })

    const t0 = 1000

    // Two alerts with same state+reason_class but different severity
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'CRITICAL' }, t0 + 2)

    // Should be two separate groups
    expect(engine.getAllGroups().size).toBe(2)

    const warningGroup = engine.getGroup('STUCK', 'PICKER_PARK', 'WARNING')
    const criticalGroup = engine.getGroup('STUCK', 'PICKER_PARK', 'CRITICAL')

    expect(warningGroup).toBeDefined()
    expect(criticalGroup).toBeDefined()

    expect(warningGroup!.members.has('boss')).toBe(true)
    expect(criticalGroup!.members.has('steve')).toBe(true)

    // Groups flush independently (later group created at t0+2, needs t0+2+30=t0+32, so use t0+33)
    const msgs = engine.tick(t0 + 33)
    expect(msgs.length).toBe(2)
    const severities = msgs.map(m => m.severity)
    expect(severities).toContain('WARNING')
    expect(severities).toContain('CRITICAL')
  })

  it('only one group object per (state, reason_class, severity) triple', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'grouping-severity2-'))
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      dumpDir: join(tmpDir, 'groups'),
    })

    const t0 = 1000

    // Multiple agents all sharing same triple
    engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0)
    engine.ingest({ agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 2)
    engine.ingest({ agent: 'sadie', state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + 4)

    // Only one group
    expect(engine.getAllGroups().size).toBe(1)
    const group = engine.getGroup('STUCK', 'PICKER_PARK', 'WARNING')!
    expect(group.members.size).toBe(3)
  })
})
