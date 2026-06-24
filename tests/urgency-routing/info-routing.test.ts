/**
 * C3.5 — Alert with state=PARKED_PICKER → INFO → no Telegram; task-board note created
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter, DEFAULT_SEVERITY_MAP } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.5 — PARKED_PICKER → INFO routing', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('PARKED_PICKER → INFO → no Telegram, only task-board note', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-info-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({ severityMapPath, criticalDedupPath })

    const alert = { agent: 'sadie', state: 'PARKED_PICKER', reason_class: 'PICKER_PARK' }
    const severity = router.assignSeverity(alert)
    expect(severity).toBe('INFO')

    const route = router.getRoute(severity)
    expect(route.severity).toBe('INFO')
    expect(route.actions.telegram).toBe(false)
    expect(route.actions.push_notification).toBe(false)
    expect(route.actions.task_board_note).toBe(true)
    expect(route.actions.note_prefix).toBe('[INFO]')
  })
})
