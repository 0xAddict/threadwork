/**
 * C3.18 — Recommendations engine v1 produces zero recommendations when no rule
 * threshold is hit (healthy week).
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine } from '../../src/alert-review/index'

describe('C3.18 — Zero recommendations on healthy week', () => {
  it('no recommendations when no rule threshold is met', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-healthy-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1701200000

    // Write 3 alerts with varying fingerprints, all TP (few enough to stay under FP threshold)
    const agents = ['sadie', 'steve', 'kiera']
    for (let i = 0; i < 3; i++) {
      const alert: EmitLogLine = {
        timestamp_iso: new Date((t0 + i * 3600) * 1000).toISOString(),
        fingerprint: `fp-healthy-${i}`,
        severity: 'WARNING',
        agent: agents[i],
        state: 'STUCK',
        reason_class: 'IDLE_TIMEOUT',
        destination: 'telegram',
        emit_method: 'telegram_direct',
        alert_id: `aid-healthy-${i}`,
      }
      appendFileSync(logPath, JSON.stringify(alert) + '\n')
    }

    // All TP: human acted on each one
    const agentActions = agents.map((agent, i) => ({
      timestamp_iso: new Date((t0 + i * 3600 + 1800) * 1000).toISOString(),
      agent,
      author: 'human',
      action_type: 'note' as const,
    }))

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
      agentActions,
      // Low suppress counts, no rule thresholds hit
      suppressData: [
        { fingerprint: 'fp-a', suppress_count: 3 },
      ],
    })

    const report = engine.buildReport(t0 - 100, t0 + 7 * 86400)

    // All 3 alerts should be TP
    expect(report.tp_count).toBe(3)
    // No PERSISTENT agents (< 3), no high-FP fingerprints, no high suppress counts
    expect(report.recommendations.length).toBe(0)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('zero recommendations on completely empty week', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-empty-recs-'))

    const engine = new AlertReviewEngine({
      emitLogPath: join(tmpDir, 'emit.log'),
      reportDir: join(tmpDir, 'reports'),
    })

    const t0 = 1701300000
    const report = engine.buildReport(t0, t0 + 7 * 86400)
    expect(report.recommendations.length).toBe(0)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
