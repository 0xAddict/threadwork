#!/usr/bin/env bash
# =============================================================================
# src/alert-review/runner-soak.sh — 48h soak-mode FP-monitor runner
#
# Sprint 4 follow-up — invoked every 6h by com.threadwork.alert-review-soak
# launchd plist. Scopes alert classification to a configurable soak window,
# counts FPs in the rolling 24h sub-window, and:
#   • writes ~/.claude/state/alert-review/soak/tick-<ISO>.md per invocation
#   • Telegrams "[SOAK BREACH]" once FP count crosses threshold in any 24h window
#   • Telegrams a final PASS/FAIL verdict at SOAK_END_ISO
#
# Env vars (set by launchd plist; defaults preserve safety if missing):
#   ALERT_REVIEW_MODE              soak (must be "soak" to run this script)
#   ALERT_REVIEW_WINDOW_HOURS      24
#   ALERT_REVIEW_FP_THRESHOLD      8
#   ALERT_REVIEW_SOAK_START_ISO    e.g. 2026-05-27T12:00:00Z
#   ALERT_REVIEW_SOAK_END_ISO      e.g. 2026-05-29T12:00:00Z
#   ALERT_REVIEW_TG_CHAT_ID        Telegram chat id (default 1712539766)
#   TELEGRAM_TOKEN                 from ~/.threadwork/secrets.env
#
# Idempotency:
#   - Breach TG is fired at most ONCE (state file marks it).
#   - Final TG is fired at most ONCE (state file marks it).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_BOARD_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Load secrets if env vars not already set
if [[ -z "${TELEGRAM_TOKEN:-}" && -f "$HOME/.threadwork/secrets.env" ]]; then
  set +u
  # shellcheck disable=SC1091
  source "$HOME/.threadwork/secrets.env"
  set -u
fi

# Defaults
ALERT_REVIEW_MODE="${ALERT_REVIEW_MODE:-soak}"
ALERT_REVIEW_WINDOW_HOURS="${ALERT_REVIEW_WINDOW_HOURS:-24}"
ALERT_REVIEW_FP_THRESHOLD="${ALERT_REVIEW_FP_THRESHOLD:-8}"
ALERT_REVIEW_TG_CHAT_ID="${ALERT_REVIEW_TG_CHAT_ID:-1712539766}"
ALERT_REVIEW_SOAK_START_ISO="${ALERT_REVIEW_SOAK_START_ISO:-}"
ALERT_REVIEW_SOAK_END_ISO="${ALERT_REVIEW_SOAK_END_ISO:-}"

if [[ "$ALERT_REVIEW_MODE" != "soak" ]]; then
  echo "[runner-soak] ALERT_REVIEW_MODE=$ALERT_REVIEW_MODE != 'soak'; exiting." >&2
  exit 0
fi
if [[ -z "$ALERT_REVIEW_SOAK_START_ISO" || -z "$ALERT_REVIEW_SOAK_END_ISO" ]]; then
  echo "[runner-soak] FATAL: ALERT_REVIEW_SOAK_START_ISO / END_ISO required" >&2
  exit 1
fi

REPORT_DIR="${HOME}/.claude/state/alert-review/soak"
STATE_FILE="${REPORT_DIR}/state.json"
mkdir -p "$REPORT_DIR"

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TICK_FILE="${REPORT_DIR}/tick-${NOW_ISO//[:]/-}.md"

cd "${TASK_BOARD_DIR}"

# Export env for the bun script
export ALERT_REVIEW_WINDOW_HOURS
export ALERT_REVIEW_FP_THRESHOLD
export ALERT_REVIEW_SOAK_START_ISO
export ALERT_REVIEW_SOAK_END_ISO
export ALERT_REVIEW_TG_CHAT_ID
export TELEGRAM_TOKEN
export NOW_ISO
export TICK_FILE
export STATE_FILE

# shellcheck disable=SC2016
/Users/coachstokes/.bun/bin/bun run - <<'EOF'
import { AlertReviewEngine } from './src/alert-review/index.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { homedir } from 'os'
import { join } from 'path'

const NOW_ISO = process.env['NOW_ISO']!
const TICK_FILE = process.env['TICK_FILE']!
const STATE_FILE = process.env['STATE_FILE']!
const SOAK_START_ISO = process.env['ALERT_REVIEW_SOAK_START_ISO']!
const SOAK_END_ISO = process.env['ALERT_REVIEW_SOAK_END_ISO']!
const WINDOW_HOURS = parseInt(process.env['ALERT_REVIEW_WINDOW_HOURS'] ?? '24', 10)
const FP_THRESHOLD = parseInt(process.env['ALERT_REVIEW_FP_THRESHOLD'] ?? '8', 10)
const TG_CHAT_ID = process.env['ALERT_REVIEW_TG_CHAT_ID'] ?? '1712539766'
const TG_TOKEN = process.env['TELEGRAM_TOKEN'] ?? ''

