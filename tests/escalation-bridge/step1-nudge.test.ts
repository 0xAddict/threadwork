/**
 * C1.2 — STUCK continuously for esc1_delay (default 600s) → nudgeAgent invoked with exact template;
 * escalation.json shows step=1; audit.log has the matching entry.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.2 — Step 1 nudge fires at esc1_delay', () => {
  it('invokes nudgeAgent with exact template after 600s STUCK, escalation.json step=1, audit.log entry present', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-step1-'))
    const escalationJson = join(tmpDir, 'escalation.json')
    const auditLog = join(tmpDir, 'escalation.audit.log')
    const enabledJson = join(tmpDir, 'escalation-enabled.json')

    const nudgeCalls: Array<{ target: string; message: string }> = []
    const interruptCalls: string[] = []
    const sendNoteCalls: string[] = []

    const bridge = new EscalationBridge({
      statePath: escalationJson,
      auditLogPath: auditLog,
      enabledPath: enabledJson,
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (target: string, message: string) => {
        nudgeCalls.push({ target, message })
      },
      onInterruptAgent: async (target: string) => {
        interruptCalls.push(target)
      },
      onSendNote: async (taskId: string, message: string) => {
        sendNoteCalls.push(message)
      },
    })

    const agentName = 'steve'
    const t0 = 1000000

    // Tick at T0: agent becomes STUCK
    await bridge.tick(agentName, {
      classifierState: 'STUCK',
      reason_class: 'TASK_OVERDUE',
      last_status_text: 'working on task 42',
      agent_status_updated_at: t0 - 100,
    }, t0)

    // No nudge yet (only 0s elapsed)
    expect(nudgeCalls.length).toBe(0)

    // Tick at T0+599s: just below threshold
    await bridge.tick(agentName, {
      classifierState: 'STUCK',
      reason_class: 'TASK_OVERDUE',
      last_status_text: 'working on task 42',
      agent_status_updated_at: t0 - 100,
    }, t0 + 599)

    expect(nudgeCalls.length).toBe(0)

    // Tick at T0+600s: threshold met
    await bridge.tick(agentName, {
      classifierState: 'STUCK',
      reason_class: 'TASK_OVERDUE',
      last_status_text: 'working on task 42',
      agent_status_updated_at: t0 - 100,
    }, t0 + 600)

    // Nudge should have fired
    expect(nudgeCalls.length).toBe(1)
    expect(nudgeCalls[0].target).toBe(agentName)

    // Verify exact template format
    const msg = nudgeCalls[0].message
    expect(msg).toContain('[heartbeat-v2 auto-escalation: step 1/3]')
    expect(msg).toContain('TASK_OVERDUE')
    expect(msg).toContain('working on task 42')
    expect(msg).toContain('Please respond: write_status()')

    // Verify escalation.json step=1
    const state = JSON.parse(readFileSync(escalationJson, 'utf-8'))
    expect(state[agentName].escalation_step).toBe(1)

    // Verify audit log entry exists
    expect(existsSync(auditLog)).toBe(true)
    const auditContent = readFileSync(auditLog, 'utf-8')
    const auditLines = auditContent.trim().split('\n').filter(Boolean)
    const auditEntry = JSON.parse(auditLines[auditLines.length - 1])
    expect(auditEntry.agent).toBe(agentName)
    expect(auditEntry.step).toBe(1)
    expect(auditEntry.action).toBe('nudge')

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
