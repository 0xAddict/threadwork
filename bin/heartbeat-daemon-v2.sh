#!/usr/bin/env bash
# =============================================================================
# heartbeat-daemon-v2.sh — deterministic state-machine heartbeat monitor
# Implements spec §4: declared state → deterministic rules → OS facts → LLM fallback
# Separate heartbeat-v2.db. Two-tier Telegram alerts. Feature-flag gated.
# =============================================================================

# Guard: allow sourcing for tests without running main()
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && _SOURCED=1 || _SOURCED=0

set +e
unset TMUX 2>/dev/null || true

TMUX_BIN="/Users/coachstokes/.local/bin/tmux"
TASKS_DB_PATH="$HOME/.claude/mcp-servers/task-board/tasks.db"
HEARTBEAT_DB_PATH="/Users/coachstokes/bin/heartbeat-v2.db"
LOG="/Users/coachstokes/bin/heartbeat-v2.log"
# Sprint 2: env-var checks moved out of source-time. The `:?` form aborts
# `source heartbeat-daemon-v2.sh` in test harnesses (which deliberately do not
# export secrets). Defaults keep sourcing safe; require_env() enforces them
# only on the real run path (called from main()).
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}"
TELEGRAM_CHAT_ID="1712539766"
AGENTS=("boss" "steve" "sadie" "kiera")
CHECK_INTERVAL=300
HOURLY_INTERVAL=3600

# Freshness + hung thresholds (seconds)
STATE_FRESHNESS_SEC=360
TOOL_IN_FLIGHT_HUNG_SEC=600
SUBAGENT_HUNG_SEC=2400
LAST_SEEN_ALIVE_SEC=120     # last_seen_at within this window → agent is keeping alive
TASK_PROGRESS_FRESH_SEC=900 # tasks.last_progress_at within this window → task is progressing

SUPABASE_URL="https://nblnapyfcuotnmkmqvec.supabase.co"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"

OR_MODELS=(
  "google/gemma-3-12b-it"
  "google/gemma-3-4b-it:free"
)

# =============================================================================
# Vocab translation: internal state → external label
# =============================================================================

internal_to_external() {
  local state="$1"
  case "$state" in
    ACTIVE_THINKING)  echo "ALIVE"   ;;
    TOOL_IN_FLIGHT)   echo "ALIVE"   ;;
    SUBAGENT_RUNNING) echo "ALIVE"   ;;
    WAITING_HUMAN)    echo "IDLE"    ;;
    COMPLETED)        echo "IDLE"    ;;
    IDLE_BOOT)        echo "IDLE"    ;;
    DEAD)             echo "CRASHED" ;;
    *)                echo "UNKNOWN" ;;
  esac
}

# =============================================================================
# Helpers
# =============================================================================

log() {
  local ts; ts="$(date '+%Y-%m-%d %H:%M:%S')"
  printf '[%s] %s\n' "$ts" "$*" >> "$LOG" 2>/dev/null || true
  printf '[%s] %s\n' "$ts" "$*" >&2 || true
}

# Sprint 2: enforce required secrets only on the real run path (main()).
# Sourcing the daemon for tests must NOT abort; require_env is never called
# from the sourced/test path.
require_env() {
  local missing=0
  if [[ -z "${TELEGRAM_TOKEN:-}" ]]; then
    echo "FATAL: TELEGRAM_TOKEN env var required" >&2; missing=1
  fi
  if [[ -z "${SUPABASE_SERVICE_KEY:-}" ]]; then
    echo "FATAL: SUPABASE_SERVICE_KEY env var required" >&2; missing=1
  fi
  (( missing )) && exit 1
  return 0
}

