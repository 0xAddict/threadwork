/**
 * C3.11 — Top silenced section counts UNIQUE fingerprints (rows), NOT total suppress
 * increments; total suppress_count rendered as a column.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'

describe('C3.11 — Top silenced: unique fingerprints', () => {
  it('top_silenced has one row per fingerprint; suppress_count is a column', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-top-silenced-'))

    const engine = new AlertReviewEngine({
      emitLogPath: join(tmpDir, 'emit.log'),
      reportDir: join(tmpDir, 'reports'),
      suppressData: [
        { fingerprint: 'fp-aa', suppress_count: 30 },
        { fingerprint: 'fp-bb', suppress_count: 60 },
        { fingerprint: 'fp-cc', suppress_count: 5 },
      ],
    })

    const t0 = 1700800000
    const report = engine.buildReport(t0, t0 + 7 * 86400)

    // Should have 3 unique fingerprints, sorted by suppress_count desc
    expect(report.top_silenced.length).toBe(3)
    expect(report.top_silenced[0].fingerprint).toBe('fp-bb')
    expect(report.top_silenced[0].suppress_count).toBe(60)
    expect(report.top_silenced[1].fingerprint).toBe('fp-aa')
    expect(report.top_silenced[1].suppress_count).toBe(30)
    expect(report.top_silenced[2].fingerprint).toBe('fp-cc')
    expect(report.top_silenced[2].suppress_count).toBe(5)

    // Verify markdown contains suppress_count as column
    const markdown = engine.renderMarkdown(report)
    expect(markdown).toContain('Suppress Count')
    expect(markdown).toContain('fp-bb')
    expect(markdown).toContain('60')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
