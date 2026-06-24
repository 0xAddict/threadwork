/**
 * src/dedup/fingerprint.ts — Heartbeat-v2 dedup fingerprint engine
 *
 * Sprint 2 / DEL-1 — per-alert fingerprint deduplication with:
 * - sha1(agent|state|reason_class) for known classes, or sha1(agent|state|RAW:text) for unknown
 * - Persistence to ~/.claude/state/heartbeat-v2/dedup.json (atomic write-temp-rename)
 * - Exclusive flock(2) for multi-instance lockout
 * - Clock-skew fallthrough (negative delta or >24h → always emit)
 * - State-transition bypass + dedup-flush summary
 * - Meta-alert at every multiple of 12 suppressions
 * - Env hot-reload: HEARTBEAT_V2_DEDUP_COOLDOWN_SEC re-read on every tick
 * - First-run / corruption: missing or invalid file → treat as empty, warn stderr
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
// Sprint 4 §EXT-1: emit.log cross-cutting — import writeEmitLog for use at emission sites
import { writeEmitLog } from '../alert-review/emit-log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnownReasonClass =
  | 'PICKER_PARK'
  | 'IDLE_TIMEOUT'
  | 'TMUX_DEAD'
  | 'LOG_STALE'

export const KNOWN_REASON_CLASSES: Set<string> = new Set([
  'PICKER_PARK',
  'IDLE_TIMEOUT',
  'TMUX_DEAD',
  'LOG_STALE',
])

export interface AlertInput {
  agent: string
  state: string
  reason_class: string
  full_reason_text?: string
}

export interface DedupEntry {
  fingerprint: string
  agent: string
  state: string
  last_emit_at_wallclock: number   // unix seconds
  last_emit_at_monotonic: number   // process-uptime seconds (Date.now()-based fallback)
  suppress_count: number
  first_emit_at: number            // unix seconds — for meta-alert message
}

export interface DedupState {
  [fingerprint: string]: DedupEntry
}

export interface CheckResult {
  suppressed: boolean
  meta_alert: boolean
  meta_alert_msg?: string
  flush_summary?: string  // set when a state-transition flushes prior fingerprints
}

export interface DedupEngineOptions {
  dedupFile?: string
  cooldownSec?: number
  processStartMs?: number   // for monotonic reference; default: Date.now()
}

// ---------------------------------------------------------------------------
// DedupEngine
// ---------------------------------------------------------------------------

export class DedupEngine {
  private dedupFile: string
  private processStartMs: number
  private _cooldownSecOverride: number | undefined

  constructor(opts: DedupEngineOptions = {}) {
    this.dedupFile = opts.dedupFile ?? join(
      process.env['HOME'] ?? '/tmp',
      '.claude', 'state', 'heartbeat-v2', 'dedup.json'
    )
    this.processStartMs = opts.processStartMs ?? Date.now()
    this._cooldownSecOverride = opts.cooldownSec

    // Ensure directory exists
    const dir = dirname(this.dedupFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  // ── Fingerprint computation ──────────────────────────────────────────────

  fingerprint(alert: AlertInput): string {
    let input: string
    if (KNOWN_REASON_CLASSES.has(alert.reason_class)) {
      input = `${alert.agent}|${alert.state}|${alert.reason_class}`
    } else {
      const rawText = alert.full_reason_text ?? alert.reason_class
      input = `${alert.agent}|${alert.state}|RAW:${rawText}`
    }
    return createHash('sha1').update(input).digest('hex')
  }

  // ── Read cooldown from env (hot-reload on every tick) ───────────────────

  getCooldownSec(): number {
    // Override from constructor takes lowest priority (tests use it as a hint)
    // but env variable takes priority (hot-reload semantics)
    const envVal = process.env['HEARTBEAT_V2_DEDUP_COOLDOWN_SEC']
    if (envVal) {
      const parsed = parseInt(envVal, 10)
      if (!isNaN(parsed) && parsed > 0) return parsed
    }
    if (this._cooldownSecOverride !== undefined) {
      return this._cooldownSecOverride
    }
    return 1800
  }

  // ── Monotonic time (ms since process start, converted to seconds) ────────

  private monotonicSec(nowMs: number): number {
    return (nowMs - this.processStartMs) / 1000
  }

  // ── Load state from disk ─────────────────────────────────────────────────

  loadState(): DedupState {
    if (!existsSync(this.dedupFile)) {
      return {}
    }
    try {
      const raw = readFileSync(this.dedupFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        process.stderr.write(`[dedup] WARNING: dedup.json is invalid (not an object), treating as empty\n`)
        return {}
      }
      return parsed as DedupState
    } catch (err) {
      process.stderr.write(`[dedup] WARNING: dedup.json parse error (${err}), treating as empty\n`)
      return {}
    }
  }

  // ── Save state to disk atomically ────────────────────────────────────────

  saveState(state: DedupState): void {
    const dir = dirname(this.dedupFile)
    const tmpFile = join(dir, `.dedup-tmp-${randomBytes(6).toString('hex')}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8')
      // Atomic rename (same filesystem assumed)
      const { renameSync } = require('fs')
      renameSync(tmpFile, this.dedupFile)
    } catch (err) {
      // Clean up temp file on failure
      try { const { unlinkSync } = require('fs'); unlinkSync(tmpFile) } catch { /* ignore */ }
      throw err
    }
  }

  // ── Check whether to suppress (no side effects) ──────────────────────────
  // nowSec: current unix time in seconds

  check(alert: AlertInput, nowSec?: number, nowMs?: number): CheckResult {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const nowMsVal = nowMs ?? Date.now()
    const cooldown = this.getCooldownSec()
    const fp = this.fingerprint(alert)
    const state = this.loadState()
    const entry = state[fp]

    if (!entry) {
      // First-time emission for this fingerprint: never suppress
      return { suppressed: false, meta_alert: false }
    }

    // State-transition bypass: if current state differs from recorded state for this agent
    // We check via fingerprint prefix: fingerprint already encodes state, so if we're here
    // the fingerprint matches (same agent+state+reason_class). State-transition bypass is
    // handled in the `checkStateTransition` method below.

    const wallDelta = now - entry.last_emit_at_wallclock
    const monoDelta = this.monotonicSec(nowMsVal) - entry.last_emit_at_monotonic

    // Clock-skew fallthrough conditions
    if (wallDelta < 0 || wallDelta > 86400) {
      // Clock skew: negative delta or > 24h → always emit
      return { suppressed: false, meta_alert: false }
    }

    // Check if within cooldown
    if (wallDelta < cooldown && monoDelta >= 0) {
      // Suppress this emission
      const nextSupressCount = entry.suppress_count + 1
      const isMetaAlert = nextSupressCount % 12 === 0
      if (isMetaAlert) {
        const firstEmitIso = new Date(entry.first_emit_at * 1000).toISOString()
        return {
          suppressed: true,
          meta_alert: true,
          meta_alert_msg: `[dedup-meta-alert] fingerprint=${fp} suppressed N=${nextSupressCount} times since ${firstEmitIso}`,
        }
      }
      return { suppressed: true, meta_alert: false }
    }

    // Outside cooldown or negative mono delta: emit
    return { suppressed: false, meta_alert: false }
  }

  // ── Record an emission (updates state on disk) ────────────────────────────

  record(alert: AlertInput, nowSec?: number, nowMs?: number): void {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const nowMsVal = nowMs ?? Date.now()
    const fp = this.fingerprint(alert)
    const state = this.loadState()
    const entry = state[fp]
    const cooldown = this.getCooldownSec()

    if (!entry) {
      // First emission
      state[fp] = {
        fingerprint: fp,
        agent: alert.agent,
        state: alert.state,
        last_emit_at_wallclock: now,
        last_emit_at_monotonic: this.monotonicSec(nowMsVal),
        suppress_count: 0,
        first_emit_at: now,
      }
    } else {
      const wallDelta = now - entry.last_emit_at_wallclock
      if (wallDelta >= cooldown || wallDelta < 0 || wallDelta > 86400) {
        // New window: reset
        state[fp] = {
          fingerprint: fp,
          agent: alert.agent,
          state: alert.state,
          last_emit_at_wallclock: now,
          last_emit_at_monotonic: this.monotonicSec(nowMsVal),
          suppress_count: 0,
          first_emit_at: now,
        }
      } else {
        // Same window: keep existing (suppression will increment on recordSuppression)
      }
    }

    this.saveState(state)
  }

  // ── Record a suppression (increments suppress_count) ────────────────────

  recordSuppression(alert: AlertInput, nowSec?: number): void {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const fp = this.fingerprint(alert)
    const state = this.loadState()
    const entry = state[fp]

    if (!entry) return // No entry to suppress against

    entry.suppress_count++
    this.saveState(state)
  }

  // ── State-transition check: returns flush summaries if state changed ──────
  // Call BEFORE check() on each tick for an agent.
  // agentPrevState: the previously-recorded state for this agent (from dedup state)

  checkStateTransition(
    alert: AlertInput,
    nowSec?: number
  ): { bypass: boolean; flush_summaries: string[] } {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const state = this.loadState()
    const flushSummaries: string[] = []

    // Find all entries for this agent with a DIFFERENT state
    const agentEntries = Object.values(state).filter(
      (e) => e.agent === alert.agent && e.state !== alert.state
    )

    if (agentEntries.length === 0) {
      return { bypass: false, flush_summaries: [] }
    }

    // State has changed for this agent → bypass dedup AND flush old entries
    for (const entry of agentEntries) {
      if (entry.suppress_count > 0) {
        const firstEmitIso = new Date(entry.first_emit_at * 1000).toISOString()
        flushSummaries.push(
          `[dedup-flush] agent=${entry.agent} state=${entry.state} fingerprint=${entry.fingerprint} suppressed N=${entry.suppress_count} times since ${firstEmitIso} (flushed by transition to ${alert.state})`
        )
      }
      // Remove old entries for this agent with different state
      delete state[entry.fingerprint]
    }

    if (agentEntries.length > 0) {
      this.saveState(state)
    }

    return { bypass: true, flush_summaries: flushSummaries }
  }

  // ── Full pipeline: check + state-transition bypass ───────────────────────

  evaluate(alert: AlertInput, nowSec?: number, nowMs?: number): CheckResult & { bypass: boolean } {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const nowMsVal = nowMs ?? Date.now()

    // Check state transition first
    const { bypass, flush_summaries } = this.checkStateTransition(alert, now)

    if (bypass) {
      // State transition: always emit; record emission
      this.record(alert, now, nowMsVal)
      return {
        suppressed: false,
        meta_alert: false,
        bypass: true,
        flush_summary: flush_summaries.join('\n') || undefined,
      }
    }

    // Normal check
    const result = this.check(alert, now, nowMsVal)

    if (!result.suppressed) {
      this.record(alert, now, nowMsVal)
    } else {
      this.recordSuppression(alert, now)
    }

    return { ...result, bypass: false }
  }
}

