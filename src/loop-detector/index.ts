/**
 * src/loop-detector/index.ts — Heartbeat-v2 Loop Detector
 *
 * Sprint 4 / DEL-2 — Per-agent hash-based loop detection with:
 * - sha256 hash over (status_text || "|" || tool_call_signature || "|" || pane_bottom_line)
 * - Canonical JSON for tool-call signatures (RFC 8785 / JCS-style sorted keys)
 * - Boot guard: only collect after transcript entry AND write_status exist
 * - Empty sentinel: "EMPTY" when status_text == "" AND tool_call_signature == null
 * - History: per-agent rolling 12 (tick_unix, hash) pairs in loop-detector.json
 * - Gap entries: {tick_unix, hash: null, gap_reason} excluded from detection
 * - Consecutive-N=6 OR windowed-supermajority 9-of-12 → LOOP
 * - Exclusions: IDLE, PARKED_PICKER, PARKED_PICKER_STALE → SKIPPED entirely
 * - Recovery: first tick where hash differs from LOOP-triggering hash
 * - LOOP is a new classifier state alongside ALIVE/IDLE/STUCK/PARKED_PICKER
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

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

export interface HistoryEntry {
  tick_unix: number
  hash: string | null   // null = gap entry
  gap_reason?: string
}

export interface AgentLoopState {
  agent: string
  history: HistoryEntry[]
  is_loop: boolean
  loop_triggering_hash: string | null
}

export type LoopDetectorFile = Record<string, AgentLoopState>

export interface TickInput {
  classifierState: ClassifierState
  status_text?: string | null
  tool_call_signature?: string | null  // raw tool call JSON string or null
  pane_bottom_line?: string | null
  has_transcript_entry?: boolean
  has_write_status?: boolean
}

export interface TickResult {
  is_loop: boolean
  hash: string | null
  recovery: boolean   // true if LOOP was cleared this tick
  skipped: boolean    // true if excluded state
}

export interface LoopDetectorOptions {
  historyPath?: string
  consecutiveN?: number
  windowSize?: number
  majorityThreshold?: number
}

// ---------------------------------------------------------------------------
// Canonical JSON (RFC 8785 / JCS-style)
// ---------------------------------------------------------------------------

/**
 * Produces a canonical JSON string with sorted keys (recursive).
 * This ensures identical signatures for tool calls with semantically identical args.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(v => canonicalJson(v)).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
  return '{' + pairs.join(',') + '}'
}

/**
 * Compute tool-call signature from a tool name and args object.
 * Returns sha256 hex of canonical({tool_name, args}).
 */
export function computeToolCallSignature(toolName: string, args: unknown): string {
  const canonical = canonicalJson({ tool_name: toolName, args })
  return createHash('sha256').update(canonical).digest('hex')
}

// ---------------------------------------------------------------------------
// LoopDetector
// ---------------------------------------------------------------------------

export class LoopDetector {
  private historyPath: string
  private consecutiveN: number
  private windowSize: number
  private majorityThreshold: number

  constructor(opts: LoopDetectorOptions = {}) {
    const defaultDir = join(homedir(), '.claude', 'state', 'heartbeat-v2')
    this.historyPath = opts.historyPath ?? join(defaultDir, 'loop-detector.json')
    this.consecutiveN = opts.consecutiveN
      ?? parseInt(process.env['LOOP_DETECTOR_N'] ?? '6', 10)
    this.windowSize = opts.windowSize ?? 12
    this.majorityThreshold = opts.majorityThreshold ?? 9

    // Ensure dir exists
    const dir = dirname(this.historyPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  // ── Load/save state ───────────────────────────────────────────────────────

  private loadState(): LoopDetectorFile {
    if (!existsSync(this.historyPath)) return {}
    try {
      return JSON.parse(readFileSync(this.historyPath, 'utf-8')) as LoopDetectorFile
    } catch {
      return {}
    }
  }

  private saveState(state: LoopDetectorFile): void {
    const dir = dirname(this.historyPath)
    const tmp = join(dir, `.loop-detector-tmp-${Date.now()}.json`)
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
      renameSync(tmp, this.historyPath)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  }

  // ── Compute loop hash for a tick ──────────────────────────────────────────

  computeLoopHash(
    status_text: string | null | undefined,
    tool_call_signature: string | null | undefined,
    pane_bottom_line: string | null | undefined,
  ): string | 'EMPTY' {
    const statusStr = (status_text ?? '').trim()
    const toolSig = tool_call_signature ?? null
    const paneStr = (pane_bottom_line ?? '').trim()

    // Empty sentinel
    if (statusStr === '' && toolSig === null) {
      return 'EMPTY'
    }

    const combined = `${statusStr}|${toolSig ?? ''}|${paneStr}`
    return createHash('sha256').update(combined).digest('hex')
  }

  // ── Detection logic ───────────────────────────────────────────────────────

  private checkLoopTrigger(history: HistoryEntry[]): boolean {
    if (history.length === 0) return false

    // Consecutive-N trigger: count trailing consecutive identical non-null hashes
    // A gap (null) breaks the consecutive run
    let consecCount = 0
    let consecHash: string | null = null
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (entry.hash === null) break  // gap breaks consecutive run
      if (consecHash === null) {
        consecHash = entry.hash
        consecCount = 1
      } else if (entry.hash === consecHash) {
        consecCount++
      } else {
        break
      }
      if (consecCount >= this.consecutiveN) return true
    }

    // Windowed supermajority trigger: use non-null hashes from last windowSize entries
    const windowEntries = history.slice(-this.windowSize)
    const nonNullInWindow = windowEntries
      .filter(e => e.hash !== null)
      .map(e => e.hash as string)
    if (nonNullInWindow.length >= this.majorityThreshold) {
      const counts = new Map<string, number>()
      for (const h of nonNullInWindow) {
        counts.set(h, (counts.get(h) ?? 0) + 1)
      }
      for (const [, count] of counts) {
        if (count >= this.majorityThreshold) return true
      }
    }

    return false
  }

  private getLoopTriggeringHash(history: HistoryEntry[]): string | null {
    // Check consecutive run first
    let consecCount = 0
    let consecHash: string | null = null
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (entry.hash === null) break
      if (consecHash === null) {
        consecHash = entry.hash
        consecCount = 1
      } else if (entry.hash === consecHash) {
        consecCount++
      } else {
        break
      }
      if (consecCount >= this.consecutiveN) return consecHash
    }
    // Windowed supermajority
    const windowEntries = history.slice(-this.windowSize)
    const nonNullInWindow = windowEntries
      .filter(e => e.hash !== null)
      .map(e => e.hash as string)
    const counts = new Map<string, number>()
    for (const h of nonNullInWindow) {
      counts.set(h, (counts.get(h) ?? 0) + 1)
    }
    let maxHash: string | null = null
    let maxCount = 0
    for (const [h, count] of counts) {
      if (count > maxCount) { maxCount = count; maxHash = h }
    }
    return maxHash
  }

