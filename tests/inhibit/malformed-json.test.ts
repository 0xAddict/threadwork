/**
 * C1.4 — Malformed JSON: zero inhibitions, stderr error, non-deduped Telegram meta-alert
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { InhibitionEngine, type AlertLabel } from '../../inhibit-engine'

describe('C1.4 — Malformed inhibit_rules.json', () => {
  let tmpDir: string
  let rulesPath: string
  let metaAlerts: Array<{ msg: string; ruleId: string; count: number }>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inhibit-malformed-'))
    rulesPath = join(tmpDir, 'inhibit_rules.json')
    metaAlerts = []
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('produces zero inhibitions and fires meta-alert when rules file is malformed', () => {
    // Write malformed JSON
    writeFileSync(rulesPath, '{"broken": [unclosed array')

    const engine = new InhibitionEngine({
      rulesPath,
      inhibitLogPath: null,
      metaAlertCallback: (msg, ruleId, count) => {
        metaAlerts.push({ msg, ruleId, count })
      },
    })

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // Force reload attempt by making the engine attempt to read the file
    // (rules are empty/defaults since file is malformed at construct time)
    const result = engine.applyInhibition(alerts)

    // Zero inhibitions (malformed rules = no rules)
    expect(result.suppressed.length).toBe(0)
    expect(result.survivors.length).toBe(2)

    // Meta-alert must have been fired
    expect(metaAlerts.length).toBeGreaterThanOrEqual(1)
    const hasRulesInvalidAlert = metaAlerts.some(a =>
      a.msg.includes('invalid') || a.msg.includes('Failed to reload') || a.ruleId === 'meta:rules-invalid'
    )
    expect(hasRulesInvalidAlert).toBe(true)
  })

  it('writes error to stderr when rules file is malformed', () => {
    writeFileSync(rulesPath, '{not valid json}')

    // Capture stderr
    const stderrLines: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr as any).write = (data: string | Buffer) => {
      stderrLines.push(typeof data === 'string' ? data : data.toString())
      return true
    }

    try {
      const engine = new InhibitionEngine({ rulesPath, inhibitLogPath: null })
      const alerts: AlertLabel[] = [
        { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      ]
      engine.applyInhibition(alerts)
    } finally {
      ;(process.stderr as any).write = origWrite
    }

    const hasErrorLine = stderrLines.some(l => l.includes('Failed to reload') || l.includes('invalid') || l.includes('WARN'))
    expect(hasErrorLine).toBe(true)
  })
})
