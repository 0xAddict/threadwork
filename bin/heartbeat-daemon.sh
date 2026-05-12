#!/usr/bin/env bash
# =============================================================================
# heartbeat-daemon.sh — OpenClaw-inspired agent health monitor
# Monitors tmux sessions for claude-boss, claude-steve, claude-sadie, claude-kiera
# Runs every 5 minutes. Logs to SQLite. Alerts via Telegram on STUCK/CRASHED.
# =============================================================================

set -euo pipefail

# Unset TMUX env var — when running inside a tmux session, bash sets $TMUX
# to the socket path, which shadows our binary path variable
unset TMUX 2>/dev/null || true

TMUX_BIN="/Users/coachstokes/.local/bin/tmux"
DB="/Users/coachstokes/bin/heartbeat.db"
LOG="/Users/coachstokes/bin/heartbeat.log"
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:?TELEGRAM_TOKEN env var required}"
TELEGRAM_CHAT_ID="1712539766"
AGENTS=("claude-boss" "claude-steve" "claude-sadie" "claude-kiera")
CHECK_INTERVAL=300   # 5 minutes
HOURLY_INTERVAL=3600 # 1 hour

# Supabase credentials (for secrets table — key never stored on disk)
SUPABASE_URL="https://nblnapyfcuotnmkmqvec.supabase.co"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY:?SUPABASE_SERVICE_KEY env var required}"

# OpenRouter models (tried in order)
OR_MODELS=(
  "google/gemma-3-12b-it"
  "google/gemma-3-4b-it:free"
)

# =============================================================================
# Helpers
# =============================================================================

log() {
  local msg="$*"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] $msg" | tee -a "$LOG"
}

# Load OpenRouter API key — fetches from Supabase secrets table at runtime.
# The key is never stored on disk. Falls back to env var if set (for testing).
load_api_key() {
  # Env var override (for local testing only — not persisted to disk)
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    echo "$OPENROUTER_API_KEY"
    return 0
  fi

  # Fetch from Supabase secrets table (service_role access, RLS enabled with no policies)
  local result
  result="$(curl -s --max-time 10 \
    "${SUPABASE_URL}/rest/v1/secrets?key=eq.openrouter_api_key&select=value" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
    2>/dev/null || echo "")"

  local key
  key="$(printf '%s' "$result" | python3 -c "
import json, sys
try:
    rows = json.load(sys.stdin)
    if rows and isinstance(rows, list) and rows[0].get('value'):
        print(rows[0]['value'].strip())
    else:
        print('')
except Exception:
    print('')
" 2>/dev/null || echo "")"

  echo "$key"
}

# Send a Telegram message (plain text, no markdown)
send_telegram() {
  local text="$1"
  curl -s -X POST \
    "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    -d "parse_mode=" \
    > /dev/null 2>&1 || log "WARN: Telegram send failed"
}

# =============================================================================
# SQLite setup
# =============================================================================

init_db() {
  sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  consecutive_stuck INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_ts ON heartbeats(agent, timestamp);
SQL
  log "DB initialised at $DB"
}

# Get count of consecutive STUCK statuses for an agent (most recent run)
get_consecutive_stuck() {
  local agent="$1"
  sqlite3 "$DB" <<SQL
SELECT COALESCE(consecutive_stuck, 0)
FROM heartbeats
WHERE agent = '$agent'
ORDER BY id DESC
LIMIT 1;
SQL
}

# Get the most recent status for an agent
get_last_status() {
  local agent="$1"
  sqlite3 "$DB" <<SQL
SELECT COALESCE(status, 'UNKNOWN')
FROM heartbeats
WHERE agent = '$agent'
ORDER BY id DESC
LIMIT 1;
SQL
}

# Insert a heartbeat row
insert_heartbeat() {
  local agent="$1"
  local status="$2"
  local reason="$3"
  local consecutive="$4"
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  # Escape single quotes in reason
  reason="${reason//\'/\'\'}"
  sqlite3 "$DB" <<SQL
INSERT INTO heartbeats (timestamp, agent, status, reason, consecutive_stuck)
VALUES ('$ts', '$agent', '$status', '$reason', $consecutive);
SQL
}

# =============================================================================
# AI classification via OpenRouter
# =============================================================================

