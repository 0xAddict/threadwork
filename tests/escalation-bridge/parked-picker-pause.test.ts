/**
 * C1.8 — PARKED_PICKER pause: agent in PARKED_PICKER for 30 min (over esc1 threshold) → NO escalation fires;
 * transition to STUCK → timer continues; after additional 600s of STUCK, nudge fires.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.8 — PARKED_PICKER pause and STUCK continuation', () => {
  it('does not escalate while PARKED_PICKER, fires nudge after 600s of STUCK post-park', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-parked-'))
    const nudgeCalls: string[] = []
    const interruptCalls: string[] = []

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t) => { nudgeCalls.push(t) },
      onInterruptAgent: async (t) => { interruptCalls.push(t) },
      onSendNote: async () => {},
    })

    const agent = 'sadie'
    const t0 = 7000000

    // Agent in PARKED_PICKER for 30 minutes (1800s) — way over esc1 threshold
    for (let i = 0; i < 6; i++) {
      await bridge.tick(agent, { classifierState: 'PARKED_PICKER', reason_class: 'PICKER_PARK', agent_status_updated_at: t0 - 200 }, t0 + i * 300)
    }
    // 30 min in PARKED_PICKER → NO escalation
    expect(nudgeCalls.length).toBe(0)
    expect(interruptCalls.length).toBe(0)

    // Now transitions to STUCK
    // Per DoD-07 §4: "Any non-STUCK classifier output (incl. PARKED_PICKER/PARKED_PICKER_STALE) resets continuous duration"
    // Wait: DoD-07 §5 says PARKED_PICKER suspends timer, not resets.
    // But §4 says non-STUCK resets. The §5 PARKED_PICKER exception overrides §4 for PARKED_PICKER specifically.
    // So from PARKED_PICKER → STUCK, timer continues from 0 (episode starts fresh when PARKED_PICKER exits)
    // Actually, re-reading: §5 says "timer is suspended (current duration not advanced) but state retained"
    // "When agent re-enters STUCK explicitly, timer continues from where it paused,
    //  UNLESS the intervening state was a non-STUCK other than PARKED_PICKER (which resets)."
    // So after PARKED_PICKER, we continue from T0 (where we started accumulating STUCK time).
    // But here the agent was PARKED_PICKER from the START (never had STUCK time accumulated).
    // So episode start = null, accumulated = 0. Timer starts fresh on first STUCK tick.

    const tStuck = t0 + 2000
    // First STUCK tick — episode starts
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: tStuck - 200 }, tStuck)
    expect(nudgeCalls.length).toBe(0)

    // 599s of STUCK — no nudge yet
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: tStuck - 200 }, tStuck + 599)
    expect(nudgeCalls.length).toBe(0)

    // 600s of STUCK — nudge fires
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: tStuck - 200 }, tStuck + 600)
    expect(nudgeCalls.length).toBe(1)
    expect(nudgeCalls[0]).toBe(agent)

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
