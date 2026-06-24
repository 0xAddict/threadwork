/**
 * C1.10 — MCP-down → SQLite fallback path executes; audit.log records bridge_method=sqlite_fallback
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.10 — MCP-down → SQLite fallback path', () => {
  it('uses SQLite fallback when MCP fails, audit.log shows bridge_method=sqlite_fallback', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-sqlite-'))
    let nudgeMcpAttempts = 0

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: join(tmpDir, 'audit.log'),
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async () => {
        nudgeMcpAttempts++
        throw new Error('MCP unavailable')
      },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
      retryBackoffMs: 1,  // no 5s wait in tests
    })

    const agent = 'boss'
    const t0 = 9000000

    // Establish episode at t0
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0)
    // Trigger step 1 at t0+600
    await bridge.tick(agent, {
      classifierState: 'STUCK',
      reason_class: 'TASK_OVERDUE',
      agent_status_updated_at: t0 - 200,
    }, t0 + 600)

    // MCP was attempted (3 retries)
    expect(nudgeMcpAttempts).toBe(3)

    // Audit log should contain sqlite_fallback entry
    const auditContent = readFileSync(join(tmpDir, 'audit.log'), 'utf-8')
    const lines = auditContent.trim().split('\n').filter(Boolean)
    const fallbackEntry = lines.find(l => {
      try {
        const e = JSON.parse(l)
        return e.bridge_method === 'sqlite_fallback'
      } catch { return false }
    })
    expect(fallbackEntry).toBeTruthy()

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
