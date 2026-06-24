/**
 * C1.11 — MCP AND SQLite both fail 3× with 5s backoff → critical Telegram emits with prefix "escalation bridge failed";
 * failure is non-deduped.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../../src/escalation-bridge/index'

describe('C1.11 — All paths failed → critical Telegram', () => {
  it('emits "escalation bridge failed" critical Telegram when both MCP and SQLite fail', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-allfail-'))
    const telegramMessages: string[] = []
    let nudgeMcpAttempts = 0
    let sqliteAttempts = 0

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
      onCriticalTelegram: async (msg) => { telegramMessages.push(msg) },
      onSqliteFallback: async () => {
        sqliteAttempts++
        throw new Error('SQLite unavailable')
      },
      retryBackoffMs: 1,  // no 5s wait in tests
    })

    const agent = 'kiera'
    const t0 = 10000000

    // Establish episode at t0
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0)
    // Trigger step 1 at t0+600
    await bridge.tick(agent, {
      classifierState: 'STUCK',
      reason_class: 'LOG_STALE',
      agent_status_updated_at: t0 - 200,
    }, t0 + 600)

    // MCP was attempted 3 times
    expect(nudgeMcpAttempts).toBe(3)
    // SQLite was attempted
    expect(sqliteAttempts).toBe(1)

    // Critical Telegram should have been sent
    expect(telegramMessages.length).toBeGreaterThan(0)
    const msg = telegramMessages.join('\n')
    expect(msg).toContain('escalation bridge failed')

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
