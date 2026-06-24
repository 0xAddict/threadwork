/**
 * C3.5 — FP classification: alert emitted at t=0, no human action, agent recovers
 * to ALIVE at t=4h → FP.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine } from '../../src/alert-review/index'

describe('C3.5 — FP classification', () => {
  it('alert at t=0, no human action, agent ALIVE at t=6h window → FP', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-fp-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1700200000

    const alert: EmitLogLine = {
      timestamp_iso: new Date(t0 * 1000).toISOString(),
      fingerprint: 'fp-fp',
      severity: 'WARNING',
      agent: 'kiera',
      state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT',
      destination: 'telegram',
      emit_method: 'telegram_direct',
      alert_id: 'aid-fp-1',
    }
    writeFileSync(logPath, JSON.stringify(alert) + '\n')

    // Resolver: kiera is ALIVE at window end (t0 + 6h)
    const stateResolver = (agent: string, atSec: number): string | null => {
      if (agent === 'kiera') return 'ALIVE'
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
    expect(report.classified[0].classification).toBe('FP')
    expect(report.fp_count).toBe(1)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
