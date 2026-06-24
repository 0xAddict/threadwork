/**
 * C3.6 — WATCHDOG_DEAD fires twice in 30s → second is suppressed by CRITICAL dedup
 * (within 120s); third at 121s → fires (cooldown advances to 240s);
 * fourth within 240s → suppressed; backoff continues 480/1800
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.6 — CRITICAL dedup exponential backoff', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('follows 120→240→480→1800 backoff sequence', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-backoff-'))
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    const router = new UrgencyRouter({
      criticalDedupPath,
      initialCooldownSec: 120,
    })

    const fp = 'snoopy|WATCHDOG_DEAD|TMUX_DEAD'
    const t0 = 1000

    // 1st: EMIT (first time)
    const r1 = router.routeCritical(fp, false, t0)
    expect(r1.emit).toBe(true)

    // 2nd at t0+30: SUPPRESS (within 120s)
    const r2 = router.routeCritical(fp, false, t0 + 30)
    expect(r2.emit).toBe(false)
    expect(r2.suppressed_by_dedup).toBe(true)

    // 3rd at t0+121: EMIT (cooldown 120s elapsed → advances to 240s)
    const r3 = router.routeCritical(fp, false, t0 + 121)
    expect(r3.emit).toBe(true)
    expect(r3.suppressed_by_dedup).toBe(false)

    // 4th at t0+121+100: SUPPRESS (within 240s)
    const r4 = router.routeCritical(fp, false, t0 + 121 + 100)
    expect(r4.emit).toBe(false)
    expect(r4.suppressed_by_dedup).toBe(true)

    // 5th at t0+121+240+1: EMIT (240s elapsed → advances to 480s)
    const r5 = router.routeCritical(fp, false, t0 + 121 + 241)
    expect(r5.emit).toBe(true)

    // 6th at t0+121+241+100: SUPPRESS (within 480s)
    const r6 = router.routeCritical(fp, false, t0 + 121 + 241 + 100)
    expect(r6.emit).toBe(false)

    // 7th at t0+121+241+480+1: EMIT (480s elapsed → advances to 1800s cap)
    const r7 = router.routeCritical(fp, false, t0 + 121 + 241 + 481)
    expect(r7.emit).toBe(true)

    // 8th at t0+...+100: SUPPRESS (within 1800s)
    const r8 = router.routeCritical(fp, false, t0 + 121 + 241 + 481 + 100)
    expect(r8.emit).toBe(false)
  })
})
