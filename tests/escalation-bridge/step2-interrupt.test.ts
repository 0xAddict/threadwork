/**
 * C1.3 — Agent STUCK continuously for esc2_delay (default 1800s) → interruptAgent invoked; escalation.json step=2
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.3 — Step 2 interrupt fires at esc2_delay', () => {
  it('invokes interruptAgent after 1800s STUCK and escalation.json shows step=2', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-step2-'))
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

    const interruptCalls: string[] = []
    const agent = 'kiera'
    const t0 = 2000000

    // Establish episode at t0
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TMUX_DEAD', agent_status_updated_at: t0 - 200 }, t0)
    // Hit step 1 first (600s)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TMUX_DEAD', agent_status_updated_at: t0 - 200 }, t0 + 600)

    // Now at 1800s: interrupt should fire
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TMUX_DEAD', agent_status_updated_at: t0 - 200 }, t0 + 1800)

    expect(interruptCalls.length).toBe(1)
    expect(interruptCalls[0]).toBe(agent)

    const state = JSON.parse(readFileSync(join(tmpDir, 'escalation.json'), 'utf-8'))
    expect(state[agent].escalation_step).toBe(2)

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
