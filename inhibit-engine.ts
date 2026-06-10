/**
 * inhibit-engine.ts — Heartbeat-v2 Inhibition Engine
 *
 * Sprint 1 / DEL-1 — Alertmanager-style inhibition with:
 * - Canonical 5-label schema validation (loaded from labels.schema.json, fail-hard on mismatch)
 * - Hot-reloaded inhibit_rules.json (file-watcher + mtime check per tick)
 * - OR-semantics on equal_labels (a target is suppressed if ANY matching rule fires)
 * - Suppressed-alert logging to inhibit.log
 * - Stale-inhibition meta-alert at 12 consecutive active ticks
 * - Pinned pipeline order: CLASSIFY → INHIBIT → DEDUP → GROUP → EMIT
 */

import { readFileSync, statSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlertLabel {
  agent: string
  session: string
  state: string
  reason_class: string
  host: string
  picker_subtype?: string
  [key: string]: string | undefined
}

export interface InhibitRule {
  id: string
  source_match: Record<string, string>
  target_match: Record<string, string>
  equal_labels: string[]
  expires_at?: string // ISO8601
  comment?: string
  applies_to_critical?: boolean  // DEL-3 §6: if false/absent, rule does NOT suppress CRITICAL alerts
}

export interface InhibitResult {
  survivors: AlertLabel[]
  suppressed: AlertLabel[]
  suppressedByRule: Map<string, AlertLabel[]> // rule_id → suppressed alerts
}

export interface EngineOptions {
  rulesPath: string | null   // null = in-memory (for tests)
  inhibitLogPath: string | null // null = no logging (for tests)
  schemaPath?: string | null
  metaAlertCallback?: (msg: string, ruleId: string, suppressedCount: number) => void
  staleTickThreshold?: number // default 12
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DEFAULT_SCHEMA_PATH = join(homedir(), '.claude', 'state', 'heartbeat-v2', 'labels.schema.json')
const CANONICAL_LABELS = ['agent', 'session', 'state', 'reason_class', 'host']

function loadSchema(schemaPath: string | null | undefined): Set<string> {
  const path = schemaPath ?? DEFAULT_SCHEMA_PATH
  if (!path || !existsSync(path)) {
    // Return defaults if schema file doesn't exist (test mode)
    return new Set(CANONICAL_LABELS)
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const schema = JSON.parse(raw)
    const labels = Object.keys(schema.labels ?? {})
    const extensions = Object.keys(schema.extensions ?? {})
    return new Set([...labels, ...extensions])
  } catch (err) {
    throw new Error(`[SCHEMA_MISMATCH] Failed to load labels.schema.json: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// InhibitionEngine
// ---------------------------------------------------------------------------

export class InhibitionEngine {
  private rules: InhibitRule[] = []
  private rulesPath: string | null
  private inhibitLogPath: string | null
  private schemaPath: string | null
  private validLabels: Set<string>
  private metaAlertCallback: ((msg: string, ruleId: string, count: number) => void) | undefined
  private staleTickThreshold: number
  // Per-rule active-tick counter for stale-inhibition meta-alerts
  private ruleActiveTicks: Map<string, number> = new Map()
  private ruleSuppressedCounts: Map<string, number> = new Map()
  // Rules file mtime cache for hot-reload
  private rulesMtime: number = 0

  constructor(opts: EngineOptions) {
    this.rulesPath = opts.rulesPath
    this.inhibitLogPath = opts.inhibitLogPath
    this.schemaPath = opts.schemaPath ?? null
    this.metaAlertCallback = opts.metaAlertCallback
    this.staleTickThreshold = opts.staleTickThreshold ?? 12
    this.validLabels = loadSchema(this.schemaPath)

    if (this.rulesPath && existsSync(this.rulesPath)) {
      this.reloadRules()
    }
  }

  // -------------------------------------------------------------------------
  // Schema validation (C0.4 — fail-hard on mismatch)
  // -------------------------------------------------------------------------

  validateLabels(alert: AlertLabel): void {
    const requiredLabels = ['agent', 'session', 'state', 'reason_class', 'host']
    for (const label of requiredLabels) {
      if (!(label in alert) || alert[label] === undefined || alert[label] === '') {
        throw new Error(`[SCHEMA_MISMATCH] Required label '${label}' missing or empty in alert: ${JSON.stringify(alert)}`)
      }
    }
    // Check for unknown labels (non-canonical)
    for (const key of Object.keys(alert)) {
      if (!this.validLabels.has(key)) {
        throw new Error(`[SCHEMA_MISMATCH] Label '${key}' not in canonical schema. Canonical labels: ${Array.from(this.validLabels).join(', ')}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Hot-reload of inhibit_rules.json
  // -------------------------------------------------------------------------

  private reloadRules(): void {
    if (!this.rulesPath) return
    try {
      const stat = statSync(this.rulesPath)
      const mtime = stat.mtimeMs
      if (mtime === this.rulesMtime) return // no change

      const raw = readFileSync(this.rulesPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const rules: InhibitRule[] = Array.isArray(parsed) ? parsed : parsed.rules ?? []
      this.rules = rules
      this.rulesMtime = mtime
    } catch (err) {
      // Malformed JSON: zero inhibitions, log to stderr, emit meta-alert
      process.stderr.write(`[inhibit-engine] WARN: Failed to reload rules from ${this.rulesPath}: ${err}\n`)
      if (this.metaAlertCallback) {
        this.metaAlertCallback(`[META-ALERT] inhibit_rules.json invalid: ${err}`, 'meta:rules-invalid', 0)
      }
      // Keep existing rules (don't wipe them on transient error)
    }
  }

  // Allow external callers to set rules (for tests)
  setRules(rules: InhibitRule[]): void {
    this.rules = rules
  }

  getRules(): InhibitRule[] {
    return this.rules
  }

  // -------------------------------------------------------------------------
  // Apply inhibition (Stage 2 of pipeline)
  // -------------------------------------------------------------------------

  applyInhibition(alerts: AlertLabel[], rulesOverride?: InhibitRule[]): InhibitResult {
    // Hot-reload rules if using file
    if (!rulesOverride && this.rulesPath) {
      this.reloadRules()
    }
    const activeRules = rulesOverride ?? this.rules

    const now = new Date()
    const effectiveRules = activeRules.filter(rule => {
      if (rule.expires_at) {
        const exp = new Date(rule.expires_at)
        if (exp < now) {
          process.stderr.write(`[inhibit-engine] WARN: Rule '${rule.id}' expired at ${rule.expires_at}, skipping\n`)
          return false
        }
      }
      return true
    })

    // Determine which alerts are sources (match source_match)
    const survivors: AlertLabel[] = []
    const suppressed: AlertLabel[] = []
    const suppressedByRule = new Map<string, AlertLabel[]>()
    const rulesFiredThisTick = new Set<string>()

    for (const alert of alerts) {
      let isSuppressed = false

      for (const rule of effectiveRules) {
        // Check if any source alert matches source_match
        const sourceExists = alerts.some(src => matchLabels(src, rule.source_match))
        if (!sourceExists) continue

        // Check if alert matches target_match
        if (!matchLabels(alert, rule.target_match)) continue

        // Check equal_labels: for each equal label, alert must have same value as source
        // (OR-semantics: target is suppressed if ANY matching source shares the equal label values)
        const hasMatchingSource = alerts.some(src => {
          if (!matchLabels(src, rule.source_match)) return false
          // The source itself should not be suppressed by its own rule
          if (matchLabels(src, rule.target_match) && labelsEqual(src, alert, rule.equal_labels)) {
            // If source and target have same labels, source takes priority (not suppressed)
            return false
          }
          return rule.equal_labels.every(label => {
            // If alert is missing the equal label, do NOT inhibit (C1.10)
            if (!(label in alert) || alert[label] === undefined) return false
            if (!(label in src) || src[label] === undefined) return false
            return alert[label] === src[label]
          })
        })

        if (hasMatchingSource) {
          // DEL-3 §6: CRITICAL alerts are inhibition-resistant by default.
          // A rule only suppresses CRITICAL alerts if applies_to_critical === true.
          if (alert.severity === 'CRITICAL' && !rule.applies_to_critical) {
            continue  // Skip this rule for CRITICAL alerts (unless explicitly enabled)
          }
          isSuppressed = true
          rulesFiredThisTick.add(rule.id)
          if (!suppressedByRule.has(rule.id)) suppressedByRule.set(rule.id, [])
          suppressedByRule.get(rule.id)!.push(alert)
          this.logSuppressed(alert, rule.id)
          // Track suppressed count per rule
          this.ruleSuppressedCounts.set(rule.id, (this.ruleSuppressedCounts.get(rule.id) ?? 0) + 1)
          break // OR-semantics: first matching rule wins (alert is suppressed)
        }
      }

      if (!isSuppressed) {
        survivors.push(alert)
      } else {
        suppressed.push(alert)
      }
    }

    // Update active-tick counters and check for stale-inhibition meta-alerts
    for (const rule of effectiveRules) {
      if (rulesFiredThisTick.has(rule.id)) {
        const ticks = (this.ruleActiveTicks.get(rule.id) ?? 0) + 1
        this.ruleActiveTicks.set(rule.id, ticks)
        if (ticks >= this.staleTickThreshold && ticks % this.staleTickThreshold === 0) {
          const count = this.ruleSuppressedCounts.get(rule.id) ?? 0
          const msg = `[META-ALERT] Stale inhibition: rule '${rule.id}' has been active for ${ticks} consecutive ticks, suppressed ${count} alerts total`
          if (this.metaAlertCallback) {
            this.metaAlertCallback(msg, rule.id, count)
          } else {
            process.stderr.write(`${msg}\n`)
          }
        }
      } else {
        // Rule not fired this tick — reset counter
        this.ruleActiveTicks.set(rule.id, 0)
      }
    }

    return { survivors, suppressed, suppressedByRule }
  }

  // -------------------------------------------------------------------------
  // Deduplication (Stage 3 of pipeline)
  // -------------------------------------------------------------------------

  deduplicate(alerts: AlertLabel[]): AlertLabel[] {
    const seen = new Set<string>()
    return alerts.filter(alert => {
      const fingerprint = alertFingerprint(alert)
      if (seen.has(fingerprint)) return false
      seen.add(fingerprint)
      return true
    })
  }

  // -------------------------------------------------------------------------
  // Grouping (Stage 4 of pipeline)
  // -------------------------------------------------------------------------

  group(alerts: AlertLabel[]): Record<string, AlertLabel[]> {
    const groups: Record<string, AlertLabel[]> = {}
    for (const alert of alerts) {
      const key = `${alert.agent}|${alert.host}`
      if (!groups[key]) groups[key] = []
      groups[key].push(alert)
    }
    return groups
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  private logSuppressed(alert: AlertLabel, ruleId: string): void {
    if (!this.inhibitLogPath) return
    const ts = new Date().toISOString()
    const line = `${ts} rule_id=${ruleId} agent=${alert.agent} session=${alert.session} state=${alert.state} reason_class=${alert.reason_class} host=${alert.host}\n`
    try {
      appendFileSync(this.inhibitLogPath, line)
    } catch (err) {
      process.stderr.write(`[inhibit-engine] WARN: Failed to write to inhibit.log: ${err}\n`)
    }
  }

  // -------------------------------------------------------------------------
  // For testing: get active tick count for a rule
  // -------------------------------------------------------------------------

  getRuleActiveTicks(ruleId: string): number {
    return this.ruleActiveTicks.get(ruleId) ?? 0
  }

  resetRuleActiveTicks(ruleId: string): void {
    this.ruleActiveTicks.set(ruleId, 0)
    this.ruleSuppressedCounts.set(ruleId, 0)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchLabels(alert: AlertLabel, match: Record<string, string>): boolean {
  return Object.entries(match).every(([k, v]) => alert[k] === v)
}

function labelsEqual(a: AlertLabel, b: AlertLabel, labels: string[]): boolean {
  return labels.every(l => a[l] === b[l])
}

function alertFingerprint(alert: AlertLabel): string {
  return `${alert.agent}|${alert.session}|${alert.state}|${alert.reason_class}|${alert.host}`
}

// ---------------------------------------------------------------------------
// validateLabels helper — standalone for watchdog.ts integration (C0.4)
// ---------------------------------------------------------------------------

const _schemaCache = new Map<string, Set<string>>()

export function validateLabels(alert: AlertLabel, schemaPath?: string): void {
  const spath = schemaPath ?? DEFAULT_SCHEMA_PATH
  if (!_schemaCache.has(spath)) {
    _schemaCache.set(spath, loadSchema(spath))
  }
  const validLabels = _schemaCache.get(spath)!
  const requiredLabels = ['agent', 'session', 'state', 'reason_class', 'host']
  for (const label of requiredLabels) {
    if (!(label in alert) || alert[label] === undefined || alert[label] === '') {
      throw new Error(`[SCHEMA_MISMATCH] Required label '${label}' missing in alert`)
    }
  }
  for (const key of Object.keys(alert)) {
    if (!validLabels.has(key)) {
      throw new Error(`[SCHEMA_MISMATCH] Label '${key}' not in canonical schema`)
    }
  }
}

// ---------------------------------------------------------------------------
// schemaCheck — alias used by watchdog.ts integration (C0.4 grep check)
// ---------------------------------------------------------------------------

export function schemaCheck(alert: AlertLabel, schemaPath?: string): void {
  validateLabels(alert, schemaPath)
}

// ---------------------------------------------------------------------------
// isReadyForDispatch — C0.10, C2.10
// Returns false if agent is in a state that blocks dispatch
// ---------------------------------------------------------------------------

const DISPATCH_BLOCKING_STATES = new Set(['PARKED_PICKER', 'PARKED_PICKER_STALE', 'SESSION_DEAD', 'CRASHED'])

export function isReadyForDispatch(agentState: string): boolean {
  return !DISPATCH_BLOCKING_STATES.has(agentState)
}
