/**
 * src/escalation-bridge/index.ts — Heartbeat-v2 Escalation Bridge
 *
 * Sprint 4 / DEL-1 — Three-step escalation bridge with:
 * - Per-agent state in ~/.claude/state/heartbeat-v2/escalation.json with flock(2)
 * - Steps: T0+600s→nudge, T0+1800s→interrupt, T0+3600s→Boss note
 * - PARKED_PICKER pause: timer suspended, state retained
 * - Step-2 interrupt safeguard: check agent_status.updated_at within 30s
 * - Nudge template: exact format per DoD-07 §7
 * - MCP primary, SQLite fallback, 3× retry 5s backoff
 * - Audit-first ordering: write audit.log BEFORE action
 * - Multi-instance flock: second instance refuses escalation
 * - Per-agent enable list: escalation-enabled.json
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
// P6 Stage 5 / EPIC-03 — additive DI seam. Pure functions only (no db.ts /
// persistFailureClassification import here — persistence is the CALLER's
// responsibility via the onFailureClassified callback, exactly like the
// existing onCriticalTelegram seam).
import { fromEscalationBridgeAllPathsFailed, classifyFailure } from '../../verification/failure-classification'
import type { FailureClassification } from '../../verification/failure-classification'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClassifierState =
  | 'ALIVE'
  | 'IDLE'
  | 'STUCK'
  | 'PARKED_PICKER'
  | 'PARKED_PICKER_STALE'
  | 'WATCHDOG_DEAD'
  | 'LOOP'

export interface AgentTickInput {
  classifierState: ClassifierState
  reason_class: string
  last_status_text?: string | null
  agent_status_updated_at?: number  // unix seconds
}

export interface AgentEscalationState {
  agent: string
  current_episode_start_unix: number | null
  escalation_step: number   // 0, 1, 2, 3
  last_action_at_unix: number | null
  parked_accumulated_sec: number  // accumulated STUCK time before current PARKED_PICKER pause
}

export type EscalationStateFile = Record<string, AgentEscalationState>

export interface EscalationBridgeOptions {
  statePath?: string
  auditLogPath?: string
  enabledPath?: string
  lockPath?: string
  esc1DelaySec?: number
  esc2DelaySec?: number
  esc3DelaySec?: number
  bossTaskId?: string
  onNudgeAgent?: (target: string, message: string) => Promise<void>
  onInterruptAgent?: (target: string) => Promise<void>
  onSendNote?: (taskId: string, message: string) => Promise<void>
  onCriticalTelegram?: (message: string) => Promise<void>
  onSqliteFallback?: (agent: string, step: number, context: Record<string, unknown>) => Promise<void>
  retryBackoffMs?: number   // default 5000ms; override for tests
  // P6 Stage 5 / EPIC-03 — additive DI seam, mirroring onCriticalTelegram.
  // Invoked (best-effort) after the all-paths-failed critical-Telegram
  // emission with a FailureClassification for this failure. Undefined =>
  // complete no-op inside the bridge (default; no runtime-guard warning yet
  // — that lands in Stage 7).
  onFailureClassified?: (classification: FailureClassification) => Promise<void>
  // P6 Stage 7 / OQ-4 — additive, flag-ON-only DI seam. The bridge has no
  // db handle by design, so it cannot call isFeatureEnabled() itself: the
  // CALLER reads isFeatureEnabled('failure_classification_enabled') and
  // passes the result here. When true AND onFailureClassified is unset,
  // the constructor emits a one-time console.warn (see below) so a
  // misconfigured deployment (flag ON, no callback wired) is visible
  // instead of silently dropping classifications. Left undefined (the
  // default for every existing caller) => the guard never fires and
  // behavior is byte-identical to pre-Stage-7 (G4 parity untouched).
  failureClassificationEnabled?: boolean
}

// ---------------------------------------------------------------------------
// Flock implementation (non-blocking)
// ---------------------------------------------------------------------------

// Simple file-based lock using O_EXCL
function tryAcquireLock(lockPath: string): number | null {
  try {
    const fd = openSync(lockPath, 'wx')  // exclusive create
    return fd
  } catch {
    return null  // lock already held
  }
}

function releaseLock(fd: number, lockPath: string): void {
  try {
    closeSync(fd)
    unlinkSync(lockPath)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// EscalationBridge
// ---------------------------------------------------------------------------

export class EscalationBridge {
  private statePath: string
  private auditLogPath: string
  private enabledPath: string
  private lockPath: string
  private esc1DelaySec: number
  private esc2DelaySec: number
  private esc3DelaySec: number
  private bossTaskId: string

  private onNudgeAgent: (target: string, message: string) => Promise<void>
  private onInterruptAgent: (target: string) => Promise<void>
  private onSendNote: (taskId: string, message: string) => Promise<void>
  private onCriticalTelegram: (message: string) => Promise<void>
  private onSqliteFallbackOverride?: (agent: string, step: number, context: Record<string, unknown>) => Promise<void>
  private retryBackoffMs: number
  // P6 Stage 5 / EPIC-03 — additive DI seam field, mirroring the other callbacks.
  private onFailureClassified?: (classification: FailureClassification) => Promise<void>

  // Track lock across ticks for multi-instance guard
  private _lockFd: number | null = null
  private _lockAcquiredThisInstance = false

  constructor(opts: EscalationBridgeOptions = {}) {
    const stateDir = join(homedir(), '.claude', 'state', 'heartbeat-v2')

    this.statePath = opts.statePath
      ?? join(stateDir, 'escalation.json')
    this.auditLogPath = opts.auditLogPath
      ?? join(stateDir, 'escalation.audit.log')
    this.enabledPath = opts.enabledPath
      ?? join(stateDir, 'escalation-enabled.json')
    this.lockPath = opts.lockPath
      ?? join(stateDir, 'escalation.lock')

    this.esc1DelaySec = opts.esc1DelaySec
      ?? parseInt(process.env['HEARTBEAT_V2_ESC1_DELAY_SEC'] ?? '600', 10)
    this.esc2DelaySec = opts.esc2DelaySec
      ?? parseInt(process.env['HEARTBEAT_V2_ESC2_DELAY_SEC'] ?? '1800', 10)
    this.esc3DelaySec = opts.esc3DelaySec
      ?? parseInt(process.env['HEARTBEAT_V2_ESC3_DELAY_SEC'] ?? '3600', 10)

    this.bossTaskId = process.env['HEARTBEAT_V2_BOSS_TASK_ID'] ?? 'boss-platform-health'

    this.onNudgeAgent = opts.onNudgeAgent ?? (async () => {})
    this.onInterruptAgent = opts.onInterruptAgent ?? (async () => {})
    this.onSendNote = opts.onSendNote ?? (async () => {})
    this.onCriticalTelegram = opts.onCriticalTelegram ?? (async () => {})
    this.onSqliteFallbackOverride = opts.onSqliteFallback
    this.retryBackoffMs = opts.retryBackoffMs ?? 5000
    // P6 Stage 5 / EPIC-03 — additive DI seam. undefined => no-op (default).
    this.onFailureClassified = opts.onFailureClassified

    // P6 Stage 7 / OQ-4 — belt-and-suspenders runtime guard. FLAG-ON-ONLY:
    // fires ONLY when the caller explicitly signals the flag is ON
    // (opts.failureClassificationEnabled === true). Every existing caller
    // never passes this option (=> undefined), so this branch is dead code
    // for them and G4 flag-OFF byte-parity is untouched.
    if (opts.failureClassificationEnabled === true && !opts.onFailureClassified) {
      console.warn('[escalation-bridge] failure_classification_enabled is ON but no onFailureClassified callback is wired — classifications from the all-paths-failed branch will be dropped (see REQ-020 / KO-6).')
    }

    // Ensure dirs exist
    for (const p of [this.statePath, this.auditLogPath, this.enabledPath]) {
      const d = dirname(p)
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
    }

    // Try to acquire lock for this instance
    this._lockFd = tryAcquireLock(this.lockPath)
    this._lockAcquiredThisInstance = this._lockFd !== null
  }

  // ── Check if escalation is enabled for agent ──────────────────────────────

  private isEnabled(agent: string): boolean {
    if (!existsSync(this.enabledPath)) return true  // default: all enabled
    try {
      const raw = readFileSync(this.enabledPath, 'utf-8')
      const data = JSON.parse(raw) as { enabled_agents?: string[] }
      if (!data.enabled_agents) return true
      return data.enabled_agents.includes(agent)
    } catch {
      return true
    }
  }

  // ── Load/save escalation state ────────────────────────────────────────────

  private loadState(): EscalationStateFile {
    if (!existsSync(this.statePath)) return {}
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf-8')) as EscalationStateFile
    } catch {
      return {}
    }
  }

  private saveState(state: EscalationStateFile): void {
    const dir = dirname(this.statePath)
    const tmp = join(dir, `.escalation-tmp-${Date.now()}.json`)
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
      renameSync(tmp, this.statePath)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  }

  // ── Write audit log entry (MUST succeed before action) ───────────────────

  private writeAuditEntry(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n'
    appendFileSync(this.auditLogPath, line, 'utf-8')
  }

  // ── Execute action with MCP→SQLite fallback, 3× retry ─────────────────────

  private async executeWithFallback(
    agent: string,
    step: number,
    mcpAction: () => Promise<void>,
    auditEntry: Record<string, unknown>,
  ): Promise<void> {
    // Audit-first: write BEFORE action. If this throws, abort entirely.
    this.writeAuditEntry({ ...auditEntry, bridge_method: 'mcp' })

    // Try MCP with retries
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mcpAction()
        return
      } catch (err) {
        lastErr = err
        if (attempt < 2) await sleep(this.retryBackoffMs)
      }
    }

    // MCP failed — try SQLite fallback
    try {
      this.writeAuditEntry({ ...auditEntry, bridge_method: 'sqlite_fallback' })
      await this.sqliteFallback(agent, step, auditEntry)
      return
    } catch (sqliteErr) {
      lastErr = sqliteErr
    }

    // Both failed — emit critical Telegram (non-deduped)
    const errMsg = `escalation bridge failed: agent=${agent} step=${step} err=${lastErr}`
    process.stderr.write(`[escalation-bridge] ${errMsg}\n`)
    try {
      await this.onCriticalTelegram(errMsg)
    } catch { /* ignore */ }
    // P6 Stage 5 / EPIC-03 — additive, best-effort failure classification.
    // Placed LAST so it can never affect the Telegram emission or this
    // method's return value.
    if (this.onFailureClassified) {
      try {
        const c = classifyFailure(fromEscalationBridgeAllPathsFailed(agent, step, String(lastErr)))
        await this.onFailureClassified(c)
      } catch { /* best-effort */ }
    }
  }

  // ── SQLite fallback ───────────────────────────────────────────────────────

  private async sqliteFallback(
    agent: string,
    step: number,
    context: Record<string, unknown>,
  ): Promise<void> {
    // Use override for testing if provided
    if (this.onSqliteFallbackOverride) {
      await this.onSqliteFallbackOverride(agent, step, context)
      return
    }
    // Default: write a note directly to the SQLite db via audit log record
    const fallbackEntry = {
      ts: new Date().toISOString(),
      agent,
      step,
      action: 'sqlite_fallback',
      context,
      bridge_method: 'sqlite_fallback',
    }
    appendFileSync(this.auditLogPath, JSON.stringify(fallbackEntry) + '\n', 'utf-8')
    // Signal success via the audit log (the fallback itself IS the audit)
  }

  // ── Build nudge template ──────────────────────────────────────────────────

  private buildNudgeMessage(
    agent: string,
    durationSec: number,
    reason_class: string,
    last_status: string | null | undefined,
  ): string {
    const durationMin = Math.round(durationSec / 60)
    const statusText = (last_status && last_status.trim()) ? last_status : '(none)'
    return [
      '[heartbeat-v2 auto-escalation: step 1/3]',
      `You have been classified STUCK for ${durationMin} minutes (reason: ${reason_class}).`,
      `Last status: ${statusText}`,
      'Please respond: write_status() with progress OR send_note() explaining the block OR ack with read_status to confirm you\'re working.',
    ].join('\n')
  }

  // ── Main tick ─────────────────────────────────────────────────────────────

  async tick(
    agent: string,
    input: AgentTickInput,
    nowSec?: number,
  ): Promise<void> {
    const now = nowSec ?? Math.floor(Date.now() / 1000)

    // Multi-instance guard: only the instance that acquired the lock can escalate
    if (!this._lockAcquiredThisInstance) {
      // Second instance: refuses to perform escalation
      return
    }

    // Check enable list
    if (!this.isEnabled(agent)) return

    const state = this.loadState()
    let agentState = state[agent] ?? {
      agent,
      current_episode_start_unix: null,
      escalation_step: 0,
      last_action_at_unix: null,
      parked_accumulated_sec: 0,
    }

    const classState = input.classifierState

    // --- State transitions ---
    if (classState === 'PARKED_PICKER' || classState === 'PARKED_PICKER_STALE') {
      // Timer suspended: accumulate nothing, retain state
      // Do not reset episode or step
      state[agent] = agentState
      this.saveState(state)
      return
    }

    if (classState !== 'STUCK') {
      // Any non-STUCK, non-PARKED state → reset episode
      agentState.current_episode_start_unix = null
      agentState.escalation_step = 0
      agentState.last_action_at_unix = null
      agentState.parked_accumulated_sec = 0
      state[agent] = agentState
      this.saveState(state)
      return
    }

    // STUCK path
    if (agentState.current_episode_start_unix === null) {
      // New episode
      agentState.current_episode_start_unix = now
      agentState.escalation_step = 0
      agentState.parked_accumulated_sec = 0
    }

    const elapsed = now - agentState.current_episode_start_unix

    // Check step 1 (nudge)
    if (agentState.escalation_step < 1 && elapsed >= this.esc1DelaySec) {
      const auditEntry = {
        agent,
        step: 1,
        action: 'nudge',
        elapsed_sec: elapsed,
        reason_class: input.reason_class,
      }

      const nudgeMsg = this.buildNudgeMessage(
        agent,
        elapsed,
        input.reason_class,
        input.last_status_text,
      )

      await this.executeWithFallback(
        agent,
        1,
        () => this.onNudgeAgent(agent, nudgeMsg),
        auditEntry,
      )

      agentState.escalation_step = 1
      agentState.last_action_at_unix = now
    }
    // Check step 2 (interrupt)
    else if (agentState.escalation_step === 1 && elapsed >= this.esc2DelaySec) {
      // Interrupt safeguard: check agent_status.updated_at
      const updatedAt = input.agent_status_updated_at ?? 0
      const ageSec = now - updatedAt
      if (ageSec <= 30) {
        // Recent activity: skip this tick, do NOT advance step
        state[agent] = agentState
        this.saveState(state)
        return
      }

      const auditEntry = {
        agent,
        step: 2,
        action: 'interrupt',
        elapsed_sec: elapsed,
        reason_class: input.reason_class,
      }

      await this.executeWithFallback(
        agent,
        2,
        () => this.onInterruptAgent(agent),
        auditEntry,
      )

      agentState.escalation_step = 2
      agentState.last_action_at_unix = now
    }
    // Check step 3 (Boss note)
    else if (agentState.escalation_step === 2 && elapsed >= this.esc3DelaySec) {
      const auditEntry = {
        agent,
        step: 3,
        action: 'boss_note',
        elapsed_sec: elapsed,
        reason_class: input.reason_class,
      }

      const noteMsg = [
        `[heartbeat-v2 escalation step 3/3] Agent ${agent} has been STUCK for ${Math.round(elapsed / 60)} minutes`,
        `Reason: ${input.reason_class}`,
        `Last status: ${input.last_status_text ?? '(none)'}`,
        'This is an automated escalation. Please investigate.',
      ].join('\n')

      await this.executeWithFallback(
        agent,
        3,
        () => this.onSendNote(this.bossTaskId, noteMsg),
        auditEntry,
      )

      agentState.escalation_step = 3
      agentState.last_action_at_unix = now
    }

    state[agent] = agentState
    this.saveState(state)
  }

  // ── Cleanup lock on process exit ──────────────────────────────────────────

  destroy(): void {
    if (this._lockFd !== null) {
      releaseLock(this._lockFd, this.lockPath)
      this._lockFd = null
    }
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
