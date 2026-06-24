/**
 * C3.6 — PERSISTENT classification: alert emitted at t=0, agent still in alert state
 * at t=6h → PERSISTENT.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine } from '../../src/alert-review/index'

describe('C3.6 — PERSISTENT classification', () => {
  it('alert at t=0, agent still STUCK at window end → PERSISTENT', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-persistent-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1700300000

    const alert: EmitLogLine = {
      timestamp_iso: new Date(t0 * 1000).toISOString(),
      fingerprint: 'fp-persistent',
      severity: 'WARNING',
      agent: 'boss',
      state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT',
      destination: 'telegram',
      emit_method: 'telegram_direct',
      alert_id: 'aid-persistent-1',
    }
    writeFileSync(logPath, JSON.stringify(alert) + '\n')

    // Resolver: boss is still STUCK at window end
    const stateResolver = (agent: string, atSec: number): string | null => {
      if (agent === 'boss') return 'STUCK'
      return null
    }

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
      agentActions: [],
      agentStateResolver: stateResolver,
    })

    const report = engine.buildReport(t0 - 100, t0 + 7 * 3600)
    expect(report.classified.length).toBe(1)
    expect(report.classified[0].classification).toBe('PERSISTENT')
    expect(report.persistent_count).toBe(1)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
