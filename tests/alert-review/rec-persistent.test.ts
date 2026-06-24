/**
 * C3.9 — Recommendations engine v1 — PERSISTENT rule:
 * agent has ≥3 PERSISTENT alerts in the week → recommendation "investigate persistent issue"
 * includes agent name.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'
import type { EmitLogLine } from '../../src/alert-review/index'

describe('C3.9 — Recommendations: PERSISTENT rule', () => {
  it('agent with ≥3 PERSISTENT alerts → "investigate persistent issue" recommendation', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-persistent-rec-'))
    const logPath = join(tmpDir, 'emit.log')
    const t0 = 1700600000

    // Write 4 persistent alerts for kiera
    for (let i = 0; i < 4; i++) {
      const alert: EmitLogLine = {
        timestamp_iso: new Date((t0 + i * 3600) * 1000).toISOString(),
        fingerprint: `fp-kiera-persist-${i}`,
        severity: 'WARNING',
        agent: 'kiera',
        state: 'STUCK',
        reason_class: 'IDLE_TIMEOUT',
        destination: 'telegram',
        emit_method: 'telegram_direct',
        alert_id: `aid-kiera-${i}`,
      }
      appendFileSync(logPath, JSON.stringify(alert) + '\n')
    }

    // All PERSISTENT: kiera still STUCK at window end
    const stateResolver = (agent: string, atSec: number): string | null => {
      if (agent === 'kiera') return 'STUCK'
      return null
    }

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
      agentActions: [],
      agentStateResolver: stateResolver,
    })

    const report = engine.buildReport(t0 - 100, t0 + 7 * 86400)
    expect(report.persistent_count).toBe(4)

    const rec = report.recommendations.find(r => r.includes('investigate persistent issue'))
    expect(rec).toBeDefined()
    expect(rec).toContain('kiera')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