classify_with_openrouter() {
  local agent="$1"
  local pane_output="$2"
  local api_key="$3"

  # Escape the pane output for JSON (remove control chars, escape backslash/quotes)
  local safe_output
  safe_output="$(printf '%s' "$pane_output" \
    | tr -d '\000-\010\013\014\016-\037' \
    | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | head -c 4000)"

  local system_prompt="You are a health monitor. Classify this agent terminal output as exactly one of: ALIVE (actively working or waiting for input), STUCK (error loops, hanging, no progress), CRASHED (session dead or unresponsive), IDLE (at prompt, not doing anything). Respond with ONLY the status word and a 5-word reason."
  local user_content="Agent: ${agent}\nLast 50 lines:\n\n${safe_output}"

  for model in "${OR_MODELS[@]}"; do
    local payload
    payload="$(cat <<PAYLOAD
{
  "model": "${model}",
  "max_tokens": 50,
  "messages": [
    {"role": "system", "content": "${system_prompt}"},
    {"role": "user", "content": "Agent: ${agent}\nLast 50 lines:\n\n${safe_output}"}
  ]
}
PAYLOAD
)"

    local response
    response="$(curl -s --max-time 20 \
      -X POST "https://openrouter.ai/api/v1/chat/completions" \
      -H "Authorization: Bearer ${api_key}" \
      -H "Content-Type: application/json" \
      -d "$payload" 2>/dev/null || echo "")"

    if [[ -z "$response" ]]; then
      log "WARN: No response from OpenRouter model $model"
      continue
    fi

    # Extract content from JSON response
    local content
    content="$(printf '%s' "$response" \
      | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['choices'][0]['message']['content'].strip())
except Exception as e:
    print('')
" 2>/dev/null || echo "")"

    if [[ -n "$content" ]]; then
      echo "$content"
      return 0
    fi

    log "WARN: Empty content from model $model, trying next"
  done

  # All models failed
  echo "UNKNOWN all OpenRouter models failed"
  return 1
}

# Parse status word from AI response (first word, uppercase)
parse_status_word() {
  local response="$1"
  local word
  word="$(echo "$response" | awk '{print toupper($1)}')"
  case "$word" in
    ALIVE|STUCK|CRASHED|IDLE) echo "$word" ;;
    *) echo "UNKNOWN" ;;
  esac
}

# =============================================================================
# Check a single agent
# =============================================================================

check_agent() {
  local agent="$1"
  local api_key="$2"
  local status=""
  local reason=""
  local consecutive=0
  local last_status=""

  last_status="$(get_last_status "$agent")"

  # Step 1: check if tmux session exists
  if ! "$TMUX_BIN" has-session -t "$agent" 2>/dev/null; then
    status="CRASHED"
    reason="tmux session not found"
    log "[$agent] Session missing → CRASHED"
  else
    # Step 2: capture pane output
    local pane_output
    pane_output="$("$TMUX_BIN" capture-pane -t "$agent" -p -S -50 2>/dev/null || echo "")"

    if [[ -z "$pane_output" ]]; then
      status="CRASHED"
      reason="pane capture returned empty"
      log "[$agent] Empty pane capture → CRASHED"
    elif [[ -z "$api_key" ]]; then
      # No API key — fall back to session-existence check only
      status="ALIVE"
      reason="session exists no AI key"
      log "[$agent] No API key — defaulting to ALIVE (session exists)"
    else
      # Step 3: classify with AI
      log "[$agent] Sending pane to OpenRouter for classification..."
      local ai_response
      ai_response="$(classify_with_openrouter "$agent" "$pane_output" "$api_key")"
      status="$(parse_status_word "$ai_response")"
      # reason = everything after the first word
      reason="$(echo "$ai_response" | cut -d' ' -f2-)"
      if [[ "$status" == "UNKNOWN" ]]; then
        status="IDLE"
        reason="AI classification uncertain"
      fi
      log "[$agent] AI says: $status — $reason"
    fi
  fi

  # Step 4: track consecutive STUCK
  if [[ "$status" == "STUCK" ]]; then
    local prev_consecutive
    prev_consecutive="$(get_consecutive_stuck "$agent")"
    consecutive=$(( prev_consecutive + 1 ))
  else
    consecutive=0
  fi

  # Step 5: persist
  insert_heartbeat "$agent" "$status" "$reason" "$consecutive"

  # Step 6: alert logic
  alert_if_needed "$agent" "$status" "$reason" "$consecutive" "$last_status"
}

# =============================================================================
# Alerting
# =============================================================================

