/**
 * src/restart-cap/tracker.ts — Restart-intensity-cap tracker library
 *
 * Sprint 2 / DEL-2 — sliding-window restart-intensity cap for supervised processes.
 *
 * Provides:
 * - RestartTracker: read/write tracker files with flock-safe atomic writes
 * - checkAndEnforceCap: call on each process startup; exits non-zero if cap exceeded
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
// Sprint 4 §EXT-1: emit.log cross-cutting — import writeEmitLog for use at emission sites
import { writeEmitLog } from '../alert-review/emit-log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackerData {
  service: string
  restart_timestamps_unix: number[]
  max_r: number
  max_t_sec: number
  last_action: 'running' | 'self-terminated-cap' | 'sentinel-unloaded'
  last_action_at: string // ISO8601
}

export interface CapCheckResult {
  tripped: boolean
  filtered_count: number
  max_r: number
  timestamps_after_filter: number[]
  dropped_future: number[]
}

export interface RestartTrackerOptions {
  trackerDir?: string
  service: string
  maxR?: number
  maxTSec?: number
}

// ---------------------------------------------------------------------------
// RestartTracker
// ---------------------------------------------------------------------------

export class RestartTracker {
  private trackerDir: string
  private service: string
  private maxR: number
  private maxTSec: number

  constructor(opts: RestartTrackerOptions) {
    this.trackerDir = opts.trackerDir ?? join(
      process.env['HOME'] ?? '/tmp',
      '.claude', 'state', 'restart-tracker'
    )
    this.service = opts.service
    this.maxR = opts.maxR ?? parseInt(process.env['RESTART_INTENSITY_MAX_R'] ?? '5', 10)
    this.maxTSec = opts.maxTSec ?? parseInt(process.env['RESTART_INTENSITY_MAX_T_SEC'] ?? '60', 10)

    // Ensure directory exists
    if (!existsSync(this.trackerDir)) {
      mkdirSync(this.trackerDir, { recursive: true })
    }
  }

  get trackerFile(): string {
    return join(this.trackerDir, `${this.service}.json`)
  }

  // ── Load tracker from disk ────────────────────────────────────────────────

  load(): TrackerData {
    if (!existsSync(this.trackerFile)) {
      return this.defaultData()
    }
    try {
      const raw = readFileSync(this.trackerFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!this.isValidSchema(parsed)) {
        process.stderr.write(`[restart-cap] WARNING: tracker file ${this.trackerFile} has invalid schema, treating as empty\n`)
        return this.defaultData()
      }
      return parsed as TrackerData
    } catch (err) {
      process.stderr.write(`[restart-cap] WARNING: tracker file ${this.trackerFile} is corrupted (${err}), treating as empty\n`)
      return this.defaultData()
    }
  }

  // ── Save tracker to disk atomically ──────────────────────────────────────

  save(data: TrackerData): void {
    const dir = dirname(this.trackerFile)
    const tmpFile = join(dir, `.tracker-tmp-${randomBytes(6).toString('hex')}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8')
      const { renameSync } = require('fs')
      renameSync(tmpFile, this.trackerFile)
    } catch (err) {
      try { const { unlinkSync } = require('fs'); unlinkSync(tmpFile) } catch { /* ignore */ }
      throw err
    }
  }

  // ── Filter timestamps to window (clock-skew aware) ───────────────────────

  filterWindow(timestamps: number[], nowSec: number): {
    filtered: number[]
    droppedFuture: number[]
  } {
    const droppedFuture: number[] = []
    const filtered: number[] = []

    for (const ts of timestamps) {
      if (ts > nowSec) {
        // Clock-skew: future timestamp dropped
        droppedFuture.push(ts)
        process.stderr.write(`[restart-cap] WARNING: dropping future timestamp ${ts} (now=${nowSec}, clock skew detected)\n`)
      } else if (nowSec - ts <= this.maxTSec) {
        filtered.push(ts)
      }
      // else: older than window, naturally expired
    }

    return { filtered, droppedFuture }
  }

  // ── Check cap (no side effects) ───────────────────────────────────────────

  checkCap(data: TrackerData, nowSec: number): CapCheckResult {
    const { filtered, droppedFuture } = this.filterWindow(data.restart_timestamps_unix, nowSec)
    const tripped = filtered.length > this.maxR
    return {
      tripped,
      filtered_count: filtered.length,
      max_r: this.maxR,
      timestamps_after_filter: filtered,
      dropped_future: droppedFuture,
    }
  }

  // ── Self-enforcement on startup ───────────────────────────────────────────
  // Returns { capped: true, exitCode: 1 } if cap exceeded; { capped: false } otherwise.
  // Caller should exit(1) if capped.

  onStartup(nowSec?: number): { capped: boolean; filtered_count?: number } {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const data = this.load()

    // Override max_r/max_t_sec from loaded data if present
    if (data.max_r !== undefined) this.maxR = data.max_r
    if (data.max_t_sec !== undefined) this.maxTSec = data.max_t_sec

    const { filtered, droppedFuture } = this.filterWindow(data.restart_timestamps_unix, now)

    if (droppedFuture.length > 0) {
      process.stderr.write(`[restart-cap] WARNING: service=${this.service} dropped ${droppedFuture.length} future timestamps (clock skew)\n`)
    }

    // Append current timestamp (this startup counts as a restart)
    const newTimestamps = [...filtered, now]

    // Write updated tracker
    const nowIso = new Date(now * 1000).toISOString()

    // Check AFTER appending: if newTimestamps.length > max_r, cap is exceeded
    if (newTimestamps.length > this.maxR) {
      // Cap exceeded: self-terminate
      const capData: TrackerData = {
        service: this.service,
        restart_timestamps_unix: newTimestamps,
        max_r: this.maxR,
        max_t_sec: this.maxTSec,
        last_action: 'self-terminated-cap',
        last_action_at: nowIso,
      }
      this.save(capData)
      process.stderr.write(`[restart-cap] SELF-TERMINATING: service=${this.service} restart count ${newTimestamps.length} exceeds max_r=${this.maxR} within ${this.maxTSec}s window\n`)
      return { capped: true, filtered_count: newTimestamps.length }
    }

    // Not capped: update tracker and continue
    const runningData: TrackerData = {
      service: this.service,
      restart_timestamps_unix: newTimestamps,
      max_r: this.maxR,
      max_t_sec: this.maxTSec,
      last_action: 'running',
      last_action_at: nowIso,
    }
    this.save(runningData)
    return { capped: false }
  }

  // ── Schema validation ─────────────────────────────────────────────────────

  private isValidSchema(obj: unknown): obj is TrackerData {
    if (typeof obj !== 'object' || obj === null) return false
    const o = obj as Record<string, unknown>
    return (
      typeof o['service'] === 'string' &&
      Array.isArray(o['restart_timestamps_unix']) &&
      typeof o['max_r'] === 'number' &&
      typeof o['max_t_sec'] === 'number' &&
      typeof o['last_action'] === 'string' &&
      typeof o['last_action_at'] === 'string'
    )
  }

  private defaultData(): TrackerData {
    const nowIso = new Date().toISOString()
    return {
      service: this.service,
      restart_timestamps_unix: [],
      max_r: this.maxR,
      max_t_sec: this.maxTSec,
      last_action: 'running',
      last_action_at: nowIso,
    }
  }
}

