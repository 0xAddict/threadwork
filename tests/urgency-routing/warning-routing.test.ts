/**
 * C3.4 — Alert with state=STUCK reason_class=PICKER_PARK → WARNING
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter, DEFAULT_SEVERITY_MAP } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.4 — STUCK/PICKER_PARK → WARNING routing', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('STUCK+PICKER_PARK → WARNING with normal pipeline', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-warning-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({ severityMapPath, criticalDedupPath })

    const alert = { agent: 'steve', state: 'STUCK', reason_class: 'PICKER_PARK' }
    const severity = router.assignSeverity(alert)
    expect(severity).toBe('WARNING')

    const route = router.getRoute(severity)
    expect(route.severity).toBe('WARNING')
    expect(route.actions.telegram).toBe(true)
    expect(route.actions.push_notification).toBe(false)
    expect(route.actions.task_board_note).toBe(true)
  })
})
