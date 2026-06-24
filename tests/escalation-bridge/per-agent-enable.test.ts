/**
 * C1.13 — Per-agent enable list: agent removed from `escalation-enabled.json` →
 * no escalation fires regardless of state; default behavior with no list file = all agents enabled.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.13 — Per-agent enable list', () => {
  it('does not escalate agent removed from enabled list', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-enable-'))
    const nudgeCalls: string[] = []

    // Write enabled list with only 'boss' (not 'steve')
    const enabledJson = join(tmpDir, 'enabled.json')
    writeFileSync(enabledJson, JSON.stringify({ enabled_agents: ['boss'] }), 'utf-8')

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: enabledJson,
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t) => { nudgeCalls.push(t) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    const t0 = 12000000

    // 'steve' is NOT in enabled list → no escalation (even with 2 ticks)
    await bridge.tick('steve', { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    await bridge.tick('steve', { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    expect(nudgeCalls.length).toBe(0)

    // 'boss' IS in enabled list → escalation fires
    await bridge.tick('boss', { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    await bridge.tick('boss', { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    expect(nudgeCalls.length).toBe(1)
    expect(nudgeCalls[0]).toBe('boss')

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('enables all agents when no enabled list file exists', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-enable-default-'))
    const nudgeCalls: string[] = []

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),  // file does not exist
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t) => { nudgeCalls.push(t) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    const t0 = 13000000
    await bridge.tick('any-agent', { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    await bridge.tick('any-agent', { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    expect(nudgeCalls.length).toBe(1)

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
