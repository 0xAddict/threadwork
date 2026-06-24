/**
 * C1.14 — Nudge template renders correctly when `last_status` is empty/null:
 * substitutes the literal string `(none)` and does not crash.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.14 — Nudge template with empty/null last_status', () => {
  it('renders (none) when last_status_text is null', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-template-null-'))
    const nudgeCalls: Array<{ target: string; message: string }> = []

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t, m) => { nudgeCalls.push({ target: t, message: m }) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    const t0 = 14000000
    await bridge.tick('boss', { classifierState: 'STUCK', reason_class: 'TMUX_DEAD', last_status_text: null, agent_status_updated_at: t0 - 200 }, t0)
    await bridge.tick('boss', {
      classifierState: 'STUCK',
      reason_class: 'TMUX_DEAD',
      last_status_text: null,
      agent_status_updated_at: t0 - 200,
    }, t0 + 600)

    expect(nudgeCalls.length).toBe(1)
    expect(nudgeCalls[0].message).toContain('(none)')
    expect(nudgeCalls[0].message).not.toContain('null')
    expect(nudgeCalls[0].message).not.toContain('undefined')

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('renders (none) when last_status_text is empty string', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-template-empty-'))
    const nudgeCalls: Array<{ target: string; message: string }> = []

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t, m) => { nudgeCalls.push({ target: t, message: m }) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    const t0 = 15000000
    await bridge.tick('steve', { classifierState: 'STUCK', reason_class: 'LOG_STALE', last_status_text: '', agent_status_updated_at: t0 - 200 }, t0)
    await bridge.tick('steve', {
      classifierState: 'STUCK',
      reason_class: 'LOG_STALE',
      last_status_text: '',
      agent_status_updated_at: t0 - 200,
    }, t0 + 600)

    expect(nudgeCalls.length).toBe(1)
    expect(nudgeCalls[0].message).toContain('(none)')

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
