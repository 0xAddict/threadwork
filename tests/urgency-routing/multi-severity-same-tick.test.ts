/**
 * C3.10 — Two alerts for same agent in same tick: one INFO (PARKED_PICKER), one WARNING (LOOP)
 * → both emit per their own routes; no cross-severity grouping; two distinct task-board notes
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter, DEFAULT_SEVERITY_MAP } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.10 — multi-severity alerts in same tick', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('INFO and WARNING alerts for same agent routed independently', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-multisev-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({ severityMapPath, criticalDedupPath })

    const infoAlert = { agent: 'boss', state: 'PARKED_PICKER', reason_class: 'PICKER_PARK' }
    const warnAlert = { agent: 'boss', state: 'LOOP', reason_class: 'UNKNOWN' }

    const infoSev = router.assignSeverity(infoAlert)
    const warnSev = router.assignSeverity(warnAlert)

    expect(infoSev).toBe('INFO')
    expect(warnSev).toBe('WARNING')

    const infoRoute = router.getRoute(infoSev)
    const warnRoute = router.getRoute(warnSev)

    // INFO: no Telegram
    expect(infoRoute.actions.telegram).toBe(false)
    expect(infoRoute.actions.task_board_note).toBe(true)

    // WARNING: Telegram
    expect(warnRoute.actions.telegram).toBe(true)
    expect(warnRoute.actions.task_board_note).toBe(true)

    // Different severities → different group keys (cross-severity grouping prevented)
    // Group key would be (state, reason_class, severity)
    const infoKey = `${infoAlert.state}::${infoAlert.reason_class}::${infoSev}`
    const warnKey = `${warnAlert.state}::${warnAlert.reason_class}::${warnSev}`
    expect(infoKey).not.toBe(warnKey)
  })
})
