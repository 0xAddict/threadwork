/**
 * C3.4 — AMBIGUOUS classification: alert emitted at t=0, agent-self write_status at t=2h,
 * no human action → AMBIGUOUS.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine, AgentAction } from '../../src/alert-review/index'

describe('C3.4 — AMBIGUOUS classification', () => {
  it('alert at t=0, agent write_status at t=2h, no human → AMBIGUOUS', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-ambiguous-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1700100000

    const alert: EmitLogLine = {
      timestamp_iso: new Date(t0 * 1000).toISOString(),
      fingerprint: 'fp-ambiguous',
      severity: 'WARNING',
      agent: 'steve',
      state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT',
      destination: 'telegram',
      emit_method: 'telegram_direct',
      alert_id: 'aid-ambig-1',
    }
    writeFileSync(logPath, JSON.stringify(alert) + '\n')

    const agentSelfAction: AgentAction = {
      timestamp_iso: new Date((t0 + 2 * 3600) * 1000).toISOString(),
      agent: 'steve',
      author: 'steve',   // self-authored
      action_type: 'status',
    }

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
      agentActions: [agentSelfAction],
      // No state resolver → default PERSISTENT, but self-status triggers AMBIGUOUS first
    })

    const report = engine.buildReport(t0 - 100, t0 + 7 * 3600)
    expect(report.classified.length).toBe(1)
    expect(report.classified[0].classification).toBe('AMBIGUOUS')
    expect(report.ambiguous_count).toBe(1)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
