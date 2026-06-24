/**
 * src/silences/index.ts — Heartbeat-v2 Silences Engine
 *
 * Sprint 3 / DEL-2 — Alertmanager-style silences with:
 * - Silences live in ~/.claude/state/heartbeat-v2/silences.json (hot-reload each tick)
 * - Schema: id (UUID), matchers (non-empty array), starts_at, ends_at, created_by, comment
 * - Matcher types: "eq" (exact) and "regex" (JS RegExp — NOT POSIX-ERE, per task #1377 lock)
 *   regex: new RegExp(value).test(alert[label]) — substring/anywhere match unless ^...$ used
 * - Window: [starts_at, ends_at] inclusive, both ISO8601 UTC
 * - Expiry cleanup: silences with ends_at < now removed from file atomically each tick
 * - Validation: empty matchers OR ends_at < starts_at → REJECTED at load with stderr + meta-alert
 * - Audit log: ~/.claude/state/heartbeat-v2/silences.audit.log (JSON-lines)
 * - Audit log rotation: 10MB max, keep last 5 generations
 * - RESOLVED messages are NEVER suppressed
 * - Pipeline position: after INHIBIT, before DEDUP
 *
 * JS RegExp lock (task #1377): matcher_type="regex" MUST use JavaScript's native RegExp,
 * NOT POSIX-ERE. The pattern is passed to `new RegExp(value)` and tested with `.test(str)`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
// Sprint 4 §EXT-1: emit.log cross-cutting — import writeEmitLog for use at emission sites
import { writeEmitLog } from '../alert-review/emit-log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SilenceMatcher {
  label: string
  matcher_type: 'eq' | 'regex'
  value: string
}

export interface Silence {
  id: string
  matchers: SilenceMatcher[]
  starts_at: string  // ISO8601 UTC
  ends_at: string    // ISO8601 UTC
  created_by: string
  comment?: string
}

export interface SilencesFile {
  silences: Silence[]
}

export interface AlertForSilence {
  agent?: string
  state?: string
  reason_class?: string
  severity?: string
  fingerprint?: string
  is_resolved?: boolean
  [key: string]: string | boolean | undefined
}

export interface SilenceCheckResult {
  silenced: boolean
  silence_id?: string
}

export interface SilencesEngineOptions {
  silencesPath?: string
  auditLogPath?: string
  maxAuditLogBytes?: number
  auditLogGenerations?: number
  metaAlertCallback?: (msg: string) => void
}

// ---------------------------------------------------------------------------
// SilencesEngine
// ---------------------------------------------------------------------------

export class SilencesEngine {
  private silencesPath: string
  private auditLogPath: string
  private maxAuditLogBytes: number
  private auditLogGenerations: number
  private metaAlertCallback: ((msg: string) => void) | undefined

  // In-memory cache of silences (hot-reload each tick)
  private _silences: Silence[] = []
  private _lastMtime: number = 0

  constructor(opts: SilencesEngineOptions = {}) {
    this.silencesPath = opts.silencesPath
      ?? join(homedir(), '.claude', 'state', 'heartbeat-v2', 'silences.json')
    this.auditLogPath = opts.auditLogPath
      ?? join(homedir(), '.claude', 'state', 'heartbeat-v2', 'silences.audit.log')
    this.maxAuditLogBytes = opts.maxAuditLogBytes ?? 10 * 1024 * 1024  // 10MB
    this.auditLogGenerations = opts.auditLogGenerations ?? 5
    this.metaAlertCallback = opts.metaAlertCallback

    // Ensure directories exist
    const silencesDir = dirname(this.silencesPath)
    if (!existsSync(silencesDir)) {
      mkdirSync(silencesDir, { recursive: true })
    }
    const auditDir = dirname(this.auditLogPath)
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true })
    }
  }

  // ── Validate a silence rule ─────────────────────────────────────────────

  private validateSilence(s: Silence, loadTime: Date): string | null {
    if (!s.matchers || !Array.isArray(s.matchers) || s.matchers.length === 0) {
      return `Silence ${s.id}: empty matchers array`
    }
    const endsAt = new Date(s.ends_at)
    const startsAt = new Date(s.starts_at)
    if (isNaN(endsAt.getTime()) || isNaN(startsAt.getTime())) {
      return `Silence ${s.id}: invalid starts_at or ends_at`
    }
    if (endsAt < startsAt) {
      return `Silence ${s.id}: ends_at (${s.ends_at}) < starts_at (${s.starts_at})`
    }
    // ends_at must be >= now-at-creation (load time)
    if (endsAt < loadTime) {
      return `Silence ${s.id}: ends_at (${s.ends_at}) < now (${loadTime.toISOString()})`
    }
    // Validate matchers
    for (const m of s.matchers) {
      if (!m.label || !m.matcher_type || m.value === undefined) {
        return `Silence ${s.id}: invalid matcher (missing label/matcher_type/value)`
      }
      if (m.matcher_type !== 'eq' && m.matcher_type !== 'regex') {
        return `Silence ${s.id}: unknown matcher_type ${m.matcher_type}`
      }
      // Validate regex syntax (JS RegExp)
      if (m.matcher_type === 'regex') {
        try {
          new RegExp(m.value)
        } catch (e) {
          return `Silence ${s.id}: invalid regex pattern "${m.value}": ${e}`
        }
      }
    }
    return null
  }

  // ── Load silences from file (hot-reload) ────────────────────────────────
  //
  // Returns [valid silences, validation errors]. Invalid silences are rejected.

  loadSilences(nowMs?: number): Silence[] {
    const now = nowMs !== undefined ? new Date(nowMs) : new Date()

    if (!existsSync(this.silencesPath)) {
      this._silences = []
      return []
    }

    try {
      // Check mtime for hot-reload optimization
      const stat = statSync(this.silencesPath)
      const mtime = stat.mtimeMs

      const raw = readFileSync(this.silencesPath, 'utf-8')
      const parsed: SilencesFile = JSON.parse(raw)

      if (!parsed.silences || !Array.isArray(parsed.silences)) {
        process.stderr.write(`[silences] WARNING: silences.json has no silences array\n`)
        this._silences = []
        return []
      }

      const valid: Silence[] = []
      for (const s of parsed.silences) {
        const err = this.validateSilence(s, now)
        if (err) {
          process.stderr.write(`[silences] ERROR: ${err} — rejecting this silence\n`)
          if (this.metaAlertCallback) {
            this.metaAlertCallback(`[silences-meta-alert] Invalid silence rejected: ${err}`)
          }
          // Do NOT add to valid list
          continue
        }
        valid.push(s)
      }

      this._silences = valid
      this._lastMtime = mtime
      return valid
    } catch (err) {
      process.stderr.write(`[silences] WARNING: Failed to load silences.json: ${err}\n`)
      this._silences = []
      return []
    }
  }

  // ── Save silences to file atomically ────────────────────────────────────

  saveSilences(silences: Silence[]): void {
    const dir = dirname(this.silencesPath)
    const tmpFile = join(dir, `.silences-tmp-${randomBytes(6).toString('hex')}.json`)
    try {
      const data: SilencesFile = { silences }
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8')
      renameSync(tmpFile, this.silencesPath)
    } catch (err) {
      try { const { unlinkSync } = require('fs'); unlinkSync(tmpFile) } catch { /* ignore */ }
      throw err
    }
  }

  // ── Expire old silences and write back ───────────────────────────────────
  //
  // Returns the cleaned silences list.

  expireSilences(nowMs?: number): Silence[] {
    const now = nowMs !== undefined ? new Date(nowMs) : new Date()

    if (!existsSync(this.silencesPath)) return []

    try {
      const raw = readFileSync(this.silencesPath, 'utf-8')
      const parsed: SilencesFile = JSON.parse(raw)
      if (!parsed.silences || !Array.isArray(parsed.silences)) return []

      const active: Silence[] = []
      const expired: Silence[] = []

      for (const s of parsed.silences) {
        const endsAt = new Date(s.ends_at)
        if (endsAt < now) {
          expired.push(s)
        } else {
          active.push(s)
        }
      }

      if (expired.length > 0) {
        this.saveSilences(active)
        for (const s of expired) {
          this.appendAuditLog({
            event: 'expired',
            silence_id: s.id,
            ends_at: s.ends_at,
            timestamp: now.toISOString(),
          })
        }
      }

      this._silences = active
      return active
    } catch (err) {
      process.stderr.write(`[silences] WARNING: Failed to expire silences: ${err}\n`)
      return this._silences
    }
  }

  // ── Check if alert is silenced ────────────────────────────────────────────
  //
  // Returns {silenced: true, silence_id: ...} if any silence matches.
  // RESOLVED alerts are NEVER silenced.

  check(alert: AlertForSilence, silences: Silence[], nowMs?: number): SilenceCheckResult {
    // RESOLVED alerts are never silenced (per spec §8)
    if (alert.is_resolved) {
      return { silenced: false }
    }

    const now = nowMs !== undefined ? new Date(nowMs) : new Date()

    for (const silence of silences) {
      const startsAt = new Date(silence.starts_at)
      const endsAt = new Date(silence.ends_at)

      // Check time window
      if (now < startsAt || now > endsAt) continue

      // Check all matchers (AND semantics)
      let allMatch = true
      for (const matcher of silence.matchers) {
        const alertValue = String(alert[matcher.label] ?? '(unset)')
        let matches = false

        if (matcher.matcher_type === 'eq') {
          matches = alertValue === matcher.value
        } else if (matcher.matcher_type === 'regex') {
          // JS RegExp (NOT POSIX-ERE) — per task #1377 lock
          try {
            matches = new RegExp(matcher.value).test(alertValue)
          } catch {
            matches = false
          }
        }

        if (!matches) {
          allMatch = false
          break
        }
      }

      if (allMatch) {
        return { silenced: true, silence_id: silence.id }
      }
    }

    return { silenced: false }
  }

  // ── Apply silences in pipeline (hot-reload + check + audit log) ──────────
  //
  // nowMs: current time in ms (for testing)
  // Returns: { survivors, silenced }

  apply(
    alerts: AlertForSilence[],
    nowMs?: number
  ): { survivors: AlertForSilence[]; silenced: AlertForSilence[] } {
    const now = nowMs ?? Date.now()

    // Hot-reload silences each tick
    const silences = this.loadSilences(now)

    // Expire old silences
    this.expireSilences(now)

    // Reload after expiry
    const activeSilences = this.loadSilences(now)

    const survivors: AlertForSilence[] = []
    const silencedAlerts: AlertForSilence[] = []

    for (const alert of alerts) {
      const result = this.check(alert, activeSilences, now)
      if (result.silenced) {
        silencedAlerts.push(alert)
        // Log to audit
        this.appendAuditLog({
          event: 'silenced',
          silence_id: result.silence_id!,
          alert_fingerprint: alert.fingerprint ?? 'unknown',
          agent: String(alert.agent ?? ''),
          state: String(alert.state ?? ''),
          reason_class: String(alert.reason_class ?? ''),
          timestamp: new Date(now).toISOString(),
        })
      } else {
        survivors.push(alert)
      }
    }

    return { survivors, silenced: silencedAlerts }
  }

  // ── Append to audit log ────────────────────────────────────────────────────

  appendAuditLog(entry: Record<string, string>): void {
    try {
      // Rotate if needed
      this.maybeRotateAuditLog()

      const line = JSON.stringify(entry) + '\n'
      appendFileSync(this.auditLogPath, line, 'utf-8')
    } catch (err) {
      process.stderr.write(`[silences] WARNING: Failed to write audit log: ${err}\n`)
    }
  }

  // ── Rotate audit log if > maxAuditLogBytes ────────────────────────────────

  maybeRotateAuditLog(): void {
    try {
      if (!existsSync(this.auditLogPath)) return
      const stat = statSync(this.auditLogPath)
      if (stat.size < this.maxAuditLogBytes) return

      // Rotate: .5 → delete, .4 → .5, .3 → .4, .2 → .3, .1 → .2, current → .1
      for (let i = this.auditLogGenerations; i >= 1; i--) {
        const src = i === 1 ? this.auditLogPath : `${this.auditLogPath}.${i - 1}`
        const dst = `${this.auditLogPath}.${i}`
        if (existsSync(src)) {
          try {
            renameSync(src, dst)
          } catch { /* ignore */ }
        }
      }
      // The original file has been renamed to .1, so writes go to a new file automatically
    } catch (err) {
      process.stderr.write(`[silences] WARNING: Audit log rotation failed: ${err}\n`)
    }
  }

  // ── Get current loaded silences ────────────────────────────────────────────

  getSilences(): Silence[] {
    return this._silences
  }

  // ── Remove a silence by ID ─────────────────────────────────────────────────

  deleteSilenceById(id: string): boolean {
    if (!existsSync(this.silencesPath)) return false
    try {
      const raw = readFileSync(this.silencesPath, 'utf-8')
      const parsed: SilencesFile = JSON.parse(raw)
      const before = parsed.silences.length
      parsed.silences = parsed.silences.filter(s => s.id !== id)
      if (parsed.silences.length < before) {
        this.saveSilences(parsed.silences)
        this._silences = parsed.silences
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // ── Add a silence ──────────────────────────────────────────────────────────

  addSilence(silence: Silence, nowMs?: number): { ok: boolean; error?: string } {
    const now = nowMs !== undefined ? new Date(nowMs) : new Date()
    const err = this.validateSilence(silence, now)
    if (err) {
      process.stderr.write(`[silences] ERROR: ${err}\n`)
      if (this.metaAlertCallback) {
        this.metaAlertCallback(`[silences-meta-alert] Invalid silence rejected: ${err}`)
      }
      return { ok: false, error: err }
    }

    let existing: Silence[] = []
    if (existsSync(this.silencesPath)) {
      try {
        const raw = readFileSync(this.silencesPath, 'utf-8')
        const parsed: SilencesFile = JSON.parse(raw)
        existing = parsed.silences ?? []
      } catch { /* ignore */ }
    }

    existing.push(silence)
    this.saveSilences(existing)
    this._silences = existing.filter(s => {
      const e = this.validateSilence(s, now)
      return !e
    })
    return { ok: true }
  }
}
