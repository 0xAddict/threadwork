#!/usr/bin/env bash
# src/alert-review/runner.sh — alert-review weekly run script
# Invoked by launchd com.threadwork.alert-review plist (StartCalendarInterval Monday 09:00)
# Also supports ALERT_REVIEW_CRON env for configurable schedule testing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_BOARD_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_DIR="${HOME}/.claude/state/heartbeat-v2"
REPORT_DIR="${HOME}/.claude/state/alert-review"
EMIT_LOG="${STATE_DIR}/emit.log"

# Compute week window: 7 days ago to now
NOW_SEC=$(date +%s)
WEEK_START_SEC=$(( NOW_SEC - 7 * 86400 ))
WEEK_END_SEC="${NOW_SEC}"

mkdir -p "${REPORT_DIR}"

# Run the alert-review engine via bun
cd "${TASK_BOARD_DIR}"
bun run - <<'EOF'
import { AlertReviewEngine, installAlertReviewPlist } from './src/alert-review/index.ts'
import { join } from 'path'
import { homedir } from 'os'

const engine = new AlertReviewEngine({
  emitLogPath: process.env['EMIT_LOG'] ?? join(homedir(), '.claude', 'state', 'heartbeat-v2', 'emit.log'),
  reportDir: process.env['REPORT_DIR'] ?? join(homedir(), '.claude', 'state', 'alert-review'),
})

const nowSec = Math.floor(Date.now() / 1000)
const weekStartSec = nowSec - 7 * 86400

const { reportPath, report } = engine.run(weekStartSec, nowSec, (msg, path) => {
  process.stdout.write(`[alert-review] ${msg}\n`)
})
process.stdout.write(`[alert-review] report written: ${reportPath}\n`)
EOF
