#!/usr/bin/env bash
# restart-intensity-sentinel.sh — Sprint 2 DEL-2 restart-intensity-cap sentinel
#
# Polls every 30s. For each tracker file in ~/.claude/state/restart-tracker/:
#   (a) filter restart_timestamps_unix to [now-max_t_sec, now]
#   (b) if len(filtered) > max_r OR last_action == "self-terminated-cap"
#       → launchctl unload <plist>, set last_action="sentinel-unloaded", emit alerts
#   (c) clock-skew: timestamps > now are dropped with a warning
#
# Compatible with bash 3.2+

set -uo pipefail

TRACKER_DIR="${TRACKER_DIR:-${HOME}/.claude/state/restart-tracker}"
POLL_INTERVAL="${RESTART_INTENSITY_SENTINEL_POLL_SEC:-30}"
PLATFORM_HEALTH_TASK_ID="${RESTART_INTENSITY_PLATFORM_HEALTH_TASK:-}"
LAUNCHD_PLIST_DIR="${HOME}/Library/LaunchAgents"

log() {
  printf '[restart-intensity-sentinel] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# Look up plist name for a service (bash 3.2 compatible: no assoc arrays)
get_plist_name() {
  local service="$1"
  case "$service" in
    watchdog.ts)         echo "com.threadwork.watchdog" ;;
    heartbeat-daemon.sh) echo "com.threadwork.heartbeat" ;;
    subagent-stall-watcher.sh) echo "com.threadwork.subagent-stall-watcher" ;;
    *) echo "" ;;
  esac
}

emit_alert() {
  local service="$1"
  local msg="$2"

  log "ALERT: $msg"

  # (c) stderr
  printf '[restart-intensity-cap] ALERT: %s\n' "$msg" >&2

  # (a) Telegram alert via curl (heartbeat-daemon direct Telegram path)
  # This path is used even when watchdog.ts is dead, per DoD-05 §9
  local tg_token tg_chat_id
  tg_token="${TELEGRAM_BOT_TOKEN:-}"
  tg_chat_id="${TELEGRAM_CHAT_ID:-REPLACE_WITH_TELEGRAM_CHAT_ID}"

  if [[ -n "$tg_token" ]]; then
    curl -sS -X POST "https://api.telegram.org/bot${tg_token}/sendMessage" \
      -d "chat_id=${tg_chat_id}" \
      -d "text=[restart-intensity-sentinel] ${msg}" \
      -d "parse_mode=HTML" 2>/dev/null || true
  fi

  # (b) task-board send_note (if task ID configured)
  if [[ -n "$PLATFORM_HEALTH_TASK_ID" ]]; then
    local tb_script="${HOME}/.claude/mcp-servers/task-board/scripts/send-note.sh"
    if [[ -x "$tb_script" ]]; then
      "$tb_script" "$PLATFORM_HEALTH_TASK_ID" "$msg" 2>/dev/null || true
    fi
  fi
}

