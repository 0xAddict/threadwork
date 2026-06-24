/**
 * C1.5 — Agent STUCK continuously for esc3_delay (default 3600s) → Boss task-board note; escalation.json step=3
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.5 — Step 3 Boss note fires at esc3_delay', () => {
  it('creates Boss task-board note after 3600s STUCK, escalation.json step=3', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-step3-'))
    const noteCalls: Array<{ taskId: string; msg: string }> = []

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async () => {},
      onInterruptAgent: async () => {},
      onSendNote: async (taskId, msg) => { noteCalls.push({ taskId, msg }) },
    })

    const agent = 'boss'
    const t0 = 4000000

    // Establish episode at t0
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    // Fire step 1
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    // Fire step 2
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 1800)
    // Fire step 3
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 3600)

    expect(noteCalls.length).toBe(1)
    expect(noteCalls[0].msg).toContain('escalation step 3/3')
    expect(noteCalls[0].msg).toContain(agent)

    const state = JSON.parse(readFileSync(join(tmpDir, 'escalation.json'), 'utf-8'))
    expect(state[agent].escalation_step).toBe(3)

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
