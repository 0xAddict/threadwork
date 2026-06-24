/**
 * C1.12 — Multi-instance flock: second heartbeat-v2 instance refuses to write escalation actions;
 * only one set of actions occurs per tick.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.12 — Multi-instance flock', () => {
  it('second bridge instance refuses to perform escalation actions', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-flock-'))
    const nudgeCallsA: string[] = []
    const nudgeCallsB: string[] = []
    const sharedLock = join(tmpDir, 'shared.lock')

    // Instance A: acquires lock
    const bridgeA = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: sharedLock,
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t) => { nudgeCallsA.push(t) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    // Instance B: should fail to acquire lock (same lockPath)
    const bridgeB = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: sharedLock,  // same lock
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t) => { nudgeCallsB.push(t) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    const agent = 'steve'
    const t0 = 11000000

    // Establish episode at t0 (both instances)
    await bridgeA.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    await bridgeB.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    // Both tick at threshold
    await bridgeA.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    await bridgeB.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)

    // Only instance A (which holds lock) should have nudged
    expect(nudgeCallsA.length).toBe(1)
    expect(nudgeCallsB.length).toBe(0)  // B refused

    bridgeA.destroy()
    bridgeB.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
