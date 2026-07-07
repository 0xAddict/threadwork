/**
 * tests/failure-classification-escalation-integration.test.ts — P6 Stage 5,
 * EPIC-03 integration coverage for the escalation bridge's additive
 * `onFailureClassified` DI seam (ATM-016/017).
 *
 * Mirrors the C1.11 all-paths-failed fixture pattern from
 * tests/escalation-bridge/all-paths-failed.test.ts (read for the exact
 * setup) — forces BOTH the MCP path and the SQLite fallback to fail, so the
 * bridge reaches its all-paths-failed branch, which:
 *   1. emits the unchanged "escalation bridge failed: agent=... step=...
 *      err=..." critical-Telegram message (byte-identical to pre-P6), then
 *   2. (P6 Stage 5 addition) invokes the injected onFailureClassified
 *      callback exactly once with a FailureClassification classified via
 *      fromEscalationBridgeAllPathsFailed -> classifyFailure
 *      (failure_class === 'infrastructure_transient').
 *
 * ATM-016: the happy-path wiring + the "no callback => no-op, no error"
 * case. ATM-017: (a) the EXISTING tests/escalation-bridge/all-paths-failed
 * .test.ts is run separately (unmodified) as part of the full P6 regression
 * pass — see the generator's final report; (b) fault-injection here — an
 * onFailureClassified that THROWS must not affect the critical-Telegram
 * emission or the bridge's own resolution.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EscalationBridge } from '../src/escalation-bridge/index'
import type { FailureClassification } from '../verification/failure-classification'

function makeFailingBridge(tmpDir: string, opts: {
  onCriticalTelegram: (msg: string) => Promise<void>
  onFailureClassified?: (c: FailureClassification) => Promise<void>
}): { bridge: EscalationBridge; agent: string; t0: number } {
  const bridge = new EscalationBridge({
    statePath: join(tmpDir, 'escalation.json'),
    auditLogPath: join(tmpDir, 'audit.log'),
    enabledPath: join(tmpDir, 'enabled.json'),
    lockPath: join(tmpDir, 'esc.lock'),
    esc1DelaySec: 600,
    esc2DelaySec: 1800,
    esc3DelaySec: 3600,
    onNudgeAgent: async () => { throw new Error('MCP unavailable') },
    onInterruptAgent: async () => {},
    onSendNote: async () => {},
    onCriticalTelegram: opts.onCriticalTelegram,
    onSqliteFallback: async () => { throw new Error('SQLite unavailable') },
    onFailureClassified: opts.onFailureClassified,
    retryBackoffMs: 1, // no 5s wait in tests
  })
  return { bridge, agent: 'kiera', t0: 10000000 }
}

describe('ATM-016: escalation bridge onFailureClassified wiring', () => {
  it('fires onFailureClassified EXACTLY ONCE with an infrastructure_transient classification when all paths fail', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-fc-atm016-'))
    const telegramMessages: string[] = []
    const classifications: FailureClassification[] = []

    const { bridge, agent, t0 } = makeFailingBridge(tmpDir, {
      onCriticalTelegram: async (msg) => { telegramMessages.push(msg) },
      onFailureClassified: async (c) => { classifications.push(c) },
    })

    // Establish episode at t0
    await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0)
    // Trigger step 1 (nudge) at t0+600 -> all paths fail -> critical Telegram + onFailureClassified
    await bridge.tick(agent, {
      classifierState: 'STUCK',
      reason_class: 'LOG_STALE',
      agent_status_updated_at: t0 - 200,
    }, t0 + 600)

    expect(telegramMessages.length).toBe(1)
    expect(telegramMessages[0]).toContain('escalation bridge failed')
    expect(telegramMessages[0]).toBe(`escalation bridge failed: agent=${agent} step=1 err=Error: SQLite unavailable`)

    expect(classifications.length).toBe(1)
    expect(classifications[0]!.failure_class).toBe('infrastructure_transient')
    expect(classifications[0]!.severity).toBe('critical')
    expect(classifications[0]!.transience).toBe('transient')
    expect(classifications[0]!.domain).toBe('infrastructure')
    expect(classifications[0]!.agent).toBe(agent)
    expect(classifications[0]!.signal_source).toBe('escalation_bridge_all_paths_failed')

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('the existing "escalation bridge failed: agent=... step=... err=..." message is byte-identical whether or not onFailureClassified is provided', async () => {
    const tmpDirA = mkdtempSync(join(tmpdir(), 'esc-fc-atm016-a-'))
    const tmpDirB = mkdtempSync(join(tmpdir(), 'esc-fc-atm016-b-'))
    const messagesA: string[] = []
    const messagesB: string[] = []

    const withCb = makeFailingBridge(tmpDirA, {
      onCriticalTelegram: async (msg) => { messagesA.push(msg) },
      onFailureClassified: async () => {},
    })
    const withoutCb = makeFailingBridge(tmpDirB, {
      onCriticalTelegram: async (msg) => { messagesB.push(msg) },
      // onFailureClassified intentionally omitted
    })

    await withCb.bridge.tick(withCb.agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: withCb.t0 - 200 }, withCb.t0)
    await withCb.bridge.tick(withCb.agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: withCb.t0 - 200 }, withCb.t0 + 600)

    await withoutCb.bridge.tick(withoutCb.agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: withoutCb.t0 - 200 }, withoutCb.t0)
    await withoutCb.bridge.tick(withoutCb.agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: withoutCb.t0 - 200 }, withoutCb.t0 + 600)

    expect(messagesA).toEqual(messagesB)
    expect(messagesA[0]).toBe('escalation bridge failed: agent=kiera step=1 err=Error: SQLite unavailable')

    withCb.bridge.destroy()
    withoutCb.bridge.destroy()
    rmSync(tmpDirA, { recursive: true, force: true })
    rmSync(tmpDirB, { recursive: true, force: true })
  })

  it('constructing WITHOUT onFailureClassified is a complete no-op inside the bridge — no behavior change, no error', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-fc-atm016-noop-'))
    const telegramMessages: string[] = []
    const { bridge, agent, t0 } = makeFailingBridge(tmpDir, {
      onCriticalTelegram: async (msg) => { telegramMessages.push(msg) },
    })

    let threw = false
    try {
      await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0)
      await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(telegramMessages.length).toBe(1)

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// ATM-017(b): fault-injection — a THROWING onFailureClassified must not
// affect the critical-Telegram emission or the bridge's own resolution.
// ATM-017(a) — the pre-existing tests/escalation-bridge/all-paths-failed
// .test.ts is run UNMODIFIED as part of the full regression pass; see the
// generator's final report for its pass/fail counts.
// ---------------------------------------------------------------------------
describe('ATM-017(b): fault-injection — throwing onFailureClassified', () => {
  it('a throwing onFailureClassified still lets the critical-Telegram call fire with the unchanged message, and tick() resolves without throwing', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'esc-fc-atm017b-'))
    const telegramMessages: string[] = []
    const { bridge, agent, t0 } = makeFailingBridge(tmpDir, {
      onCriticalTelegram: async (msg) => { telegramMessages.push(msg) },
      onFailureClassified: async () => { throw new Error('onFailureClassified boom') },
    })

    let threw = false
    let thrownErr: unknown = null
    try {
      await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0)
      await bridge.tick(agent, { classifierState: 'STUCK', reason_class: 'LOG_STALE', agent_status_updated_at: t0 - 200 }, t0 + 600)
    } catch (err) {
      threw = true
      thrownErr = err
    }

    expect(threw).toBe(false)
    expect(thrownErr).toBeNull()
    expect(telegramMessages.length).toBe(1)
    expect(telegramMessages[0]).toBe('escalation bridge failed: agent=kiera step=1 err=Error: SQLite unavailable')

    bridge.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
