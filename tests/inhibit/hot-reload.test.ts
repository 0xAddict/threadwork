/**
 * C1.3 — Hot-reload: edit inhibit_rules.json mid-run, next tick reflects new rule (no restart)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { InhibitionEngine, type AlertLabel } from '../../inhibit-engine'

describe('C1.3 — Hot-reload of inhibit_rules.json', () => {
  let tmpDir: string
  let rulesPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inhibit-hot-reload-'))
    rulesPath = join(tmpDir, 'inhibit_rules.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('picks up a new rule written mid-run without restart', async () => {
    // Start with empty rules
    writeFileSync(rulesPath, JSON.stringify([]))

    const engine = new InhibitionEngine({ rulesPath, inhibitLogPath: null })

    const alerts: AlertLabel[] = [
      { agent: 'boss', session: 'claude-boss', state: 'SESSION_DEAD', reason_class: 'TMUX_DEAD', host: 'macbook' },
      { agent: 'boss', session: 'claude-boss', state: 'STUCK', reason_class: 'TASK_OVERDUE', host: 'macbook' },
    ]

    // Tick 1: no rules — both alerts survive
    const result1 = engine.applyInhibition(alerts)
    expect(result1.survivors.length).toBe(2)
    expect(result1.suppressed.length).toBe(0)

    // Simulate editor writing new rules (with sleep to ensure different mtime)
    await new Promise(r => setTimeout(r, 50))
    const newRules = [{
      id: 'session-dead-inhibits-stuck',
      source_match: { state: 'SESSION_DEAD' },
      target_match: { state: 'STUCK' },
      equal_labels: ['session'],
    }]
    // Use different mtime by touching the file with new content
    writeFileSync(rulesPath, JSON.stringify(newRules))

    // Tick 2: new rule should be picked up without restart
    const result2 = engine.applyInhibition(alerts)
    expect(result2.survivors.length).toBe(1)
    expect(result2.survivors[0].state).toBe('SESSION_DEAD')
    expect(result2.suppressed.length).toBe(1)
    expect(result2.suppressed[0].state).toBe('STUCK')
  })
})
