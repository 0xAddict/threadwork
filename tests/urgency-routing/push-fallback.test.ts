/**
 * C3.11 — PushNotification tool unavailable → CRITICAL emits via Telegram fallback
 * prefixed `[CRITICAL][PUSH-FALLBACK]`
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.11 — PushNotification fallback', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses [CRITICAL][PUSH-FALLBACK] prefix when push unavailable', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-pushfallback-'))
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    // pushNotificationAvailable = false
    const router = new UrgencyRouter({
      criticalDedupPath,
      pushNotificationAvailable: false,
    })

    const route = router.getRoute('CRITICAL', false)

    expect(route.severity).toBe('CRITICAL')
    expect(route.actions.push_notification).toBe(false)
    expect(route.actions.telegram).toBe(true)
    expect(route.actions.telegram_prefix).toBe('[CRITICAL][PUSH-FALLBACK]')
    expect(route.actions.task_board_note).toBe(true)
  })

  it('uses [CRITICAL] prefix when push available', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-pushok-'))
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    const router = new UrgencyRouter({
      criticalDedupPath,
      pushNotificationAvailable: true,
    })

    const route = router.getRoute('CRITICAL', true)

    expect(route.actions.push_notification).toBe(true)
    expect(route.actions.telegram_prefix).toBe('[CRITICAL]')
  })
})
