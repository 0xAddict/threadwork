/**
 * C3.17 — Configurable cron via env: setting ALERT_REVIEW_CRON to a different value
 * regenerates the plist's StartCalendarInterval accordingly.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  generateAlertReviewPlist,
  installAlertReviewPlist,
  parseAlertReviewCron,
} from '../../src/alert-review/index'

describe('C3.17 — Configurable cron via ALERT_REVIEW_CRON', () => {
  it('parseAlertReviewCron parses "1 09:00" → Monday 09:00', () => {
    const result = parseAlertReviewCron('1 09:00')
    expect(result).toBeDefined()
    expect(result!.Weekday).toBe(1)
    expect(result!.Hour).toBe(9)
    expect(result!.Minute).toBe(0)
  })

  it('parseAlertReviewCron parses "5 17:00" → Friday 17:00', () => {
    const result = parseAlertReviewCron('5 17:00')
    expect(result).toBeDefined()
    expect(result!.Weekday).toBe(5)
    expect(result!.Hour).toBe(17)
    expect(result!.Minute).toBe(0)
  })

  it('generateAlertReviewPlist uses custom StartCalendarInterval', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-cron-'))
    const plistPath = join(tmpDir, 'com.threadwork.alert-review.plist')
    const runnerScript = join(tmpDir, 'runner.sh')

    generateAlertReviewPlist({
      plistPath,
      runnerScript,
      calendarInterval: { Weekday: 5, Hour: 17, Minute: 0 },
    })

    expect(existsSync(plistPath)).toBe(true)
    const content = readFileSync(plistPath, 'utf-8')

    expect(content).toContain('StartCalendarInterval')
    expect(content).toContain('<integer>5</integer>')  // Weekday 5
    expect(content).toContain('<integer>17</integer>') // Hour 17
    expect(content).toContain('<integer>0</integer>')  // Minute 0
    expect(content).not.toContain('<key>StartInterval</key>')

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('installAlertReviewPlist uses ALERT_REVIEW_CRON env if set', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'alert-review-cron-env-'))
    const plistPath = join(tmpDir, 'com.threadwork.alert-review.plist')
    const runnerScript = join(tmpDir, 'runner.sh')

    const oldCron = process.env['ALERT_REVIEW_CRON']
    process.env['ALERT_REVIEW_CRON'] = '3 14:30'

    try {
      installAlertReviewPlist({ plistPath, runnerScript })
    } finally {
      if (oldCron === undefined) {
        delete process.env['ALERT_REVIEW_CRON']
      } else {
        process.env['ALERT_REVIEW_CRON'] = oldCron
      }
    }

    const content = readFileSync(plistPath, 'utf-8')
    expect(content).toContain('StartCalendarInterval')
    expect(content).toContain('<integer>3</integer>')  // Weekday 3 (Wednesday)
    expect(content).toContain('<integer>14</integer>') // Hour 14

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
