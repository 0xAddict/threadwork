/**
 * C3.2 — Alert with state=WATCHDOG_DEAD → severity=CRITICAL → PushNotification (or fallback)
 * fires AND direct Telegram fires AND task-board note created; bypasses standard dedup but
 * subject to CRITICAL dedup
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter, DEFAULT_SEVERITY_MAP } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.2 — WATCHDOG_DEAD → CRITICAL routing', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('assigns CRITICAL severity to WATCHDOG_DEAD alert', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-critical-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({ severityMapPath, criticalDedupPath, pushNotificationAvailable: true })

    const alert = { agent: 'snoopy', state: 'WATCHDOG_DEAD', reason_class: 'TMUX_DEAD' }
    const severity = router.assignSeverity(alert)
    expect(severity).toBe('CRITICAL')

    const route = router.getRoute(severity, true)
    expect(route.severity).toBe('CRITICAL')
    expect(route.actions.push_notification).toBe(true)
    expect(route.actions.telegram).toBe(true)
    expect(route.actions.task_board_note).toBe(true)
  })

  it('CRITICAL dedup: first alert emits, second within cooldown suppressed', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-critical-dedup-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({
      severityMapPath,
      criticalDedupPath,
      initialCooldownSec: 120,
    })

    const fp = 'snoopy|WATCHDOG_DEAD|TMUX_DEAD'
    const t0 = 1000

    // First: emit
    const first = router.routeCritical(fp, false, t0)
    expect(first.emit).toBe(true)
    expect(first.suppressed_by_dedup).toBe(false)

    // Second at t0+30 (within 120s cooldown): suppressed
    const second = router.routeCritical(fp, false, t0 + 30)
    expect(second.emit).toBe(false)
    expect(second.suppressed_by_dedup).toBe(true)
  })
})
