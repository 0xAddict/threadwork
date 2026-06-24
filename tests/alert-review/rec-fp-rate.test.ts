/**
 * C3.8 — Recommendations engine v1 — FP-rate rule:
 * fingerprint X has 9/10 FP (≥5 emissions, ≥80% FP) → recommendation "increase cooldown"
 * includes current cooldown value.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine } from '../../src/alert-review/index'

describe('C3.8 — Recommendations: FP-rate rule', () => {
  it('fingerprint with 9/10 FP (≥5, ≥80%) → "increase cooldown" recommendation', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-fp-rate-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1700500000

    // Write 10 alerts for the same fingerprint
    for (let i = 0; i < 10; i++) {
      const alert: EmitLogLine = {
        timestamp_iso: new Date((t0 + i * 60) * 1000).toISOString(),
        fingerprint: 'fp-noisy-x',
        severity: 'WARNING',
        agent: 'sadie',
        state: 'STUCK',
        reason_class: 'IDLE_TIMEOUT',
        destination: 'telegram',
        emit_method: 'telegram_direct',
        alert_id: `aid-fp-rate-${i}`,
      }
      appendFileSync(logPath, JSON.stringify(alert) + '\n')
    }

    // 9 out of 10 get FP classification (agent recovers to ALIVE)
    // 1 gets PERSISTENT (agent still STUCK)
    let callCount = 0
    const stateResolver = (agent: string, atSec: number): string | null => {
      callCount++
      // First 9 calls: ALIVE (FP), 10th call: STUCK (PERSISTENT)
      if (callCount <= 9) return 'ALIVE'
      return 'STUCK'
    }

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
      agentActions: [],
      agentStateResolver: stateResolver,
    })

    const report = engine.buildReport(t0 - 100, t0 + 7 * 3600)
    expect(report.fp_count).toBe(9)
    expect(report.persistent_count).toBe(1)

    // Recommendation should include "increase cooldown"
    expect(report.recommendations.length).toBeGreaterThanOrEqual(1)
    const rec = report.recommendations.find(r => r.includes('increase cooldown'))
    expect(rec).toBeDefined()
    expect(rec).toContain('fp-noisy-x')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