  // ── Main tick ─────────────────────────────────────────────────────────────

  tick(
    agent: string,
    input: TickInput,
    nowSec?: number,
  ): TickResult {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const classState = input.classifierState

    // Exclusions: IDLE, PARKED_PICKER, PARKED_PICKER_STALE
    if (classState === 'IDLE' || classState === 'PARKED_PICKER' || classState === 'PARKED_PICKER_STALE') {
      return { is_loop: false, hash: null, recovery: false, skipped: true }
    }

    const state = this.loadState()
    let agentState = state[agent] ?? {
      agent,
      history: [],
      is_loop: false,
      loop_triggering_hash: null,
    }

    // Boot guard: require transcript entry AND write_status
    const hasTranscript = input.has_transcript_entry ?? true
    const hasWriteStatus = input.has_write_status ?? true

    if (!hasTranscript || !hasWriteStatus) {
      // Record null gap
      agentState.history = this.addToHistory(agentState.history, {
        tick_unix: now,
        hash: null,
        gap_reason: !hasTranscript ? 'no_transcript' : 'no_write_status',
      })
      state[agent] = agentState
      this.saveState(state)
      return { is_loop: false, hash: null, recovery: false, skipped: false }
    }

    // Compute hash
    const hash = this.computeLoopHash(input.status_text, input.tool_call_signature, input.pane_bottom_line)

    // Recovery check: if currently in LOOP and hash differs from triggering hash
    if (agentState.is_loop && agentState.loop_triggering_hash !== null) {
      if (hash !== agentState.loop_triggering_hash) {
        // Recovery!
        agentState.is_loop = false
        agentState.loop_triggering_hash = null
        agentState.history = this.addToHistory(agentState.history, { tick_unix: now, hash })
        state[agent] = agentState
        this.saveState(state)
        return { is_loop: false, hash, recovery: true, skipped: false }
      } else {
        // Still same hash: still LOOP
        agentState.history = this.addToHistory(agentState.history, { tick_unix: now, hash })
        state[agent] = agentState
        this.saveState(state)
        return { is_loop: true, hash, recovery: false, skipped: false }
      }
    }

    // Add current hash to history
    agentState.history = this.addToHistory(agentState.history, { tick_unix: now, hash })

    // Check for loop trigger (uses full history so gaps break consecutive runs)
    if (this.checkLoopTrigger(agentState.history)) {
      agentState.is_loop = true
      agentState.loop_triggering_hash = this.getLoopTriggeringHash(agentState.history)
    }

    state[agent] = agentState
    this.saveState(state)

    return { is_loop: agentState.is_loop, hash, recovery: false, skipped: false }
  }

  // ── Manage history (rolling window of last 12) ────────────────────────────

  private addToHistory(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
    const updated = [...history, entry]
    // Keep last 12 entries (including gap entries for window management)
    if (updated.length > this.windowSize) {
      return updated.slice(-this.windowSize)
    }
    return updated
  }

  // ── Get agent state (for testing) ─────────────────────────────────────────

  getAgentState(agent: string): AgentLoopState | undefined {
    const state = this.loadState()
    return state[agent]
  }
}
