/**
 * C1.7 — Episode reset: STUCK 600s (nudge fired) → ALIVE 1 tick → STUCK again →
 * new episode must run another 600s before nudge re-fires.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.7 — Episode reset on ALIVE transition', () => {
  it('resets episode on non-STUCK state; new STUCK episode must wait full esc1_delay again', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-reset-'))
    const nudgeCalls: string[] = []

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (_t, _m) => { nudgeCalls.push(_t) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    const agent = 'kiera'
    const t0 = 6000000

    // First episode: establish at t0, nudge fires at 600s
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    expect(nudgeCalls.length).toBe(1)

    // Recovery: ALIVE
    await bridge.tick(agent, { classifierState: 'ALIVE', reason_class: 'OK', agent_status_updated_at: t0 + 601 }, t0 + 601)

    // Second episode starts at t1
    const t1 = t0 + 700
    // Establish second episode at t1
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t1 - 200 }, t1)
    // 599s into second episode → should NOT nudge yet
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t1 - 200 }, t1 + 599)
    expect(nudgeCalls.length).toBe(1)  // No new nudge

    // 600s into second episode → nudge fires again
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t1 - 200 }, t1 + 600)
    expect(nudgeCalls.length).toBe(2)

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
