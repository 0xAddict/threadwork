/**
 * parked-picker-classifier.ts — DEL-2: Parked-picker first-class state
 *
 * Sprint 1 — Extends the heartbeat-v2 classifier to detect agents parked at
 * Claude Code UI pickers (tool-permission prompts, plan-mode confirm, etc.)
 *
 * States emitted:
 * - PARKED_PICKER — agent is at a recognized picker with an active prompt marker
 * - PARKED_PICKER_STALE — agent has been at a picker for > staleTtlSec (default 3601s)
 *
 * Gated by:
 * - picker-signatures.json (hot-reloaded, versioned)
 * - active-prompt-marker: pane must have an active prompt (not just scrollback)
 *
 * Routing:
 * - PARKED_PICKER/STALE → heartbeat-v2 pipeline (NOT subagent-stall-watcher 40min path)
 * - isReadyForDispatch() → false for PARKED_PICKER / PARKED_PICKER_STALE
 */

import { readFileSync, statSync, existsSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PickerSubtype = 'tool_permission_prompt' | 'plan_mode_confirm' | 'other'

export interface PickerSignature {
  id: string
  picker_subtype: PickerSubtype
  patterns: string[]
}

export interface PickerSignaturesFile {
  version: string
  updated: string
  signatures: PickerSignature[]
}

export interface ParkedPickerState {
  state: 'PARKED_PICKER' | 'PARKED_PICKER_STALE' | null
  picker_subtype: PickerSubtype | null
  state_entered_at: string | null // ISO8601
  matched_snippet: string | null
  agent: string
}

export interface ClassifierOptions {
  signaturesPath?: string
  pickerOthersLogPath?: string
  staleTtlSec?: number // default 3601s (>1 hour)
}

// ---------------------------------------------------------------------------
// Per-agent state tracking
// ---------------------------------------------------------------------------

interface AgentPickerState {
  state_entered_at: string
  picker_subtype: PickerSubtype
  stale_fired: boolean // track whether STALE has been emitted once
}

// ---------------------------------------------------------------------------
// ParkedPickerClassifier
// ---------------------------------------------------------------------------

export class ParkedPickerClassifier {
  private signaturesPath: string
  private pickerOthersLogPath: string
  private staleTtlSec: number
  private signatures: PickerSignature[] = []
  private signaturesMtime: number = 0
  private agentStates: Map<string, AgentPickerState> = new Map()

  constructor(opts: ClassifierOptions = {}) {
    this.signaturesPath = opts.signaturesPath ??
      join(homedir(), '.claude', 'state', 'heartbeat-v2', 'picker-signatures.json')
    this.pickerOthersLogPath = opts.pickerOthersLogPath ??
      join(homedir(), '.claude', 'state', 'heartbeat-v2', 'picker-others.log')
    this.staleTtlSec = opts.staleTtlSec ?? 3601

    this.reloadSignatures()
  }

  // -------------------------------------------------------------------------
  // Hot-reload of picker-signatures.json
  // -------------------------------------------------------------------------

  private reloadSignatures(): void {
    if (!existsSync(this.signaturesPath)) {
      // No signatures file — treat all as 'other' or unrecognized
      this.signatures = []
      return
    }
    try {
      const stat = statSync(this.signaturesPath)
      if (stat.mtimeMs === this.signaturesMtime) return // no change
      const raw = readFileSync(this.signaturesPath, 'utf-8')
      const parsed: PickerSignaturesFile = JSON.parse(raw)
      this.signatures = parsed.signatures ?? []
      this.signaturesMtime = stat.mtimeMs
    } catch (err) {
      process.stderr.write(`[parked-picker] WARN: Failed to reload picker-signatures.json: ${err}\n`)
    }
  }

  // Force reload (for tests)
  forceReload(): void {
    this.signaturesMtime = 0
    this.reloadSignatures()
  }

  getSignatures(): PickerSignature[] {
    return this.signatures
  }

  // -------------------------------------------------------------------------
  // Active prompt marker detection
  // Active prompt = pane content shows a prompt at the BOTTOM (last 5 lines)
  // Scrollback-only matches should NOT trigger PARKED_PICKER
  // -------------------------------------------------------------------------

  hasActivePrompt(paneContent: string): boolean {
    if (!paneContent || paneContent.trim().length === 0) return false
    const lines = paneContent.split('\n')
    // Look at the last 5 lines for the prompt marker
    const lastLines = lines.slice(-5).join('\n')
    return (
      lastLines.includes('❯') ||
      lastLines.includes('Allow Claude') ||
      lastLines.includes('Allow the following tool') ||
      lastLines.includes('Do you want to proceed') ||
      lastLines.includes('Execute the plan?') ||
      lastLines.includes('Approve plan') ||
      lastLines.includes('[Y/n]') ||
      lastLines.includes('[y/N]') ||
      lastLines.includes('Yes / No') ||
      lastLines.includes('(y/n)')
    )
  }

  // -------------------------------------------------------------------------
  // Classify pane content
  // -------------------------------------------------------------------------

  classify(agent: string, paneContent: string, nowIso?: string): ParkedPickerState {
    // Hot-reload signatures
    this.reloadSignatures()

    const now = nowIso ?? new Date().toISOString()

    // Check active prompt marker first
    if (!this.hasActivePrompt(paneContent)) {
      // No active prompt — clear any picker state for this agent
      this.agentStates.delete(agent)
      return { state: null, picker_subtype: null, state_entered_at: null, matched_snippet: null, agent }
    }

    // Match against known signatures
    let matchedSubtype: PickerSubtype | null = null
    let matchedSnippet: string | null = null

    for (const sig of this.signatures) {
      for (const pattern of sig.patterns) {
        if (paneContent.includes(pattern)) {
          matchedSubtype = sig.picker_subtype
          matchedSnippet = pattern
          break
        }
      }
      if (matchedSubtype) break
    }

    // Unrecognized picker → 'other', log to picker-others.log
    if (!matchedSubtype) {
      matchedSubtype = 'other'
      // Extract a snippet from the last 5 lines for the log
      const lines = paneContent.split('\n')
      matchedSnippet = lines.slice(-5).join(' ').trim().slice(0, 200)
      this.logOther(agent, matchedSnippet, now)
    }

    // Check/update per-agent state
    const existing = this.agentStates.get(agent)
    if (!existing) {
      // First time seeing this picker
      const state: AgentPickerState = {
        state_entered_at: now,
        picker_subtype: matchedSubtype,
        stale_fired: false,
      }
      this.agentStates.set(agent, state)
      return {
        state: 'PARKED_PICKER',
        picker_subtype: matchedSubtype,
        state_entered_at: now,
        matched_snippet: matchedSnippet,
        agent,
      }
    }

    // Check staleness
    const enteredAt = new Date(existing.state_entered_at)
    const elapsedSec = (new Date(now).getTime() - enteredAt.getTime()) / 1000

    if (elapsedSec >= this.staleTtlSec) {
      // STALE — fire once per entry
      const wasStale = existing.stale_fired
      existing.stale_fired = true

      if (!wasStale) {
        // First STALE fire
        return {
          state: 'PARKED_PICKER_STALE',
          picker_subtype: existing.picker_subtype,
          state_entered_at: existing.state_entered_at,
          matched_snippet: matchedSnippet,
          agent,
        }
      } else {
        // Already fired STALE once — return PARKED_PICKER (not STALE again, per C2.6)
        return {
          state: 'PARKED_PICKER',
          picker_subtype: existing.picker_subtype,
          state_entered_at: existing.state_entered_at,
          matched_snippet: matchedSnippet,
          agent,
        }
      }
    }

    // Not yet stale
    return {
      state: 'PARKED_PICKER',
      picker_subtype: existing.picker_subtype,
      state_entered_at: existing.state_entered_at,
      matched_snippet: matchedSnippet,
      agent,
    }
  }

  // Called when agent is NOT at a picker (clears state for STALE re-fire logic)
  clearAgentState(agent: string): void {
    this.agentStates.delete(agent)
  }

  getAgentStateEnteredAt(agent: string): string | null {
    return this.agentStates.get(agent)?.state_entered_at ?? null
  }

  // -------------------------------------------------------------------------
  // Logging unknown pickers
  // -------------------------------------------------------------------------

  private logOther(agent: string, snippet: string, ts: string): void {
    try {
      const dir = this.pickerOthersLogPath.replace(/\/[^/]+$/, '')
      mkdirSync(dir, { recursive: true })
      const line = `${ts} agent=${agent} snippet=${JSON.stringify(snippet)}\n`
      appendFileSync(this.pickerOthersLogPath, line)
    } catch (err) {
      process.stderr.write(`[parked-picker] WARN: Failed to write picker-others.log: ${err}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// isReadyForDispatch — re-exported from inhibit-engine for convenience
// ---------------------------------------------------------------------------
export { isReadyForDispatch } from './inhibit-engine'
