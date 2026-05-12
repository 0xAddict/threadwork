#!/usr/bin/env bash
# subagent-stall-watcher.sh — Detect stalled sub-agents and wake their parents.
#
# Companion to subagent-heartbeat.sh. The heartbeat hook fires on every sub-agent
# tool call — so an active sub-agent self-reports. But if a sub-agent HANGS
# (stuck on a tool, infinite loop, dead API call), no heartbeat tool-call fires
# and no SubagentStop ever runs.
#
# This script polls ~/.claude/state/subagent-heartbeat/*-*.json (excluding
# pending-* slots) and alerts when last_edit_ts is older than STALL_THRESHOLD_SEC.
#
# Designed to be run by launchd (com.threadwork.subagent-stall-watcher) on a
# StartInterval of 900s (15 min). Idempotent — alerts are deduped via the
# task-board's watchdog_alert_state table.
#
# #615 Phase 2 — universal sub-agent stall detection so agents don't repeat the
# WS-B 20-hour silent-stall failure pattern.

set -u

STATE_DIR="$HOME/.claude/state/subagent-heartbeat"
LOG_FILE="$STATE_DIR/stall-watcher.log"
STALL_THRESHOLD_SEC="${STALL_THRESHOLD_SEC:-2400}"  # 40 minutes
TASKBOARD_DB="$HOME/.claude/mcp-servers/task-board/tasks.db"

mkdir -p "$STATE_DIR" 2>/dev/null

log() {
  local ts
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '%s %s\n' "$ts" "$*" >> "$LOG_FILE" 2>/dev/null
}

# Telegram setup (same env as heartbeat hook)
CHAT_ID="${TELEGRAM_CHAT_ID:-1712539766}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

tg_alert() {
  local text="$1"
  [ -z "$BOT_TOKEN" ] && { log "no TELEGRAM_BOT_TOKEN, skip tg"; return 0; }
  curl -sS --max-time 8 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" \
    >>"$LOG_FILE" 2>&1 &
  disown 2>/dev/null || true
}

# Dedup against task-board's watchdog_alert_state. Returns 0 (fire) if no
# matching alert in the last STALL_THRESHOLD_SEC, else 1 (suppress).
should_alert_stall() {
  local agent_label="$1"
  local subagent_id="$2"
  [ ! -f "$TASKBOARD_DB" ] && return 0
  local hash_input="${agent_label}/${subagent_id}"
  # Use a stable string in audit_log for dedup; we approximate by checking
  # recent alerts for this exact label/id combo.
  local count
  count=$(sqlite3 "$TASKBOARD_DB" "SELECT count(*) FROM audit_log WHERE action='subagent_stall' AND detail LIKE '%${agent_label}%${subagent_id}%' AND created_at > datetime('now','-${STALL_THRESHOLD_SEC} seconds');" 2>/dev/null)
  [ "${count:-0}" -eq 0 ]
}

record_alert() {
  local agent_label="$1"
  local subagent_id="$2"
  local elapsed_min="$3"
  [ ! -f "$TASKBOARD_DB" ] && return 0
  sqlite3 "$TASKBOARD_DB" "INSERT INTO audit_log (agent, action, detail) VALUES ('stall-watcher', 'subagent_stall', '{\"agent\":\"${agent_label}\",\"subagent_id\":\"${subagent_id}\",\"stalled_min\":${elapsed_min}}');" 2>/dev/null
}

NOW=$(date +%s)
log "tick (threshold=${STALL_THRESHOLD_SEC}s)"

# Iterate all live state files (skip pending-* slots — those are pre-claim)
shopt -s nullglob 2>/dev/null
checked=0
stalled=0
for sfile in "$STATE_DIR"/*-*.json; do
  base=$(basename "$sfile")
  case "$base" in
    *-pending-*) continue ;;
    debug.log|stall-watcher.log) continue ;;
  esac
  checked=$((checked + 1))

  # Parse state file
  read -r last_edit_ts started_at agent_label subagent_id task_preview < <(
    python3 -c "
import json, sys
try:
    d = json.load(open('${sfile}'))
except Exception:
    sys.exit(0)
print(d.get('last_edit_ts', 0), d.get('started_at', 0),
      '${base}'.split('-')[0],
      '${base}'.rsplit('-', 1)[1].rsplit('.', 1)[0],
      (d.get('task_preview', '')[:80] or '(no description)').replace(chr(10), ' '))
" 2>/dev/null
  )

  [ -z "$last_edit_ts" ] && continue
  elapsed=$((NOW - last_edit_ts))
  elapsed_min=$((elapsed / 60))

  if [ "$elapsed" -gt "$STALL_THRESHOLD_SEC" ]; then
    stalled=$((stalled + 1))
    if should_alert_stall "$agent_label" "$subagent_id"; then
      log "STALL ${agent_label}/${subagent_id} idle=${elapsed_min}m preview=${task_preview}"
      tg_alert "⚠️ Sub-agent stall: ${agent_label}/${subagent_id:0:12} silent ${elapsed_min} min — ${task_preview}"
      record_alert "$agent_label" "$subagent_id" "$elapsed_min"
    else
      log "STALL ${agent_label}/${subagent_id} idle=${elapsed_min}m (suppressed by dedup)"
    fi
  fi
done

log "tick done: checked=${checked} stalled=${stalled}"