check_service() {
  local tracker_file="$1"

  [[ -f "$tracker_file" ]] || return 0

  local now
  now=$(date +%s)

  # Use python3 to parse + evaluate the tracker file
  local py_output
  py_output=$(python3 - "$tracker_file" "$now" 2>&1 <<'PYEOF'
import json, sys

tracker_file = sys.argv[1]
now = int(sys.argv[2])

try:
    with open(tracker_file, 'r') as f:
        data = json.load(f)
except (json.JSONDecodeError, ValueError) as e:
    print("CORRUPTED:" + str(e), flush=True)
    sys.exit(0)

service = data.get("service", "unknown")
timestamps = data.get("restart_timestamps_unix", [])
max_r = data.get("max_r", 5)
max_t_sec = data.get("max_t_sec", 60)
last_action = data.get("last_action", "running")

# Clock-skew: drop future timestamps
future_dropped = [t for t in timestamps if t > now]
if future_dropped:
    print("CLOCK_SKEW_DROP:" + str(len(future_dropped)), flush=True)

# Filter to window [now - max_t_sec, now]
filtered = [t for t in timestamps if now - max_t_sec <= t <= now]

trip = len(filtered) > max_r or last_action == "self-terminated-cap"
already_unloaded = last_action == "sentinel-unloaded"

print("SERVICE:" + service, flush=True)
print("FILTERED_COUNT:" + str(len(filtered)), flush=True)
print("MAX_R:" + str(max_r), flush=True)
print("LAST_ACTION:" + last_action, flush=True)
print("TRIP:" + str(trip), flush=True)
print("ALREADY_UNLOADED:" + str(already_unloaded), flush=True)
PYEOF
  ) || {
    log "WARNING: python3 failed for $tracker_file"
    return 0
  }

  # Extract fields from python output lines (KEY:VALUE format)
  local service trip already_unloaded last_action filtered_count max_r clock_skew_drop corrupted

  service=$(printf '%s\n' "$py_output" | grep '^SERVICE:' | cut -d: -f2- || echo "unknown")
  trip=$(printf '%s\n' "$py_output" | grep '^TRIP:' | cut -d: -f2 || echo "False")
  already_unloaded=$(printf '%s\n' "$py_output" | grep '^ALREADY_UNLOADED:' | cut -d: -f2 || echo "False")
  last_action=$(printf '%s\n' "$py_output" | grep '^LAST_ACTION:' | cut -d: -f2 || echo "running")
  filtered_count=$(printf '%s\n' "$py_output" | grep '^FILTERED_COUNT:' | cut -d: -f2 || echo "0")
  max_r=$(printf '%s\n' "$py_output" | grep '^MAX_R:' | cut -d: -f2 || echo "5")
  clock_skew_drop=$(printf '%s\n' "$py_output" | grep '^CLOCK_SKEW_DROP:' | cut -d: -f2 || echo "0")
  corrupted=$(printf '%s\n' "$py_output" | grep '^CORRUPTED:' | cut -d: -f2- || echo "")

  if [[ -n "$corrupted" ]]; then
    log "WARNING: tracker file $tracker_file is corrupted ($corrupted), skipping"
    return 0
  fi

  if [[ "$clock_skew_drop" != "0" && -n "$clock_skew_drop" ]]; then
    log "WARNING: service=$service dropped $clock_skew_drop future timestamps (clock skew)"
  fi

  if [[ "$trip" != "True" ]]; then
    return 0
  fi

  if [[ "$already_unloaded" == "True" ]]; then
    log "service=$service already sentinel-unloaded, skipping"
    return 0
  fi

  log "cap trip detected for service=$service (filtered=$filtered_count > max_r=$max_r OR last_action=$last_action)"

  # Call launchctl unload
  local plist_name
  plist_name=$(get_plist_name "$service")
  if [[ -n "$plist_name" ]]; then
    local plist_path="${LAUNCHD_PLIST_DIR}/${plist_name}.plist"
    if [[ -f "$plist_path" ]]; then
      log "calling launchctl unload $plist_path"
      launchctl unload "$plist_path" 2>/dev/null || true
    else
      log "WARNING: plist not found at $plist_path (service=$service)"
    fi
  fi

  # Update tracker: set last_action=sentinel-unloaded
  local now_iso
  now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  python3 - "$tracker_file" "$now_iso" 2>/dev/null <<'UPDATEEOF' || true
import json, sys, os

tracker_file = sys.argv[1]
now_iso = sys.argv[2]

try:
    with open(tracker_file, 'r') as f:
        data = json.load(f)
except Exception:
    data = {}

data["last_action"] = "sentinel-unloaded"
data["last_action_at"] = now_iso

tmp = tracker_file + ".tmp"
with open(tmp, 'w') as f:
    json.dump(data, f, indent=2)
os.rename(tmp, tracker_file)
UPDATEEOF

  # Emit alerts
  local alert_msg="restart-intensity cap exceeded for service=$service (restart_count=$filtered_count, max_r=$max_r). Service unloaded by sentinel."
  emit_alert "$service" "$alert_msg"
}

main_loop() {
  log "starting (poll_interval=${POLL_INTERVAL}s, tracker_dir=${TRACKER_DIR})"

  while true; do
    if [[ -d "$TRACKER_DIR" ]]; then
      for tracker_file in "${TRACKER_DIR}"/*.json; do
        [[ -f "$tracker_file" ]] || continue
        check_service "$tracker_file"
      done
    fi
    sleep "$POLL_INTERVAL"
  done
}

# If called with --check-once, do a single pass (for tests)
if [[ "${1:-}" == "--check-once" ]]; then
  if [[ -d "$TRACKER_DIR" ]]; then
    for tracker_file in "${TRACKER_DIR}"/*.json; do
      [[ -f "$tracker_file" ]] || continue
      check_service "$tracker_file"
    done
  fi
  exit 0
fi

main_loop
