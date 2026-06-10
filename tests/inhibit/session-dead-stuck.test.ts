/**
 * C1.1 — TDD test (written BEFORE implementation per C0.3 discipline)
 *
 * Asserts: SESSION_DEAD alert with equal_labels=[session] rule suppresses
 * all 4 STUCK alerts that share the same session. Each suppression must be
 * logged to inhibit.log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { InhibitionEngine, type AlertLabel, type InhibitRule } from '../../inhibit-engine'

describe('C1.1 — SESSION_DEAD→STUCK inhibition with equal=[session]', () => {
  let tmpDir: string
  let inhibitLogPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inhibit-test-'))
    inhibitLogPath = join(tmpDir, 'inhibit.log')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('suppresses all 4 STUCK alerts when SESSION_DEAD fires on same session', () => {
    const engine = new InhibitionEngine({
      rulesPath: null,
      inhibitLogPath,
    })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const alerts: AlertLabel[] = [
      // 1 SESSION_DEAD (source)
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      // 4 STUCK (targets — same session as SESSION_DEAD)
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    const result = engine.applyInhibition(alerts, rules)

    // SESSION_DEAD should survive (it's the source, not the target)
    expect(result.survivors.length).toBe(1)
    expect(result.survivors[0].state).toBe('SESSION_DEAD')

    // All 4 STUCK should be suppressed
    expect(result.suppressed.length).toBe(4)
    expect(result.suppressed.every(a => a.state === 'STUCK')).toBe(true)

    // Suppressed by the correct rule
    expect(result.suppressedByRule.has('session-dead-inhibits-stuck')).toBe(true)
    expect(result.suppressedByRule.get('session-dead-inhibits-stuck')!.length).toBe(4)
  })

  it('logs all 4 suppressions to inhibit.log', () => {
    const engine = new InhibitionEngine({
      rulesPath: null,
      inhibitLogPath,
    })

    const rules: InhibitRule[] = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    engine.applyInhibition(alerts, rules)

    // inhibit.log must exist and have 4 suppression entries
    expect(existsSync(inhibitLogPath)).toBe(true)
    const logContents = readFileSync(inhibitLogPath, 'utf-8')
    const lines = logContents.trim().split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(4)

    // Each line should contain rule_id and state=STUCK
    for (const line of lines) {
      expect(line).toContain('rule_id=session-dead-inhibits-stuck')
      expect(line).toContain('state=STUCK')
    }
  })
})