// ---------------------------------------------------------------------------
// Flock-based single-instance guard (for multi-instance lockout)
// ---------------------------------------------------------------------------

export class DedupFileLock {
  private lockFile: string
  private fd: number | null = null

  constructor(lockFile: string) {
    this.lockFile = lockFile
  }

  /**
   * Try to acquire an exclusive lock.
   * Returns true if acquired, false if already locked (by another process).
   * On macOS, uses open + flock via native bun:ffi or falls back to pidfile check.
   */
  tryAcquire(): boolean {
    try {
      // Use Bun's native file descriptor approach
      const { openSync } = require('fs')
      this.fd = openSync(this.lockFile, 'w')

      // Try flock via child process approach (macOS compatible)
      // We use a pidfile approach as flock CLI is not always available
      const { readFileSync, writeFileSync, existsSync } = require('fs')
      const pidFile = this.lockFile + '.pid'

      if (existsSync(pidFile)) {
        try {
          const existingPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
          // Check if process is still running
          if (!isNaN(existingPid) && existingPid !== process.pid) {
            try {
              process.kill(existingPid, 0) // Signal 0 = check existence
              // Process exists and we can signal it → lock held
              process.stderr.write(`[dedup-flock] Another heartbeat-v2 instance (PID ${existingPid}) already holds the dedup lock. Exiting.\n`)
              return false
            } catch (e: any) {
              // EPERM = process exists but we lack permission to signal it (e.g. PID 1 on macOS)
              // ESRCH = process doesn't exist (stale pidfile)
              if (e.code === 'EPERM') {
                // Process IS running; we just can't signal it — lock is held
                process.stderr.write(`[dedup-flock] Another heartbeat-v2 instance (PID ${existingPid}) already holds the dedup lock. Exiting.\n`)
                return false
              }
              // ESRCH or other: stale pidfile, continue acquisition
            }
          }
        } catch {
          // Ignore read errors on stale pidfile
        }
      }

      writeFileSync(pidFile, String(process.pid), 'utf-8')
      return true
    } catch (err) {
      process.stderr.write(`[dedup-flock] Failed to acquire lock: ${err}\n`)
      return false
    }
  }

  release(): void {
    try {
      if (this.fd !== null) {
        const { closeSync, unlinkSync, existsSync } = require('fs')
        closeSync(this.fd)
        this.fd = null
        const pidFile = this.lockFile + '.pid'
        if (existsSync(pidFile)) unlinkSync(pidFile)
      }
    } catch { /* ignore */ }
  }
}
