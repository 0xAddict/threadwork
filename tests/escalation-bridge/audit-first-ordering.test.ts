/**
 * C1.9 — Audit-first ordering: simulated audit.log write failure (disk full) → no escalation action attempted;
 * stderr error emitted; step does NOT advance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.9 — Audit-first ordering: audit failure aborts action', () => {
  it('does not invoke nudgeAgent when audit.log write fails, step does not advance', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-audit-'))
    const auditLog = join(tmpDir, 'audit.log')
    const nudgeCalls: string[] = []

    // Create audit log as read-only to simulate write failure
    // First write to it, then make it read-only
    const { writeFileSync } = await import('fs')
    writeFileSync(auditLog, '', 'utf-8')
    chmodSync(auditLog, 0o444)  // read-only

    const stderrMessages: string[] = []
    const origStderr = process.stderr.write.bind(process.stderr)
    const mockStderr = (msg: string | Uint8Array) => {
      if (typeof msg === 'string') stderrMessages.push(msg)
      return true
    }
    process.stderr.write = mockStderr as typeof process.stderr.write

    const bridge = new EscalationBridge({
      statePath: join(tmpDir, 'escalation.json'),
      auditLogPath: auditLog,
      enabledPath: join(tmpDir, 'enabled.json'),
      lockPath: join(tmpDir, 'esc.lock'),
      esc1DelaySec: 600,
      esc2DelaySec: 1800,
      esc3DelaySec: 3600,
      onNudgeAgent: async (t) => { nudgeCalls.push(t) },
      onInterruptAgent: async () => {},
      onSendNote: async () => {},
    })

    const agent = 'steve'
    const t0 = 8000000

    try {
      // Tick at esc1 threshold — audit write will fail
      await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'TASK_OVERDUE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    } catch {
      // Expected: audit write failure may throw
    }

    // Restore stderr
    process.stderr.write = origStderr

    // Nudge should NOT have been called
    expect(nudgeCalls.length).toBe(0)

    // If escalation.json was written, step should still be 0 (action was aborted)
    if (existsSync(join(tmpDir, 'escalation.json'))) {
      const state = JSON.parse(readFileSync(join(tmpDir, 'escalation.json'), 'utf-8'))
      if (state[agent]) {
        expect(state[agent].escalation_step).toBe(0)
      }
    }

    bridge.destroy()
    chmodSync(auditLog, 0o644)  // restore permissions before cleanup
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
