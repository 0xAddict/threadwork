/**
 * C3.12 — Empty-week: report still generated, body explicitly mentions "0 alerts"
 * AND references the deadmans-sentinel (item 9).
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'

describe('C3.12 — Empty week handling', () => {
  it('generates report with "0 alerts" and deadmans-sentinel mention when no emit.log', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-empty-week-'))

    const engine = new AlertReviewEngine({
      emitLogPath: join(tmpDir, 'nonexistent-emit.log'),
      reportDir: join(tmpDir, 'reports'),
    })

    const t0 = 1700900000
    const report = engine.buildReport(t0, t0 + 7 * 86400)

    expect(report.total_emissions).toBe(0)

    const markdown = engine.renderMarkdown(report)
    expect(markdown).toContain('0 alerts')
    expect(markdown).toContain('deadmans-sentinel')

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('also works when emit.log exists but week has no entries', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-empty-week-2-'))
    const logPath = join(tmpDir, 'emit.log')

    // Write an entry OUTSIDE the week window
    const t0 = 1701000000
    const oldEntry = JSON.stringify({
      timestamp_iso: new Date((t0 - 10 * 86400) * 1000).toISOString(),
      fingerprint: 'fp-old',
      severity: 'WARNING', agent: 'sadie', state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT', destination: 'telegram',
      emit_method: 'telegram_direct', alert_id: 'old-1',
    })
    require('fs').writeFileSync(logPath, oldEntry + '\n')

    const engine = new AlertReviewEngine({
      emitLogPath: logPath,
      reportDir: join(tmpDir, 'reports'),
    })

    const report = engine.buildReport(t0, t0 + 7 * 86400)
    expect(report.total_emissions).toBe(0)
    const markdown = engine.renderMarkdown(report)
    expect(markdown).toContain('0 alerts')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
