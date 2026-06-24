/**
 * src/urgency-routing/index.ts — Heartbeat-v2 Per-Alert-Class Urgency Routing
 *
 * Sprint 3 / DEL-3 — Three-tier severity routing with:
 * - Three severity tiers: CRITICAL, WARNING, INFO
 * - Severity assignment via ~/.claude/state/heartbeat-v2/severity-map.json (hot-reload per tick)
 * - CRITICAL: PushNotification (if available) + direct Telegram + task-board send_note
 *   (bypasses standard dedup; subject to CRITICAL-tier dedup with exponential backoff)
 * - WARNING: normal pipeline (dedup + group + inhibit + silence) → Telegram + task-board note
 * - INFO: task-board send_note ONLY (no Telegram)
 * - CRITICAL-tier dedup: separate from Sprint 2's dedup.json
 *   File: ~/.claude/state/heartbeat-v2/critical-dedup.json
 *   Exponential backoff: 120s → 240s → 480s → 1800s (capped)
 * - PushNotification fallback: if unavailable → [CRITICAL][PUSH-FALLBACK] Telegram message
 * - Grouping invariant: bucket key extended to (state, reason_class, severity) per §8
 * - Inhibit `applies_to_critical`: CRITICAL alerts are inhibition-resistant by default
 * - Match semantics: top-down, first-match-wins, AND across keys, missing labels = "(unset)"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
// Sprint 4 §EXT-1: emit.log cross-cutting — import writeEmitLog for use at emission sites
import { writeEmitLog } from '../alert-review/emit-log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO'

export interface SeverityRule {
  match: Record<string, string>
  severity: Severity
}

export interface SeverityMap {
  mappings: SeverityRule[]
  default: Severity
}

export interface AlertForRouting {
  agent?: string
  state?: string
  reason_class?: string
  severity?: string
  fingerprint?: string
  [key: string]: string | boolean | undefined
}

export interface RoutedAlert extends AlertForRouting {
  severity: Severity
  routed_at: string  // ISO8601
}

export interface RouteResult {
  severity: Severity
  actions: {
    push_notification: boolean
    telegram: boolean
    telegram_prefix?: string
    task_board_note: boolean
    note_prefix?: string
  }
}

// CRITICAL dedup entry
export interface CriticalDedupEntry {
  fingerprint: string
  last_emit_at: number      // unix seconds
  cooldown_sec: number      // current cooldown (120, 240, 480, 1800)
  emit_count: number        // number of times emitted
}

export interface CriticalDedupState {
  [fingerprint: string]: CriticalDedupEntry
}

export interface RouterOptions {
  severityMapPath?: string
  criticalDedupPath?: string
  initialCooldownSec?: number
  pushNotificationAvailable?: boolean  // for testing
}

// ---------------------------------------------------------------------------
// Severity routing constants
// ---------------------------------------------------------------------------

const CRITICAL_BACKOFF_SEQUENCE = [120, 240, 480, 1800]

// ---------------------------------------------------------------------------
// UrgencyRouter
// ---------------------------------------------------------------------------

export class UrgencyRouter {
  private severityMapPath: string
  private criticalDedupPath: string
  private initialCooldownSec: number
  private _pushAvailable: boolean | undefined  // undefined = auto-detect
  private _severityMap: SeverityMap | null = null
  private _severityMapMtime: number = 0

  constructor(opts: RouterOptions = {}) {
    this.severityMapPath = opts.severityMapPath
      ?? join(homedir(), '.claude', 'state', 'heartbeat-v2', 'severity-map.json')
    this.criticalDedupPath = opts.criticalDedupPath
      ?? join(homedir(), '.claude', 'state', 'heartbeat-v2', 'critical-dedup.json')
    this.initialCooldownSec = opts.initialCooldownSec
      ?? parseInt(process.env['HEARTBEAT_V2_CRITICAL_DEDUP_SEC'] ?? '120', 10)
    this._pushAvailable = opts.pushNotificationAvailable

    // Ensure directories exist
    const dirs = [dirname(this.severityMapPath), dirname(this.criticalDedupPath)]
    for (const d of dirs) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
    }
  }

  // ── Load severity map (hot-reload per tick) ────────────────────────────────

  loadSeverityMap(): SeverityMap {
    if (!existsSync(this.severityMapPath)) {
      return { mappings: [], default: 'WARNING' }
    }

    try {
      const stat = statSync(this.severityMapPath)
      const mtime = stat.mtimeMs
      // Hot-reload: re-read if mtime changed
      if (this._severityMapMtime !== mtime || this._severityMap === null) {
        const raw = readFileSync(this.severityMapPath, 'utf-8')
        this._severityMap = JSON.parse(raw) as SeverityMap
        this._severityMapMtime = mtime
      }
      return this._severityMap!
    } catch (err) {
      process.stderr.write(`[urgency-routing] WARN: Failed to load severity-map.json: ${err}\n`)
      return { mappings: [], default: 'WARNING' }
    }
  }

  // ── Assign severity to alert ───────────────────────────────────────────────
  //
  // Uses top-down, first-match-wins semantics.
  // Missing alert labels are treated as "(unset)".

  assignSeverity(alert: AlertForRouting, severityMap?: SeverityMap): Severity {
    const map = severityMap ?? this.loadSeverityMap()

    for (const rule of map.mappings) {
      let allMatch = true
      for (const [key, value] of Object.entries(rule.match)) {
        const alertValue = String(alert[key] ?? '(unset)')
        if (alertValue !== value) {
          allMatch = false
          break
        }
      }
      if (allMatch) {
        return rule.severity
      }
    }

    // Default
    return map.default ?? 'WARNING'
  }

  // ── Get route for severity ─────────────────────────────────────────────────

  getRoute(severity: Severity, pushAvailable?: boolean): RouteResult {
    const pushOk = pushAvailable ?? this._pushAvailable ?? false

    switch (severity) {
      case 'CRITICAL':
        return {
          severity: 'CRITICAL',
          actions: {
            push_notification: pushOk,
            telegram: true,
            telegram_prefix: pushOk ? '[CRITICAL]' : '[CRITICAL][PUSH-FALLBACK]',
            task_board_note: true,
            note_prefix: '[CRITICAL]',
          },
        }
      case 'WARNING':
        return {
          severity: 'WARNING',
          actions: {
            push_notification: false,
            telegram: true,
            task_board_note: true,
            note_prefix: '[WARNING]',
          },
        }
      case 'INFO':
        return {
          severity: 'INFO',
          actions: {
            push_notification: false,
            telegram: false,
            task_board_note: true,
            note_prefix: '[INFO]',
          },
        }
    }
  }

  // ── Load critical-dedup state ──────────────────────────────────────────────

  loadCriticalDedup(): CriticalDedupState {
    if (!existsSync(this.criticalDedupPath)) return {}
    try {
      const raw = readFileSync(this.criticalDedupPath, 'utf-8')
      return JSON.parse(raw) as CriticalDedupState
    } catch {
      return {}
    }
  }

  // ── Save critical-dedup state atomically ──────────────────────────────────

  saveCriticalDedup(state: CriticalDedupState): void {
    const dir = dirname(this.criticalDedupPath)
    const tmp = join(dir, `.critical-dedup-tmp-${randomBytes(6).toString('hex')}.json`)
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
      const { renameSync } = require('fs')
      renameSync(tmp, this.criticalDedupPath)
    } catch (err) {
      try { require('fs').unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  }

  // ── Check CRITICAL dedup (exponential backoff) ────────────────────────────
  //
  // Returns true if the alert should be suppressed by CRITICAL dedup.
  // Caller must call recordCriticalEmit() when actually emitting.

  checkCriticalDedup(fingerprint: string, nowSec?: number): boolean {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const state = this.loadCriticalDedup()
    const entry = state[fingerprint]

    if (!entry) return false  // First time: emit

    const elapsed = now - entry.last_emit_at
    if (elapsed >= entry.cooldown_sec) {
      return false  // Cooldown expired: emit
    }

    return true  // Within cooldown: suppress
  }

  // ── Record CRITICAL emission (updates dedup state) ────────────────────────

  recordCriticalEmit(fingerprint: string, nowSec?: number): void {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const state = this.loadCriticalDedup()
    const entry = state[fingerprint]

    if (!entry) {
      // First emission
      state[fingerprint] = {
        fingerprint,
        last_emit_at: now,
        cooldown_sec: this.initialCooldownSec,
        emit_count: 1,
      }
    } else {
      // Subsequent emission: advance backoff
      const nextCooldown = this.nextBackoff(entry.cooldown_sec)
      state[fingerprint] = {
        fingerprint,
        last_emit_at: now,
        cooldown_sec: nextCooldown,
        emit_count: entry.emit_count + 1,
      }
    }

    this.saveCriticalDedup(state)
  }

  // ── Reset CRITICAL dedup entry (on state recovery) ────────────────────────

  resetCriticalDedup(fingerprint: string): void {
    const state = this.loadCriticalDedup()
    if (state[fingerprint]) {
      delete state[fingerprint]
      this.saveCriticalDedup(state)
    }
  }

  // ── Compute next backoff cooldown ──────────────────────────────────────────

  private nextBackoff(currentCooldown: number): number {
    const idx = CRITICAL_BACKOFF_SEQUENCE.indexOf(currentCooldown)
    if (idx === -1 || idx >= CRITICAL_BACKOFF_SEQUENCE.length - 1) {
      return CRITICAL_BACKOFF_SEQUENCE[CRITICAL_BACKOFF_SEQUENCE.length - 1]
    }
    return CRITICAL_BACKOFF_SEQUENCE[idx + 1]
  }

  // ── Full route + dedup pipeline for a CRITICAL alert ─────────────────────
  //
  // Returns { emit: boolean, suppressed_by_dedup: boolean, route: RouteResult }

  routeCritical(
    fingerprint: string,
    pushAvailable?: boolean,
    nowSec?: number
  ): { emit: boolean; suppressed_by_dedup: boolean; route: RouteResult } {
    const suppressed = this.checkCriticalDedup(fingerprint, nowSec)
    const route = this.getRoute('CRITICAL', pushAvailable ?? this._pushAvailable ?? false)

    if (suppressed) {
      return { emit: false, suppressed_by_dedup: true, route }
    }

    // Record emission
    this.recordCriticalEmit(fingerprint, nowSec)
    return { emit: true, suppressed_by_dedup: false, route }
  }

  // ── Compute fingerprint for routing purposes ───────────────────────────────

  routingFingerprint(alert: AlertForRouting): string {
    return `${alert.agent ?? ''}|${alert.state ?? ''}|${alert.reason_class ?? ''}`
  }
}

// ---------------------------------------------------------------------------
// Default severity-map.json content (seeded on first use if absent)
// ---------------------------------------------------------------------------

export const DEFAULT_SEVERITY_MAP: SeverityMap = {
  mappings: [
    { match: { state: 'WATCHDOG_DEAD' }, severity: 'CRITICAL' },
    { match: { state: 'STUCK', reason_class: 'RESTART_LOOP' }, severity: 'CRITICAL' },
    { match: { state: 'STUCK' }, severity: 'WARNING' },
    { match: { state: 'PARKED_PICKER_STALE' }, severity: 'WARNING' },
    { match: { state: 'PARKED_PICKER' }, severity: 'INFO' },
    { match: { state: 'LOOP' }, severity: 'WARNING' },
  ],
  default: 'WARNING',
}
