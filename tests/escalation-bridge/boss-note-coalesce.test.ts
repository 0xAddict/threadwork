/**
 * C1.6 — Boss-note coalesce: agent STUCK 4000s → exactly ONE step-3 note per episode;
 * subsequent STUCK after recovery generates a NEW note.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.6 — Boss note coalesce: one note per episode', () => {
  it('produces exactly one step-3 note per continuous STUCK episode', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-coalesce-'))
    const noteCalls: string[] = []

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
      onSendNote: async (_taskId, msg) => { noteCalls.push(msg) },
    })

    const agent = 'steve'
    const t0 = 5000000

    // Establish episode at t0
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0)
    // Progress through all 3 steps
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0 + 1800)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0 + 3600)
    expect(noteCalls.length).toBe(1)

    // Additional STUCK ticks (4000s, 5000s) — should NOT produce additional notes
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0 + 4000)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0 + 5000)
    expect(noteCalls.length).toBe(1)  // Still exactly one

    // Recovery: agent becomes ALIVE
    await bridge.tick(agent, { classifierState: 'ALIVE', reason_class: 'LOG_STALE', agent_status_updated_at: t0 + 5000 }, t0 + 5010)

    // New STUCK episode — establish at t1, then progress through steps
    const t1 = t0 + 6000
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t1 - 200 }, t1)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t1 - 200 }, t1 + 600)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t1 - 200 }, t1 + 1800)
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t1 - 200 }, t1 + 3600)
    expect(noteCalls.length).toBe(2)  // New episode generates a new note

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