// ---------------------------------------------------------------------------
// Child-process cap tracking (for watchdog.ts direct children)
// ---------------------------------------------------------------------------

export interface ChildCapState {
  [childId: string]: {
    timestamps: number[]
    capped: boolean
  }
}

export class ChildRestartCap {
  private maxR: number
  private maxTSec: number
  private state: ChildCapState = {}

  constructor(maxR?: number, maxTSec?: number) {
    this.maxR = maxR ?? parseInt(process.env['RESTART_INTENSITY_MAX_R'] ?? '5', 10)
    this.maxTSec = maxTSec ?? parseInt(process.env['RESTART_INTENSITY_MAX_T_SEC'] ?? '60', 10)
  }

  /**
   * Called when a child process restarts.
   * Returns { capped: true } if the child has exceeded the restart cap.
   */
  onChildRestart(
    childId: string,
    nowSec?: number,
    alertCallback?: (childId: string, count: number) => void
  ): { capped: boolean; count: number } {
    const now = nowSec ?? Math.floor(Date.now() / 1000)

    if (!this.state[childId]) {
      this.state[childId] = { timestamps: [], capped: false }
    }

    const childState = this.state[childId]!

    if (childState.capped) {
      return { capped: true, count: childState.timestamps.length }
    }

    // Filter window
    const filtered = childState.timestamps.filter(
      (ts) => ts <= now && now - ts <= this.maxTSec
    )

    filtered.push(now)
    childState.timestamps = filtered

    // Check post-append: if count > max_r, cap is exceeded
    if (filtered.length > this.maxR) {
      childState.capped = true
      process.stderr.write(`[restart-cap] child=${childId} restart count ${filtered.length} exceeds max_r=${this.maxR} within ${this.maxTSec}s. Stopping respawn.\n`)
      if (alertCallback) {
        alertCallback(childId, filtered.length)
      }
      return { capped: true, count: filtered.length }
    }

    return { capped: false, count: filtered.length }
  }

  isCapped(childId: string): boolean {
    return this.state[childId]?.capped ?? false
  }

  reset(childId: string): void {
    delete this.state[childId]
  }
}