alert_if_needed() {
  local agent="$1"
  local status="$2"
  local reason="$3"
  local consecutive="$4"
  local last_status="$5"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"

  if [[ "$status" == "CRASHED" ]]; then
    log "[$agent] ALERT: CRASHED — sending Telegram"
    send_telegram "$(printf '⚠️ HEARTBEAT ALERT\nAgent: %s\nStatus: %s (consecutive: %d)\nReason: %s\nTime: %s' \
      "$agent" "$status" "$consecutive" "$reason" "$ts")"

  elif [[ "$status" == "STUCK" && "$consecutive" -eq 2 ]]; then
    log "[$agent] ALERT: 2 consecutive STUCK — sending warning"
    send_telegram "$(printf '⚠️ HEARTBEAT ALERT\nAgent: %s\nStatus: %s (consecutive: %d)\nReason: %s\nTime: %s' \
      "$agent" "$status" "$consecutive" "$reason" "$ts")"

  elif [[ "$status" == "STUCK" && "$consecutive" -ge 3 ]]; then
    log "[$agent] ALERT: 3+ consecutive STUCK — sending critical"
    send_telegram "$(printf '🚨 CRITICAL HEARTBEAT ALERT\nAgent: %s\nStatus: %s (consecutive: %d)\nReason: %s\nTime: %s\n\nConsider restarting: /Users/coachstokes/.local/bin/tmux kill-session -t %s' \
      "$agent" "$status" "$consecutive" "$reason" "$ts" "$agent")"

  elif [[ "$last_status" == "STUCK" || "$last_status" == "CRASHED" ]] && \
       [[ "$status" == "ALIVE" || "$status" == "IDLE" ]]; then
    log "[$agent] RECOVERY: $last_status → $status — sending notification"
    send_telegram "$(printf '✅ HEARTBEAT RECOVERY\nAgent: %s\nStatus: %s (was: %s)\nReason: %s\nTime: %s' \
      "$agent" "$status" "$last_status" "$reason" "$ts")"
  fi
}

# =============================================================================
# Hourly status summary
# =============================================================================

send_hourly_summary() {
  set +e  # don't let any subcommand failure abort the daemon
  local hour
  hour="$(date '+%H:00')"
  local summary
  summary="Heartbeat Status -- ${hour}"$'\n'

  local agent
  for agent in "${AGENTS[@]}"; do
    # Get last 6 statuses
    local recent_statuses
    recent_statuses="$(sqlite3 "$DB" \
      "SELECT status FROM heartbeats WHERE agent='$agent' ORDER BY id DESC LIMIT 6;" \
      2>/dev/null)" || recent_statuses=""

    local last_st
    last_st="$(get_last_status "$agent" 2>/dev/null)" || last_st="UNKNOWN"

    if [[ -z "$recent_statuses" ]]; then
      summary+="${agent}: NO DATA"$'\n'
      continue
    fi

    # Count how many of the last N checks match the current status
    local count
    count="$(printf '%s\n' "$recent_statuses" | grep -c "^${last_st}$" 2>/dev/null)" || count=0

    local last_reason
    last_reason="$(sqlite3 "$DB" \
      "SELECT reason FROM heartbeats WHERE agent='$agent' ORDER BY id DESC LIMIT 1;" \
      2>/dev/null)" || last_reason=""

    local short_name="${agent/claude-/}"
    # Capitalise first letter (bash 3.2-compatible)
    local display_name
    display_name="$(printf '%s' "$short_name" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
    summary+="${display_name}: ${last_st} (last ${count}/6 checks -- ${last_reason})"$'\n'
  done

  log "Sending hourly summary"
  send_telegram "$summary" || log "WARN: Telegram send failed in hourly summary"
  set -e
}

# =============================================================================
# Main loop
# =============================================================================

main() {
  log "========================================"
  log "heartbeat-daemon starting"
  log "Agents: ${AGENTS[*]}"
  log "Interval: ${CHECK_INTERVAL}s | Hourly report: yes"
  log "========================================"

  init_db

  local last_hourly=0

  # Main loop runs with errors tolerated — individual failures must not kill the daemon
  set +e

  while true; do
    local now
    now="$(date +%s)"

    log "--- Heartbeat tick at $(date '+%Y-%m-%d %H:%M:%S') ---"

    # Load API key fresh each tick (in case it's inserted into Supabase later)
    local api_key
    api_key="$(load_api_key 2>/dev/null)" || api_key=""
    if [[ -z "$api_key" ]]; then
      log "WARN: No OpenRouter API key in Supabase secrets — using session-existence fallback only"
    fi

    local agent
    for agent in "${AGENTS[@]}"; do
      # Each agent check is isolated — failure doesn't stop others
      check_agent "$agent" "$api_key" || log "ERROR: check_agent failed for $agent (continuing)"
    done

    # Hourly summary
    if (( now - last_hourly >= HOURLY_INTERVAL )); then
      send_hourly_summary || log "WARN: hourly summary failed"
      last_hourly="$now"
    fi

    log "--- Tick complete. Sleeping ${CHECK_INTERVAL}s ---"
    sleep "$CHECK_INTERVAL"
  done
}

main "$@"
