/**
 * C3.10 — Recommendations engine v1 — suppress-count rule:
 * fingerprint Z total suppress_count > 50 in week → "verify suppression" recommendation.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'

describe('C3.10 — Recommendations: suppress-count rule', () => {
  it('fingerprint with suppress_count > 50 → "verify suppression" recommendation', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-suppress-rec-'))

    const engine = new AlertReviewEngine({
      emitLogPath: join(tmpDir, 'emit.log'),
      reportDir: join(tmpDir, 'reports'),
      suppressData: [
        { fingerprint: 'fp-suppress-z', suppress_count: 75 },
        { fingerprint: 'fp-ok', suppress_count: 10 },
      ],
    })

    const t0 = 1700700000
    const report = engine.buildReport(t0, t0 + 7 * 86400)

    const rec = report.recommendations.find(r => r.includes('verify suppression'))
    expect(rec).toBeDefined()
    expect(rec).toContain('fp-suppress-z')
    expect(rec).toContain('75')

    // The "ok" fingerprint with only 10 should NOT trigger recommendation
    const badRec = report.recommendations.find(r => r.includes('fp-ok'))
    expect(badRec).toBeUndefined()

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