load_api_key() {
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    echo "$OPENROUTER_API_KEY"
    return 0
  fi
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
# heartbeat-v2.db setup
# =============================================================================

init_db_v2() {
  sqlite3 "$HEARTBEAT_DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS heartbeats_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  agent TEXT NOT NULL,
  declared_state TEXT,
  declared_source TEXT,
  state_age_sec INTEGER,
  external_status TEXT NOT NULL,
  classification_method TEXT,
  reason TEXT,
  consecutive_stuck INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hbv2_agent_ts ON heartbeats_v2(agent, timestamp);
SQL
  log "heartbeat-v2.db initialised at $HEARTBEAT_DB_PATH"
}

get_last_external_status() {
  local agent="$1"
  sqlite3 "$HEARTBEAT_DB_PATH" \
    "SELECT COALESCE(external_status,'UNKNOWN') FROM heartbeats_v2 WHERE agent='$agent' ORDER BY id DESC LIMIT 1;" \
    2>/dev/null || echo "UNKNOWN"
}

get_consecutive_stuck_v2() {
  local agent="$1"
  sqlite3 "$HEARTBEAT_DB_PATH" \
    "SELECT COALESCE(consecutive_stuck,0) FROM heartbeats_v2 WHERE agent='$agent' ORDER BY id DESC LIMIT 1;" \
    2>/dev/null || echo "0"
}

insert_heartbeat_v2() {
  local agent="$1" declared_state="$2" declared_source="$3" state_age="$4"
  local ext_status="$5" method="$6" reason="$7" consecutive="$8"
  local ts; ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  declared_state="${declared_state//\'/\'\'}"
  reason="${reason//\'/\'\'}"
  sqlite3 "$HEARTBEAT_DB_PATH" <<SQL
INSERT INTO heartbeats_v2
  (timestamp, agent, declared_state, declared_source, state_age_sec,
   external_status, classification_method, reason, consecutive_stuck)
VALUES ('$ts','$agent','$declared_state','$declared_source',$state_age,
        '$ext_status','$method','$reason',$consecutive);
SQL
}

# =============================================================================
# AI classification (reused from v1 with enriched input for v2)
# =============================================================================

classify_with_openrouter() {
  local agent="$1"
  local enriched_input="$2"
  local api_key="$3"

  local safe_input
  safe_input="$(printf '%s' "$enriched_input" \
    | tr -d '\000-\010\013\014\016-\037' \
    | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | head -c 4000)"

  local system_prompt="You are a health monitor. Classify this agent as exactly one of: ALIVE (actively working or waiting for input), STUCK (error loops, hanging, no progress), CRASHED (session dead or unresponsive), IDLE (at prompt, not doing anything). Respond with ONLY the status word and a 5-word reason."

  for model in "${OR_MODELS[@]}"; do
    local payload
    payload="$(cat <<PAYLOAD
{
  "model": "${model}",
  "max_tokens": 50,
  "messages": [
    {"role": "system", "content": "${system_prompt}"},
    {"role": "user", "content": "${safe_input}"}
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

    local content
    content="$(printf '%s' "$response" \
      | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['choices'][0]['message']['content'].strip())
except Exception:
    print('')
" 2>/dev/null || echo "")"

    if [[ -n "$content" ]]; then
      echo "$content"
      return 0
    fi
    log "WARN: Empty content from model $model, trying next"
  done

  echo "UNKNOWN all OpenRouter models failed"
  return 1
}

parse_status_word() {
  local response="$1"
  local word; word="$(echo "$response" | awk '{print toupper($1)}')"
  case "$word" in
    ALIVE|STUCK|CRASHED|IDLE) echo "$word" ;;
    *) echo "UNKNOWN" ;;
  esac
}

# =============================================================================
# Alert: two-tier format
# ALIVE pings → compact (no Declared:/Source: lines)
# Non-ALIVE (STUCK/CRASHED/IDLE-recovery) → include Declared: and Source: lines
# =============================================================================

alert_v2() {
  local agent="$1" ext_status="$2" declared_state="$3" declared_source="$4"
  local reason="$5" consecutive="$6" last_ext_status="$7"
  local ts; ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local session="claude-$agent"

  local is_recovery=0
  [[ "$last_ext_status" =~ ^(STUCK|CRASHED)$ ]] && [[ "$ext_status" =~ ^(ALIVE|IDLE)$ ]] \
    && is_recovery=1 || true

  if [[ "$ext_status" == "CRASHED" ]]; then
    send_telegram "$(printf '⚠️ HEARTBEAT-V2 ALERT\nAgent: %s\nStatus: CRASHED\nDeclared: %s\nSource: %s\nReason: %s\nTime: %s' \
      "$session" "$declared_state" "$declared_source" "$reason" "$ts")"

  elif [[ "$ext_status" == "STUCK" ]]; then
    if (( consecutive >= 3 )); then
      send_telegram "$(printf '🚨 CRITICAL HEARTBEAT-V2\nAgent: %s\nStatus: STUCK (x%d)\nDeclared: %s\nSource: %s\nReason: %s\nTime: %s' \
        "$session" "$consecutive" "$declared_state" "$declared_source" "$reason" "$ts")"
    else
      send_telegram "$(printf '⚠️ HEARTBEAT-V2 ALERT\nAgent: %s\nStatus: STUCK (x%d)\nDeclared: %s\nSource: %s\nReason: %s\nTime: %s' \
        "$session" "$consecutive" "$declared_state" "$declared_source" "$reason" "$ts")"
    fi

  elif (( is_recovery )); then
    send_telegram "$(printf '✅ HEARTBEAT-V2 RECOVERY\nAgent: %s\nStatus: %s (was: %s)\nDeclared: %s\nSource: %s\nReason: %s\nTime: %s' \
      "$session" "$ext_status" "$last_ext_status" "$declared_state" "$declared_source" "$reason" "$ts")"

  elif [[ "$ext_status" == "ALIVE" ]]; then
    # Compact ALIVE ping — no Declared:/Source: lines
    log "[$session] ALIVE — $reason"
    # No Telegram for routine ALIVE; periodic digest handled by hourly summary
  fi
}

# =============================================================================
# Sprint 2 — OS-facts liveness helper (D1 + D2 fix)
#
# Decides whether an agent is alive purely from OS facts, independent of its
# (possibly stale or absent) state declaration. This is the #843 boot-recovery
# fix: an agent that was already running when the emit-state.sh hooks were
# installed never wires PreToolUse, so every declaration goes stale — yet the
# agent is perfectly healthy. OS facts are the ground truth.
#
# OR-s exactly three signals (child-PID descoped per Sprint 2 RM-1 Option B):
#   1. pid_alive          — declared claude_pid responds to `kill -0`
#   2. seen_alive         — agent_sessions.last_seen_at within LAST_SEEN_ALIVE_SEC
#   3. task_progress_alive — the agent's current task (agent_sessions.current_task_id
#                            → tasks.id) has tasks.last_progress_at within
#                            TASK_PROGRESS_FRESH_SEC; falls back to
#                            tasks.last_heartbeat_at when last_progress_at is NULL.
#
# Args: $1=agent  $2=declared_pid  $3=last_seen_age_sec  $4=current_task_id
# Returns: 0 (alive) / 1 (not alive). Sets global OS_FACTS_REASON describing
# which signal fired, so callers can build an auditable classification_method.
# =============================================================================

OS_FACTS_REASON=""

# Compute the freshest task-progress age (seconds) for a task id.
# Echoes an integer age; 999999 when unavailable. last_progress_at preferred,
# last_heartbeat_at used as fallback when last_progress_at is NULL/empty.
task_progress_age_sec() {
  local task_id="$1"
  [[ -z "$task_id" || "$task_id" == "NULL" || "$task_id" == "0" ]] && { echo 999999; return; }
  [[ "$task_id" =~ ^[0-9]+$ ]] || { echo 999999; return; }

  local trow
  trow="$(sqlite3 "$TASKS_DB_PATH" \
    "SELECT COALESCE(last_progress_at,''), COALESCE(last_heartbeat_at,'') FROM tasks WHERE id=$task_id LIMIT 1;" \
    2>/dev/null || echo "")"
  local prog_at hb_at chosen
  prog_at="$(echo "$trow" | cut -d'|' -f1)"
  hb_at="$(echo "$trow" | cut -d'|' -f2)"
  if [[ -n "$prog_at" ]]; then
    chosen="$prog_at"
  elif [[ -n "$hb_at" ]]; then
    chosen="$hb_at"
  else
    echo 999999; return
  fi

  python3 -c "
from datetime import datetime, timezone
import time
s='$chosen'
try:
    dt=datetime.strptime(s.replace('T',' ').rstrip('Z'),'%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    print(int(time.time()-dt.timestamp()))
except Exception:
    print(999999)
" 2>/dev/null || echo 999999
}

os_facts_alive() {
  local agent="$1" declared_pid="$2" last_seen_age_sec="$3" current_task_id="$4"
  OS_FACTS_REASON=""

  local pid_alive=0 seen_alive=0 task_progress_alive=0

  if [[ -n "$declared_pid" ]] && [[ "$declared_pid" != "NULL" ]] && [[ "$declared_pid" -gt 0 ]] 2>/dev/null; then
    kill -0 "$declared_pid" 2>/dev/null && pid_alive=1 || pid_alive=0
  fi

  (( last_seen_age_sec < LAST_SEEN_ALIVE_SEC )) && seen_alive=1 || seen_alive=0

  local task_age_sec
  task_age_sec="$(task_progress_age_sec "$current_task_id")"
  (( task_age_sec < TASK_PROGRESS_FRESH_SEC )) && task_progress_alive=1 || task_progress_alive=0

  OS_FACTS_REASON="pid_alive=${pid_alive} seen_alive=${seen_alive} task_progress_alive=${task_progress_alive} (task_age=${task_age_sec}s)"

  if (( pid_alive || seen_alive || task_progress_alive )); then
    return 0
  fi
  return 1
}

# =============================================================================
# Core: classify a single agent
# Returns external status on stdout (ALIVE / STUCK / CRASHED / IDLE / UNKNOWN)
# =============================================================================

classify_agent_v2() {
  local agent="$1"
  local api_key="${2:-}"
  local session="claude-$agent"

  # Step 1: tmux session check
  if ! "$TMUX_BIN" has-session -t "$session" 2>/dev/null; then
    log "[$session] Session missing → CRASHED"
    local last_ext; last_ext="$(get_last_external_status "$agent")"
    local consec; consec=$(( $(get_consecutive_stuck_v2 "$agent") + 1 ))
    insert_heartbeat_v2 "$agent" "DEAD" "none" "0" "CRASHED" "tmux-check" "session not found" "$consec"
    alert_v2 "$agent" "CRASHED" "DEAD" "none" "session not found" "$consec" "$last_ext"
    echo "CRASHED"
    return 0
  fi

  # Step 2: read declared state from agent_sessions
  # Sprint 2: also read current_task_id for the last-task-progress OS signal.
  local row
  row="$(sqlite3 "$TASKS_DB_PATH" \
    "SELECT state, state_source, state_changed_at, last_seen_at, claude_pid, COALESCE(current_task_id,'') FROM agent_sessions WHERE agent='$agent' LIMIT 1;" \
    2>/dev/null || echo "")"

  local declared_state declared_source state_changed_at last_seen_at declared_pid current_task_id
  declared_state="$(echo "$row" | cut -d'|' -f1)"
  declared_source="$(echo "$row" | cut -d'|' -f2)"
  state_changed_at="$(echo "$row" | cut -d'|' -f3)"
  last_seen_at="$(echo "$row" | cut -d'|' -f4)"
  declared_pid="$(echo "$row" | cut -d'|' -f5)"
  current_task_id="$(echo "$row" | cut -d'|' -f6)"

  [[ -z "$declared_state" ]] && declared_state="UNKNOWN"
  [[ -z "$declared_source" ]] && declared_source="none"

  # Compute state age in seconds
  local state_age_sec=999999
  if [[ -n "$state_changed_at" ]]; then
    local state_epoch
    state_epoch="$(python3 -c "
from datetime import datetime, timezone
s='$state_changed_at'
try:
    dt=datetime.strptime(s.replace('T',' ').rstrip('Z'),'%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    import time; print(int(time.time()-dt.timestamp()))
except Exception:
    print(999999)
" 2>/dev/null || echo 999999)"
    state_age_sec="$state_epoch"
  fi

  # Compute last_seen age
  local last_seen_age_sec=999999
  if [[ -n "$last_seen_at" ]]; then
    local seen_epoch
    seen_epoch="$(python3 -c "
from datetime import datetime, timezone
s='$last_seen_at'
try:
    dt=datetime.strptime(s.replace('T',' ').rstrip('Z'),'%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    import time; print(int(time.time()-dt.timestamp()))
except Exception:
    print(999999)
" 2>/dev/null || echo 999999)"
    last_seen_age_sec="$seen_epoch"
  fi

  log "[$session] declared=$declared_state src=$declared_source age=${state_age_sec}s last_seen=${last_seen_age_sec}s pid=$declared_pid"

  local ext_status=""
  local reason=""
  local method=""

  # Step 3: deterministic hung checks.
  #
  # Sprint 2 (Defect D1): the deterministic-hung check must consult OS facts
  # BEFORE emitting STUCK. A stale TOOL_IN_FLIGHT / SUBAGENT_RUNNING row whose
  # claude_pid is alive / last_seen_at is recent / current task is progressing
  # is the #843 boot-recovery symptom — a healthy already-running agent that
  # simply never wired the emit-state.sh PreToolUse hook. Classify ALIVE via
  # os-facts-hung-override; only emit STUCK when ALL OS signals are negative
  # (a genuine hang).
  local is_hung_declared=0
  local hung_reason=""
  if [[ "$declared_state" == "TOOL_IN_FLIGHT" ]] && (( state_age_sec > TOOL_IN_FLIGHT_HUNG_SEC )); then
    is_hung_declared=1
    hung_reason="TOOL_IN_FLIGHT for ${state_age_sec}s (threshold ${TOOL_IN_FLIGHT_HUNG_SEC}s)"
  elif [[ "$declared_state" == "SUBAGENT_RUNNING" ]] && (( state_age_sec > SUBAGENT_HUNG_SEC )); then
    is_hung_declared=1
    hung_reason="SUBAGENT_RUNNING for ${state_age_sec}s (threshold ${SUBAGENT_HUNG_SEC}s)"
  fi

  if (( is_hung_declared )); then
    if os_facts_alive "$agent" "$declared_pid" "$last_seen_age_sec" "$current_task_id"; then
      # D1 fix: stale hung-tool declaration overridden by live OS facts.
      ext_status="ALIVE"
      reason="hung-state suppressed ($hung_reason) — OS alive: ${OS_FACTS_REASON}"
      method="os-facts-hung-override"
    else
      # Genuine hang: declared hung AND every OS signal negative.
      ext_status="STUCK"
      reason="$hung_reason; OS facts confirm hung: ${OS_FACTS_REASON}"
      method="deterministic-hung-tool"
      [[ "$declared_state" == "SUBAGENT_RUNNING" ]] && method="deterministic-hung-subagent"
    fi

  # Step 4: state fresh → trust declared state
  elif (( state_age_sec < STATE_FRESHNESS_SEC )); then
    ext_status="$(internal_to_external "$declared_state")"
    [[ "$ext_status" == "UNKNOWN" ]] && ext_status="ALIVE"
    reason="declared $declared_state fresh (${state_age_sec}s old)"
    method="deterministic-fresh"
  else
    # Step 4: state stale (or absent) → OS facts.
    # Sprint 2 (Defect D2): the stale-state branch is refactored to reuse the
    # shared os_facts_alive helper, so the last-task-progress signal applies
    # here too and scenario 3 of heartbeat-v2.test.sh stays green.
    if os_facts_alive "$agent" "$declared_pid" "$last_seen_age_sec" "$current_task_id"; then
      ext_status="ALIVE"
      reason="stale state (${state_age_sec}s) but OS alive: ${OS_FACTS_REASON}"
      method="os-facts"
    else
      # Step 5: ambiguous → LLM with enriched input
      local pane_output
      pane_output="$("$TMUX_BIN" capture-pane -t "$session" -p -S -50 2>/dev/null || echo "")"

      # Re-derive pid_alive for the enriched prompt (cheap; OS_FACTS_REASON
      # already encodes it but the prompt wants a clean integer).
      local pid_alive=0
      if [[ -n "$declared_pid" ]] && [[ "$declared_pid" != "NULL" ]] && [[ "$declared_pid" -gt 0 ]] 2>/dev/null; then
        kill -0 "$declared_pid" 2>/dev/null && pid_alive=1 || pid_alive=0
      fi

      local enriched_input
      enriched_input="$(printf 'Agent: %s\nDeclared state: %s (source: %s, age: %ds)\nPID alive: %d  Last-seen age: %ds\nOS facts: %s\nLast 50 pane lines:\n%s' \
        "$session" "$declared_state" "$declared_source" "$state_age_sec" \
        "$pid_alive" "$last_seen_age_sec" "$OS_FACTS_REASON" "$pane_output")"

      if [[ -z "$api_key" ]]; then
        ext_status="UNKNOWN"
        reason="stale+ambiguous, no API key for LLM fallback"
        method="no-api-key"
      else
        log "[$session] Ambiguous — calling LLM with enriched context"
        local llm_response
        llm_response="$(classify_with_openrouter "$agent" "$enriched_input" "$api_key")"
        local llm_status; llm_status="$(parse_status_word "$llm_response")"
        [[ "$llm_status" == "UNKNOWN" ]] && llm_status="ALIVE"  # safe fallback
        ext_status="$llm_status"
        reason="$(echo "$llm_response" | cut -d' ' -f2-)"
        method="llm-gemma"
      fi
    fi
  fi

  # Step 6: capture last status + track consecutive STUCK (both before insert)
  local last_ext; last_ext="$(get_last_external_status "$agent")"
  local consecutive=0
  if [[ "$ext_status" == "STUCK" ]]; then
    consecutive=$(( $(get_consecutive_stuck_v2 "$agent") + 1 ))
  fi

  # Step 7: persist
  insert_heartbeat_v2 "$agent" "$declared_state" "$declared_source" "$state_age_sec" \
    "$ext_status" "$method" "$reason" "$consecutive"

  # Step 8: alert
  alert_v2 "$agent" "$ext_status" "$declared_state" "$declared_source" "$reason" "$consecutive" "$last_ext"

  log "[$session] → $ext_status ($method) — $reason"
  echo "$ext_status"
}

# =============================================================================
# Main loop
# =============================================================================

main() {
  require_env
  log "========================================"
  log "heartbeat-daemon-v2 starting"
  log "Agents: ${AGENTS[*]}"
  log "========================================"

  # Feature flag check — sleep-loop if disabled
  while true; do
    local flag_enabled
    flag_enabled="$(sqlite3 "$TASKS_DB_PATH" \
      "SELECT enabled FROM feature_flags WHERE flag_name='heartbeat_v2_enabled' LIMIT 1;" \
      2>/dev/null || echo "0")"
    if [[ "$flag_enabled" == "1" ]]; then
      break
    fi
    log "heartbeat_v2_enabled=0 — sleeping 60s before re-check"
    sleep 60
  done

  log "heartbeat_v2_enabled=1 — starting monitor loop"
  init_db_v2

  local last_hourly=0
  set +e

  while true; do
    local now; now="$(date +%s)"
    log "--- Heartbeat-v2 tick at $(date '+%Y-%m-%d %H:%M:%S') ---"

    local api_key
    api_key="$(load_api_key 2>/dev/null)" || api_key=""
    [[ -z "$api_key" ]] && log "WARN: No OpenRouter API key — LLM fallback unavailable"

    local agent
    for agent in "${AGENTS[@]}"; do
      classify_agent_v2 "$agent" "$api_key" > /dev/null \
        || log "ERROR: classify_agent_v2 failed for $agent (continuing)"
    done

    if (( now - last_hourly >= HOURLY_INTERVAL )); then
      send_hourly_summary_v2 || log "WARN: hourly summary failed"
      last_hourly="$now"
    fi

    log "--- Tick complete. Sleeping ${CHECK_INTERVAL}s ---"
    sleep "$CHECK_INTERVAL"
  done
}

send_hourly_summary_v2() {
  local hour; hour="$(date '+%H:00')"
  local summary; summary="Heartbeat-v2 Status -- ${hour}"$'\n'
  local agent
  for agent in "${AGENTS[@]}"; do
    local last_st; last_st="$(get_last_external_status "$agent" 2>/dev/null)" || last_st="UNKNOWN"
    summary+="claude-${agent}: ${last_st}"$'\n'
  done
  log "Sending hourly-v2 summary"
  send_telegram "$summary" || log "WARN: Telegram send failed in hourly summary"
}

# =============================================================================
# Entry point guard
# =============================================================================

if (( _SOURCED == 0 )); then
  main "$@"
fi
