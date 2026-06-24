/**
 * C3.15 — Action-author classification: Boss-authored send_note tied to an alert's agent
 * is classified as agent-authored; alert is NOT TP (documented limitation).
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine, AgentAction } from '../../src/alert-review/index'

describe('C3.15 — Boss-not-human classification', () => {
  it('Boss send_note for alert agent → agent-authored; not classified as TP', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-boss-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1701100000

    const alert: EmitLogLine = {
      timestamp_iso: new Date(t0 * 1000).toISOString(),
      fingerprint: 'fp-boss-tp',
      severity: 'CRITICAL',
      agent: 'steve',
      state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT',
      destination: 'telegram',
      emit_method: 'telegram_direct',
      alert_id: 'aid-boss-tp-1',
    }
    writeFileSync(logPath, JSON.stringify(alert) + '\n')

    // Boss sends a note about steve within the 6h window
    const bossAction: AgentAction = {
      timestamp_iso: new Date((t0 + 2 * 3600) * 1000).toISOString(),
      agent: 'steve',
      author: 'boss',    // Boss = agent-authored per documented limitation
      action_type: 'note',
    }

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
      agentActions: [bossAction],
      // No state resolver → defaults to PERSISTENT
      agentStateResolver: () => 'STUCK',
    })

    const report = engine.buildReport(t0 - 100, t0 + 7 * 3600)
    expect(report.classified.length).toBe(1)
    // Boss action should NOT count as human action → not TP
    // With still-STUCK state and boss action = not TP, not AMBIGUOUS (boss is not self=steve)
    // Boss action is filtered out as agent-authored → classified PERSISTENT
    expect(report.classified[0].classification).toBe('PERSISTENT')
    expect(report.tp_count).toBe(0)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
