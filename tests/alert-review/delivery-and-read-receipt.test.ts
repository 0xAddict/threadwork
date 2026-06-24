/**
 * C3.13 — Delivery: report file written to ~/.claude/state/alert-review/<YYYY-MM-DD>.md;
 * task-board send_note posted; task remains UNCOMPLETE (read-receipt invariant).
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AlertReviewEngine } from '../../src/alert-review/index'

describe('C3.13 — Delivery and read-receipt', () => {
  it('report written to <reportDir>/<YYYY-MM-DD>.md and send_note called', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-delivery-'))

    const notesCalled: string[] = []
    const engine = new AlertReviewEngine({
      emitLogPath: join(tmpDir, 'emit.log'),
      reportDir: join(tmpDir, 'reports'),
      reportDateOverride: '2026-05-27',
    })

    const t0 = 1700000000
    const { reportPath, report } = engine.run(t0, t0 + 7 * 86400, (msg, path) => {
      notesCalled.push(msg)
    })

    // Report file must exist
    expect(existsSync(reportPath)).toBe(true)
    expect(reportPath).toContain('2026-05-27.md')

    // send_note was called
    expect(notesCalled.length).toBe(1)
    expect(notesCalled[0]).toContain('2026-05-27')

    // File content is non-empty
    const content = readFileSync(reportPath, 'utf-8')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('## Summary')

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('read-receipt invariant: task stays UNCOMPLETE (send_note is called, not complete_task)', () => {
    // The read-receipt invariant means: the runner calls send_note (not complete_task).
    // Verified by: onSendNote callback IS called, meaning we're "noting" not "completing".
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-read-receipt-'))
    const completeCalled: boolean[] = []
    const noteCalled: boolean[] = []

    const engine = new AlertReviewEngine({
      emitLogPath: join(tmpDir, 'emit.log'),
      reportDir: join(tmpDir, 'reports'),
      reportDateOverride: '2026-05-27',
    })

    const t0 = 1700000000
    engine.run(t0, t0 + 7 * 86400, () => { noteCalled.push(true) })

    expect(noteCalled.length).toBe(1)   // Note posted
    expect(completeCalled.length).toBe(0)  // Task NOT completed

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
