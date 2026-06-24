/**
 * src/alert-review/emit-log.ts — Centralized emit.log writer
 *
 * Sprint 4 / DEL-3 §EXT-1 — Every alert emission across items 1–10 (Sprint 1/2/3)
 * calls writeEmitLog() to append a JSON-line to ~/.claude/state/heartbeat-v2/emit.log.
 *
 * Required fields per DoD-11 §1:
 *   {timestamp_iso, fingerprint, severity, agent, state, reason_class, destination,
 *    emit_method, alert_id}
 *
 * emit_method values:
 *   "telegram_direct" | "telegram_grouped" | "push_notification"
 *   | "task_note_only" | "task_note_fallback"
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

export type EmitMethod =
  | 'telegram_direct'
  | 'telegram_grouped'
  | 'push_notification'
  | 'task_note_only'
  | 'task_note_fallback'

export interface EmitLogEntry {
  timestamp_iso: string
  fingerprint: string
  severity: string
  agent: string
  state: string
  reason_class: string
  destination: string   // e.g., "telegram", "task_board", "push"
  emit_method: EmitMethod
  alert_id: string      // unique per emission; uuid-ish
}

export interface WriteEmitLogOptions {
  logPath?: string
  nowIso?: string
}

/**
 * Append a JSON-line to emit.log.
 * Safe to call from any emission site; silently logs errors to stderr.
 */
export function writeEmitLog(
  entry: Omit<EmitLogEntry, 'timestamp_iso' | 'alert_id'>,
  opts: WriteEmitLogOptions = {},
): string {
  const logPath = opts.logPath ?? join(
    homedir(),
    '.claude', 'state', 'heartbeat-v2', 'emit.log',
  )
  const alert_id = randomBytes(8).toString('hex')
  const timestamp_iso = opts.nowIso ?? new Date().toISOString()

  const line: EmitLogEntry = {
    timestamp_iso,
    alert_id,
    fingerprint: entry.fingerprint,
    severity: entry.severity,
    agent: entry.agent,
    state: entry.state,
    reason_class: entry.reason_class,
    destination: entry.destination,
    emit_method: entry.emit_method,
  }

  try {
    const dir = dirname(logPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(logPath, JSON.stringify(line) + '\n', 'utf-8')
  } catch (err) {
    process.stderr.write(`[emit-log] ERROR: failed to write emit.log: ${err}\n`)
  }

  return alert_id
}
