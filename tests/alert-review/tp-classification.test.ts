/**
 * C3.3 — TP classification: alert emitted at t=0, non-agent-authored task-board action
 * at t=5h → classified TP.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine, AgentAction } from '../../src/alert-review/index'

describe('C3.3 — TP classification', () => {
  it('alert at t=0 with human action at t=5h → TP', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-tp-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1700000000  // unix seconds

    const alert: EmitLogLine = {
      timestamp_iso: new Date(t0 * 1000).toISOString(),
      fingerprint: 'fp-tp',
      severity: 'WARNING',
      agent: 'sadie',
      state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT',
      destination: 'telegram',
      emit_method: 'telegram_direct',
      alert_id: 'aid-tp-1',
    }
    writeFileSync(logPath, JSON.stringify(alert) + '\n')

    const humanAction: AgentAction = {
      timestamp_iso: new Date((t0 + 5 * 3600) * 1000).toISOString(),
      agent: 'sadie',
      author: 'human',
      action_type: 'note',
    }

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
      agentActions: [humanAction],
    })

    const report = engine.buildReport(t0 - 100, t0 + 7 * 3600)
    expect(report.classified.length).toBe(1)
    expect(report.classified[0].classification).toBe('TP')
    expect(report.tp_count).toBe(1)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
