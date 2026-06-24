/**
 * C1.4 — Step 2 safeguard: agent_status.updated_at within 30s of the tick → interrupt SKIPPED.
 * Next tick with updated_at older than 30s → interrupt fires.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.4 — Step 2 safeguard: recent updated_at skips interrupt', () => {
  it('skips interrupt when agent_status.updated_at is within 30s, fires when older than 30s', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-safeguard-'))
    const interruptCalls: string[] = []

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async () => {},
      onInterruptAgent: async (t) => { interruptCalls.push(t) },
      onSendNote: async () => {},
    })

    const agent = 'sadie'
    const t0 = 3000000

    // Establish episode at t0
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    // Hit step 1
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    expect(interruptCalls.length).toBe(0)

    // Tick at 1800s but agent_status updated 25s ago → safeguard: SKIP
    const t1800 = t0 + 1800
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t1800 - 25 }, t1800)
    expect(interruptCalls.length).toBe(0)  // still step 1, not advanced

    const stateAfterSkip = JSON.parse(readFileSync(join(tmpDir, 'escalation.json'), 'utf-8'))
    expect(stateAfterSkip[agent].escalation_step).toBe(1)  // NOT advanced

    // Next tick: agent_status updated 35s ago → interrupt fires
    const t1830 = t0 + 1830
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t1830 - 35 }, t1830)
    expect(interruptCalls.length).toBe(1)

    const stateAfterFire = JSON.parse(readFileSync(join(tmpDir, 'escalation.json'), 'utf-8'))
    expect(stateAfterFire[agent].escalation_step).toBe(2)

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
