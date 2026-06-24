/**
 * src/alert-review/index.ts — Alert-effectiveness review loop
 *
 * Sprint 4 / DEL-3 — Weekly review of alert effectiveness with:
 * - emit.log as data source (JSON-lines per alert emission)
 * - TP/FP/AMBIGUOUS/PERSISTENT classification per DoD-11 §2
 * - Top noisy fingerprints, top silenced, per-agent stats
 * - Recommendations engine v1 (3 rules)
 * - Report written to ~/.claude/state/alert-review/<YYYY-MM-DD>.md
 * - task-board send_note for delivery + read-receipt (task stays UNCOMPLETE)
 * - Empty-week handling: report still generated with 0-alert explanation
 *
 * Classification rules (6h action window):
 *   TP:         non-agent-authored task-board action tied to agent within 6h
 *   AMBIGUOUS:  no human action within 6h, but agent wrote status within 6h
 *   FP:         no human action, no agent self-status, agent back to ALIVE/IDLE within 6h
 *   PERSISTENT: no human action, agent still in alert state at 6h
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

export type AlertClass = 'TP' | 'FP' | 'AMBIGUOUS' | 'PERSISTENT'

export interface EmitLogLine {
  timestamp_iso: string
  fingerprint: string
  severity: string
  agent: string
  state: string
  reason_class: string
  destination: string
  emit_method: string
  alert_id: string
}

export interface ClassifiedAlert {
  alert: EmitLogLine
  classification: AlertClass
  action_at_iso?: string   // if TP/AMBIGUOUS
  recovery_at_iso?: string  // if FP
}

export interface AgentAction {
  timestamp_iso: string
  agent: string             // target agent
  author: string            // 'human' or agent name
  action_type: 'note' | 'status' | 'state_change'
}

export interface SuppressEntry {
  fingerprint: string
  suppress_count: number
}

export interface ReviewReport {
  week_start_iso: string
  week_end_iso: string
  total_emissions: number
  by_severity: Record<string, number>
  tp_count: number
  fp_count: number
  ambiguous_count: number
  persistent_count: number
  top_noisy: { fingerprint: string; count: number; fp_pct: number }[]
  top_silenced: { fingerprint: string; suppress_count: number }[]
  per_agent: { agent: string; alert_count: number; tp_rate: number }[]
  recommendations: string[]
  classified: ClassifiedAlert[]
}

export interface AlertReviewOptions {
  emitLogPath?: string
  reportDir?: string
  actionWindowSec?: number  // default 6h = 21600
  topN?: number             // default 10
  // For testing: inject agent actions and suppress data instead of reading from DB
  agentActions?: AgentAction[]
  suppressData?: SuppressEntry[]
  // For testing: provide "current state" per agent at various times
  agentStateResolver?: (agent: string, atSec: number) => string | null
  // For testing: inject a date for the report filename
  reportDateOverride?: string  // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// AlertReviewEngine
// ---------------------------------------------------------------------------

export class AlertReviewEngine {
  private emitLogPath: string
  private reportDir: string
  private actionWindowSec: number
  private topN: number
  private agentActions: AgentAction[]
  private suppressData: SuppressEntry[]
  private agentStateResolver?: (agent: string, atSec: number) => string | null
  private reportDateOverride?: string

  constructor(opts: AlertReviewOptions = {}) {
    const defaultState = join(homedir(), '.claude', 'state', 'heartbeat-v2')
    this.emitLogPath = opts.emitLogPath ?? join(defaultState, 'emit.log')
    this.reportDir = opts.reportDir ?? join(homedir(), '.claude', 'state', 'alert-review')
    this.actionWindowSec = opts.actionWindowSec ?? 21600
    this.topN = opts.topN ?? 10
    this.agentActions = opts.agentActions ?? []
    this.suppressData = opts.suppressData ?? []
    this.agentStateResolver = opts.agentStateResolver
    this.reportDateOverride = opts.reportDateOverride
  }

  // ── Read emit.log lines ──────────────────────────────────────────────────

  readEmitLog(weekStartSec: number, weekEndSec: number): EmitLogLine[] {
    if (!existsSync(this.emitLogPath)) return []
    const lines: EmitLogLine[] = []
    try {
      const raw = readFileSync(this.emitLogPath, 'utf-8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const entry = JSON.parse(trimmed) as EmitLogLine
          const ts = new Date(entry.timestamp_iso).getTime() / 1000
          if (ts >= weekStartSec && ts < weekEndSec) {
            lines.push(entry)
          }
        } catch { /* skip malformed lines */ }
      }
    } catch (err) {
      process.stderr.write(`[alert-review] ERROR reading emit.log: ${err}\n`)
    }
    return lines
  }

  // ── Classify a single alert ──────────────────────────────────────────────

  classifyAlert(
    alert: EmitLogLine,
    actions: AgentAction[],
    stateResolver?: (agent: string, atSec: number) => string | null,
  ): ClassifiedAlert {
    const alertSec = new Date(alert.timestamp_iso).getTime() / 1000
    const windowEndSec = alertSec + this.actionWindowSec

    // Find non-agent-authored actions for this agent within window
    const humanActions = actions.filter(a => {
      const aSec = new Date(a.timestamp_iso).getTime() / 1000
      return a.agent === alert.agent
        && aSec >= alertSec
        && aSec <= windowEndSec
        && a.author !== alert.agent  // not self-authored
        && a.author !== 'boss'       // Boss counts as agent (documented limitation)
        && a.author !== 'kiera'
        && a.author !== 'steve'
        && a.author !== 'sadie'
        // "human" or non-bot author = human action
        && (a.author === 'human' || a.author === 'user')
    })

    if (humanActions.length > 0) {
      return {
        alert,
        classification: 'TP',
        action_at_iso: humanActions[0].timestamp_iso,
      }
    }

    // Check agent self-write_status within window
    const agentSelfActions = actions.filter(a => {
      const aSec = new Date(a.timestamp_iso).getTime() / 1000
      return a.agent === alert.agent
        && aSec >= alertSec
        && aSec <= windowEndSec
        && a.action_type === 'status'
        && a.author === alert.agent
    })

    if (agentSelfActions.length > 0) {
      return {
        alert,
        classification: 'AMBIGUOUS',
        action_at_iso: agentSelfActions[0].timestamp_iso,
      }
    }

    // Check if agent recovered to ALIVE/IDLE within window
    if (stateResolver) {
      // Check at window end
      const stateAtEnd = stateResolver(alert.agent, windowEndSec)
      if (stateAtEnd === 'ALIVE' || stateAtEnd === 'IDLE') {
        // Recovered
        return {
          alert,
          classification: 'FP',
          recovery_at_iso: new Date(windowEndSec * 1000).toISOString(),
        }
      }

      // Check if state is still an alert state at window end
      if (stateAtEnd && stateAtEnd !== 'ALIVE' && stateAtEnd !== 'IDLE') {
        return { alert, classification: 'PERSISTENT' }
      }
    }

    // Default: no info = PERSISTENT (conservative assumption)
    return { alert, classification: 'PERSISTENT' }
  }

  // ── Recommendations engine v1 ─────────────────────────────────────────────

  generateRecommendations(
    classified: ClassifiedAlert[],
    suppressData: SuppressEntry[],
  ): string[] {
    const recs: string[] = []

    // Rule 1: FP rate ≥80% with ≥5 emissions for fingerprint
    const fpByFp = new Map<string, { total: number; fp: number }>()
    for (const c of classified) {
      const fp = c.alert.fingerprint
      const existing = fpByFp.get(fp) ?? { total: 0, fp: 0 }
      existing.total++
      if (c.classification === 'FP') existing.fp++
      fpByFp.set(fp, existing)
    }
    for (const [fp, stats] of fpByFp) {
      if (stats.total >= 5 && stats.fp / stats.total >= 0.8) {
        recs.push(`increase cooldown: fingerprint ${fp} has ${Math.round(stats.fp / stats.total * 100)}% FP rate (${stats.fp}/${stats.total} emissions)`)
      }
    }

    // Rule 2: PERSISTENT count ≥3 for one agent
    const persistentByAgent = new Map<string, number>()
    for (const c of classified) {
      if (c.classification === 'PERSISTENT') {
        persistentByAgent.set(c.alert.agent, (persistentByAgent.get(c.alert.agent) ?? 0) + 1)
      }
    }
    for (const [agent, count] of persistentByAgent) {
      if (count >= 3) {
        recs.push(`investigate persistent issue: agent ${agent} has ${count} PERSISTENT alerts this week`)
      }
    }

    // Rule 3: suppress_count > 50 for a fingerprint
    for (const entry of suppressData) {
      if (entry.suppress_count > 50) {
        recs.push(`verify suppression isn't masking real signal: fingerprint ${entry.fingerprint} suppressed ${entry.suppress_count} times`)
      }
    }

    return recs
  }

  // ── Build report ──────────────────────────────────────────────────────────

  buildReport(
    weekStartSec: number,
    weekEndSec: number,
  ): ReviewReport {
    const emissions = this.readEmitLog(weekStartSec, weekEndSec)
    const actions = this.agentActions
    const suppressData = this.suppressData
    const stateResolver = this.agentStateResolver

    // Classify each alert
    const classified = emissions.map(alert =>
      this.classifyAlert(alert, actions, stateResolver)
    )

    // Counts
    const tp = classified.filter(c => c.classification === 'TP').length
    const fp = classified.filter(c => c.classification === 'FP').length
    const ambiguous = classified.filter(c => c.classification === 'AMBIGUOUS').length
    const persistent = classified.filter(c => c.classification === 'PERSISTENT').length

    // By severity
    const bySeverity: Record<string, number> = {}
    for (const e of emissions) {
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1
    }

    // Top noisy: top-10 fingerprints by count with FP%
    const fpCountMap = new Map<string, { count: number; fp: number }>()
    for (const c of classified) {
      const fp = c.alert.fingerprint
      const existing = fpCountMap.get(fp) ?? { count: 0, fp: 0 }
      existing.count++
      if (c.classification === 'FP') existing.fp++
      fpCountMap.set(fp, existing)
    }
    const topNoisy = Array.from(fpCountMap.entries())
      .map(([fingerprint, stats]) => ({
        fingerprint,
        count: stats.count,
        fp_pct: stats.count > 0 ? Math.round(stats.fp / stats.count * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, this.topN)

    // Top silenced: distinct fingerprints with suppress_count > 0
    const topSilenced = suppressData
      .filter(e => e.suppress_count > 0)
      .sort((a, b) => b.suppress_count - a.suppress_count)
      .slice(0, this.topN)
      .map(e => ({ fingerprint: e.fingerprint, suppress_count: e.suppress_count }))

    // Per-agent stats
    const agentMap = new Map<string, { count: number; tp: number }>()
    for (const c of classified) {
      const a = c.alert.agent
      const existing = agentMap.get(a) ?? { count: 0, tp: 0 }
      existing.count++
      if (c.classification === 'TP') existing.tp++
      agentMap.set(a, existing)
    }
    const perAgent = Array.from(agentMap.entries())
      .map(([agent, stats]) => ({
        agent,
        alert_count: stats.count,
        tp_rate: stats.count > 0 ? Math.round(stats.tp / stats.count * 100) / 100 : 0,
      }))
      .sort((a, b) => b.alert_count - a.alert_count)

    // Recommendations
    const recommendations = this.generateRecommendations(classified, suppressData)

    return {
      week_start_iso: new Date(weekStartSec * 1000).toISOString(),
      week_end_iso: new Date(weekEndSec * 1000).toISOString(),
      total_emissions: emissions.length,
      by_severity: bySeverity,
      tp_count: tp,
      fp_count: fp,
      ambiguous_count: ambiguous,
      persistent_count: persistent,
      top_noisy: topNoisy,
      top_silenced: topSilenced,
      per_agent: perAgent,
      recommendations,
      classified,
    }
  }

  // ── Render report to markdown ─────────────────────────────────────────────

  renderMarkdown(report: ReviewReport): string {
    const lines: string[] = []
    const isEmpty = report.total_emissions === 0

    lines.push(`# Alert-Effectiveness Review — ${report.week_start_iso.slice(0, 10)}`)
    lines.push('')

    // Summary section
    lines.push('## Summary')
    if (isEmpty) {
      lines.push('')
      lines.push('**0 alerts** were emitted this week.')
      lines.push('')
      lines.push('This could indicate the heartbeat system is healthy — or that the deadmans-sentinel')
      lines.push('(`~/bin/deadmans-sentinel.sh`) may not be running. Please verify it is active.')
      lines.push('')
    } else {
      lines.push('')
      lines.push(`- **Total emissions**: ${report.total_emissions}`)
      for (const [sev, count] of Object.entries(report.by_severity)) {
        lines.push(`  - ${sev}: ${count}`)
      }
      lines.push(`- **TP**: ${report.tp_count}`)
      lines.push(`- **FP**: ${report.fp_count}`)
      lines.push(`- **AMBIGUOUS**: ${report.ambiguous_count}`)
      lines.push(`- **PERSISTENT**: ${report.persistent_count}`)
      lines.push('')
    }

    // Top noisy section
    lines.push('## Top Noisy Fingerprints')
    lines.push('')
    if (report.top_noisy.length === 0) {
      lines.push('_No data_')
    } else {
      lines.push('| Fingerprint | Count | FP% |')
      lines.push('|---|---|---|')
      for (const n of report.top_noisy) {
        lines.push(`| ${n.fingerprint} | ${n.count} | ${n.fp_pct}% |`)
      }
    }
    lines.push('')

    // Top silenced section
    lines.push('## Top Silenced')
    lines.push('')
    if (report.top_silenced.length === 0) {
      lines.push('_No data_')
    } else {
      lines.push('| Fingerprint | Suppress Count |')
      lines.push('|---|---|')
      for (const s of report.top_silenced) {
        lines.push(`| ${s.fingerprint} | ${s.suppress_count} |`)
      }
    }
    lines.push('')

    // Per-agent section
    lines.push('## Per-Agent')
    lines.push('')
    if (report.per_agent.length === 0) {
      lines.push('_No data_')
    } else {
      lines.push('| Agent | Alert Count | TP Rate |')
      lines.push('|---|---|---|')
      for (const a of report.per_agent) {
        lines.push(`| ${a.agent} | ${a.alert_count} | ${(a.tp_rate * 100).toFixed(0)}% |`)
      }
    }
    lines.push('')

    // Recommendations section
    lines.push('## Recommendations')
    lines.push('')
    if (report.recommendations.length === 0) {
      lines.push('_No recommendations this week — healthy alert pattern._')
    } else {
      for (const rec of report.recommendations) {
        lines.push(`- ${rec}`)
      }
    }
    lines.push('')

    return lines.join('\n')
  }

  // ── Write report to file ──────────────────────────────────────────────────

  writeReport(
    report: ReviewReport,
    markdown: string,
    dateStr?: string,
  ): string {
    const ds = dateStr ?? report.week_start_iso.slice(0, 10)
    if (!existsSync(this.reportDir)) mkdirSync(this.reportDir, { recursive: true })
    const reportPath = join(this.reportDir, `${ds}.md`)
    writeFileSync(reportPath, markdown, 'utf-8')
    return reportPath
  }

  // ── Full run ──────────────────────────────────────────────────────────────

  run(
    weekStartSec: number,
    weekEndSec: number,
    onSendNote?: (message: string, reportPath: string) => void,
  ): { reportPath: string; report: ReviewReport } {
    const report = this.buildReport(weekStartSec, weekEndSec)
    const markdown = this.renderMarkdown(report)
    const dateStr = this.reportDateOverride ?? report.week_start_iso.slice(0, 10)
    const reportPath = this.writeReport(report, markdown, dateStr)

    if (onSendNote) {
      const summary = [
        `Alert-review report for week of ${dateStr}:`,
        `${report.total_emissions} emissions`,
        `TP=${report.tp_count} FP=${report.fp_count} AMBIGUOUS=${report.ambiguous_count} PERSISTENT=${report.persistent_count}`,
        `${report.recommendations.length} recommendation(s)`,
        `Report at: ${reportPath}`,
      ].join(' | ')
      onSendNote(summary, reportPath)
    }

    return { reportPath, report }
  }
}

// ---------------------------------------------------------------------------
// Installer: generate launchd plist
// ---------------------------------------------------------------------------

export interface PlistOptions {
  plistPath?: string
  runnerScript?: string
  calendarInterval?: { Weekday: number; Hour: number; Minute: number }
}

export function generateAlertReviewPlist(opts: PlistOptions = {}): string {
  const plistPath = opts.plistPath ?? join(
    homedir(), 'Library', 'LaunchAgents', 'com.threadwork.alert-review.plist'
  )
  const runnerScript = opts.runnerScript ?? join(
    homedir(), '.claude', 'mcp-servers', 'task-board', 'src', 'alert-review', 'runner.sh'
  )
  const interval = opts.calendarInterval ?? { Weekday: 1, Hour: 9, Minute: 0 }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.threadwork.alert-review</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${runnerScript}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>${interval.Weekday}</integer>
    <key>Hour</key>
    <integer>${interval.Hour}</integer>
    <key>Minute</key>
    <integer>${interval.Minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.claude', 'state', 'alert-review', 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.claude', 'state', 'alert-review', 'stderr.log')}</string>
</dict>
</plist>
`
  const dir = dirname(plistPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(plistPath, plist, 'utf-8')
  return plistPath
}

// ---------------------------------------------------------------------------
// Installer: parse ALERT_REVIEW_CRON env and generate plist
// ---------------------------------------------------------------------------

/**
 * Parse a simple "WEEKDAY HH:MM" format cron-ish string.
 * Examples: "1 09:00" = Monday 09:00, "5 17:00" = Friday 17:00
 * Returns { Weekday, Hour, Minute } or null if unparseable.
 */
export function parseAlertReviewCron(
  cronStr: string,
): { Weekday: number; Hour: number; Minute: number } | null {
  const parts = cronStr.trim().split(/\s+/)
  if (parts.length < 2) return null
  const weekday = parseInt(parts[0], 10)
  const timeParts = parts[1].split(':')
  if (timeParts.length < 2) return null
  const hour = parseInt(timeParts[0], 10)
  const minute = parseInt(timeParts[1], 10)
  if (isNaN(weekday) || isNaN(hour) || isNaN(minute)) return null
  return { Weekday: weekday, Hour: hour, Minute: minute }
}

/**
 * Install the launchd plist, respecting ALERT_REVIEW_CRON env if set.
 */
export function installAlertReviewPlist(opts: PlistOptions = {}): string {
  const cronStr = process.env['ALERT_REVIEW_CRON']
  let calendarInterval = opts.calendarInterval
  if (cronStr) {
    const parsed = parseAlertReviewCron(cronStr)
    if (parsed) calendarInterval = parsed
  }
  return generateAlertReviewPlist({ ...opts, calendarInterval })
}
