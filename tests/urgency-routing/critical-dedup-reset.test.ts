/**
 * C3.7 — WATCHDOG_DEAD then recovery (state changes to normal) → critical-dedup.json entry
 * reset; next WATCHDOG_DEAD starts at 120s cooldown
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.7 — CRITICAL dedup reset on recovery', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resets critical-dedup.json entry on recovery; next WATCHDOG_DEAD starts at 120s', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-dedup-reset-'))
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    const router = new UrgencyRouter({
      criticalDedupPath,
      initialCooldownSec: 120,
    })

    const fp = 'snoopy|WATCHDOG_DEAD|TMUX_DEAD'
    const t0 = 1000

    // First emit
    const r1 = router.routeCritical(fp, false, t0)
    expect(r1.emit).toBe(true)

    // Second within cooldown: suppressed (backoff advanced to 240s)
    const r2 = router.routeCritical(fp, false, t0 + 30)
    expect(r2.emit).toBe(false)

    // RECOVERY: reset dedup entry
    router.resetCriticalDedup(fp)

    // Now check that state is gone
    const state = router.loadCriticalDedup()
    expect(state[fp]).toBeUndefined()

    // Next WATCHDOG_DEAD starts fresh at 120s cooldown
    const r3 = router.routeCritical(fp, false, t0 + 31)
    expect(r3.emit).toBe(true)

    // Next within 120s: suppressed
    const r4 = router.routeCritical(fp, false, t0 + 31 + 30)
    expect(r4.emit).toBe(false)

    // State shows 120s cooldown (initial cooldown after fresh emit, not advanced since suppressed not recorded)
    const state2 = router.loadCriticalDedup()
    expect(state2[fp]).toBeDefined()
    expect(state2[fp].cooldown_sec).toBe(120)  // fresh start at initial cooldown
  })
})
