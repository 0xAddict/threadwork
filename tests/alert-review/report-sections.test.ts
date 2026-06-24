/**
 * C3.7 — Report contains all five mandatory sections:
 * Summary / Top noisy / Top silenced / Per-agent / Recommendations
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'

describe('C3.7 — Report sections', () => {
  it('report markdown contains all 5 required sections', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-sections-'))

    const engine = new AlertReviewEngine({
      emitLogPath: join(tmpDir, 'emit.log'),
      reportDir: join(tmpDir, 'reports'),
    })

    const t0 = 1700400000
    const report = engine.buildReport(t0, t0 + 7 * 86400)
    const markdown = engine.renderMarkdown(report)

    expect(markdown).toContain('## Summary')
    expect(markdown).toContain('## Top Noisy Fingerprints')
    expect(markdown).toContain('## Top Silenced')
    expect(markdown).toContain('## Per-Agent')
    expect(markdown).toContain('## Recommendations')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