const nowSec = Math.floor(new Date(NOW_ISO).getTime() / 1000)
const soakStartSec = Math.floor(new Date(SOAK_START_ISO).getTime() / 1000)
const soakEndSec = Math.floor(new Date(SOAK_END_ISO).getTime() / 1000)

// Load persistent state (breach/final-tg dedup)
type SoakState = {
  breach_alerted: boolean
  breach_alerted_at?: string
  breach_fp_count?: number
  final_alerted: boolean
  final_alerted_at?: string
  ticks_run: number
}
let state: SoakState = { breach_alerted: false, final_alerted: false, ticks_run: 0 }
if (existsSync(STATE_FILE)) {
  try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf-8')) } } catch {}
}
state.ticks_run += 1

async function sendTelegram(text: string): Promise<boolean> {
  if (!TG_TOKEN) {
    process.stderr.write('[runner-soak] WARN: no TELEGRAM_TOKEN, skip TG\n')
    return false
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: TG_CHAT_ID, text }).toString(),
    })
    return resp.ok
  } catch (e) {
    process.stderr.write(`[runner-soak] TG error: ${e}\n`)
    return false
  }
}

function saveState() {
  const dir = dirname(STATE_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

// Run the AlertReviewEngine over the soak window (start → now)
// The engine reads emit.log JSON-lines from ~/.claude/state/heartbeat-v2/emit.log
const engine = new AlertReviewEngine({
  emitLogPath: join(homedir(), '.claude', 'state', 'heartbeat-v2', 'emit.log'),
  reportDir: join(homedir(), '.claude', 'state', 'alert-review', 'soak'),
  // No agentActions / suppressData injected: classifier will fall back to
  // PERSISTENT for alerts without resolver context. Soak metric of interest is
  // FP COUNT, which the classifier yields per-tick from emit.log + state-resolver
  // semantics. Soak v1 conservatism: without a state resolver, FP requires the
  // agentStateResolver path — so for the soak we approximate FP using
  // "agent recovered to ALIVE/IDLE within window" via the heartbeat-v2.db.
  agentStateResolver: (agent: string, atSec: number): string | null => {
    // Read most recent external_status for `agent` at or before `atSec` from heartbeat-v2.db.
    // Best-effort: shell out to sqlite3.
    try {
      const { spawnSync } = require('child_process')
      const dbPath = '/Users/coachstokes/bin/heartbeat-v2.db'
      const tsIso = new Date(atSec * 1000).toISOString().replace('T', ' ').replace('Z', '')
      const sql = `SELECT external_status FROM heartbeats_v2 WHERE agent='${agent}' AND timestamp <= '${tsIso}' ORDER BY id DESC LIMIT 1;`
      const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf-8', timeout: 5000 })
      const status = (r.stdout ?? '').trim()
      return status || null
    } catch {
      return null
    }
  },
})

// Build report over the soak window
const report = engine.buildReport(soakStartSec, nowSec)

// Compute rolling 24h FP count: classify count of FP alerts emitted within last
// WINDOW_HOURS hours
const rollingStart = nowSec - WINDOW_HOURS * 3600
const fpInWindow = report.classified.filter(c => {
  if (c.classification !== 'FP') return false
  const ts = new Date(c.alert.timestamp_iso).getTime() / 1000
  return ts >= rollingStart && ts <= nowSec
}).length

// Soak progress
const elapsedHours = Math.round((nowSec - soakStartSec) / 36) / 100  // 2 decimals
const totalHours = Math.round((soakEndSec - soakStartSec) / 36) / 100
const soakComplete = nowSec >= soakEndSec
const breach = fpInWindow >= FP_THRESHOLD

// Write per-tick markdown
const mdLines: string[] = []
mdLines.push(`# Soak Monitor Tick — ${NOW_ISO}`)
mdLines.push('')
mdLines.push(`Soak window: ${SOAK_START_ISO} → ${SOAK_END_ISO}`)
mdLines.push(`Elapsed: ${elapsedHours}h / ${totalHours}h  (tick #${state.ticks_run})`)
mdLines.push('')
mdLines.push('## Classification (full soak window)')
mdLines.push(`- Total emissions: ${report.total_emissions}`)
mdLines.push(`- TP: ${report.tp_count}`)
mdLines.push(`- FP: ${report.fp_count}`)
mdLines.push(`- AMBIGUOUS: ${report.ambiguous_count}`)
mdLines.push(`- PERSISTENT: ${report.persistent_count}`)
mdLines.push('')
mdLines.push(`## Rolling ${WINDOW_HOURS}h FP Count`)
mdLines.push(`- FPs in last ${WINDOW_HOURS}h: **${fpInWindow}**`)
mdLines.push(`- Threshold: ${FP_THRESHOLD}`)
mdLines.push(`- Status: ${breach ? '🚨 **BREACH**' : (fpInWindow >= FP_THRESHOLD - 2 ? '⚠️ approaching' : '✅ under threshold')}`)
mdLines.push('')
mdLines.push('## Per-agent')
if (report.per_agent.length === 0) {
  mdLines.push('_no alerts in window_')
} else {
  mdLines.push('| Agent | Count | TP rate |')
  mdLines.push('|---|---|---|')
  for (const a of report.per_agent) {
    mdLines.push(`| ${a.agent} | ${a.alert_count} | ${(a.tp_rate * 100).toFixed(0)}% |`)
  }
}
mdLines.push('')
mdLines.push('## Top noisy fingerprints')
if (report.top_noisy.length === 0) {
  mdLines.push('_none_')
} else {
  mdLines.push('| Fingerprint | Count | FP% |')
  mdLines.push('|---|---|---|')
  for (const n of report.top_noisy.slice(0, 5)) {
    mdLines.push(`| ${n.fingerprint} | ${n.count} | ${n.fp_pct}% |`)
  }
}
mdLines.push('')
mdLines.push('## Soak State')
mdLines.push('```json')
mdLines.push(JSON.stringify(state, null, 2))
mdLines.push('```')
writeFileSync(TICK_FILE, mdLines.join('\n'), 'utf-8')
process.stdout.write(`[runner-soak] tick written: ${TICK_FILE} (FP-24h=${fpInWindow}, breach=${breach})\n`)

// Decide on Telegram actions
async function main() {
  // Breach TG: fire ONCE
  if (breach && !state.breach_alerted) {
    const msg = [
      '🚨 [SOAK BREACH] heartbeat-v2 alert-FP threshold crossed',
      `Window: rolling ${WINDOW_HOURS}h`,
      `FPs in window: ${fpInWindow}  (threshold ${FP_THRESHOLD})`,
      `Soak elapsed: ${elapsedHours}h / ${totalHours}h`,
      `Tick: ${NOW_ISO}`,
      '',
      'RECOMMENDATION: ship V2.1 immediately (false-positive rate above launch gate)',
      `Tick report: ${TICK_FILE}`,
    ].join('\n')
    const ok = await sendTelegram(msg)
    if (ok) {
      state.breach_alerted = true
      state.breach_alerted_at = NOW_ISO
      state.breach_fp_count = fpInWindow
      process.stdout.write('[runner-soak] BREACH TG sent\n')
    } else {
      process.stderr.write('[runner-soak] BREACH TG send FAILED — will retry next tick\n')
    }
  }

  // Final TG: fire ONCE when soak window has elapsed
  if (soakComplete && !state.final_alerted) {
    const verdict = state.breach_alerted ? 'FAIL (ship V2.1)' : 'PASS (defer V2.1 7 days)'
    const msg = [
      `✅ [SOAK COMPLETE] heartbeat-v2 48h FP-monitor verdict: ${verdict}`,
      `Window: ${SOAK_START_ISO} → ${SOAK_END_ISO}`,
      `Total emissions: ${report.total_emissions}`,
      `Total TP=${report.tp_count} FP=${report.fp_count} AMB=${report.ambiguous_count} PERSISTENT=${report.persistent_count}`,
      `Max rolling-${WINDOW_HOURS}h FP burst recorded: ${state.breach_fp_count ?? fpInWindow}`,
      `Threshold: ${FP_THRESHOLD}`,
      `Ticks run: ${state.ticks_run}`,
      `Final tick: ${NOW_ISO}`,
    ].join('\n')
    const ok = await sendTelegram(msg)
    if (ok) {
      state.final_alerted = true
      state.final_alerted_at = NOW_ISO
      process.stdout.write('[runner-soak] FINAL TG sent\n')
    } else {
      process.stderr.write('[runner-soak] FINAL TG send FAILED — will retry next tick\n')
    }
  }

  saveState()
}

await main()
EOF
