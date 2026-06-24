#!/usr/bin/env bash
# =============================================================================
# deadmans-sentinel.sh — Tier A: Same-host dead-man's switch for watchdog.ts
#
# Sprint 1 / DEL-3 — Launched by launchd (com.threadwork.deadmans-sentinel)
# Tick interval: 60s
# Behavior:
#   1. Write heartbeat at END of work cycle (mtime = proof of live classifier)
#   2. Check if watchdog.ts heartbeat file is stale
#   3. If stale → emit Telegram alarm (WATCHDOG_DEAD) with dedup-bypass
#   4. If watchdog service is disabled → skip check (Tier B still pings)
# =============================================================================

set -uo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

SENTINEL_DIR="${SENTINEL_DIR:-$HOME/.claude/state/heartbeat-v2}"
WATCHDOG_HEARTBEAT="$SENTINEL_DIR/watchdog-heartbeat"
SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
WATCHDOG_SERVICE_FLAG="$SENTINEL_DIR/watchdog-service-enabled"
DEADMAN_LOG="${DEADMAN_LOG:-$HOME/Library/Logs/com.threadwork.deadmans-sentinel.log}"
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-REPLACE_WITH_TELEGRAM_CHAT_ID}"

# Staleness threshold = tick_interval_sec * 2.2 (C3.9: stale at 2.2x, fresh at 2x-epsilon)
# Default: 60s tick → 132s stale threshold
TICK_INTERVAL_SEC="${TICK_INTERVAL_SEC:-60}"
STALE_THRESHOLD_SEC=$(( TICK_INTERVAL_SEC * 2 + TICK_INTERVAL_SEC / 5 ))

# Startup grace period: 300s from first run (C3.5)
STARTUP_GRACE_SEC="${STARTUP_GRACE_SEC:-300}"
STARTUP_MARKER="$SENTINEL_DIR/sentinel-startup-ts"

# =============================================================================
# Logging
# =============================================================================

log() {
  local ts; ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '[%s] %s\n' "$ts" "$*" >> "$DEADMAN_LOG" 2>/dev/null || true
  printf '[%s] %s\n' "$ts" "$*" >&2 || true
}

# =============================================================================
# Telegram send (dedup-bypass for WATCHDOG_DEAD — always fires)
# =============================================================================

send_telegram() {
  local text="$1"
  if [[ -z "${TELEGRAM_TOKEN:-}" ]]; then
    log "WARN: TELEGRAM_TOKEN not set, cannot send Telegram alert"
    return 1
  fi
  curl -s -X POST \
    "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    > /dev/null 2>&1 || log "WARN: Telegram send failed"
}

# =============================================================================
# Startup grace check
# =============================================================================

is_in_startup_grace() {
  if [[ ! -f "$STARTUP_MARKER" ]]; then
    # First run — create marker
    date +%s > "$STARTUP_MARKER"
    return 0 # in grace
  fi
  local start_ts; start_ts="$(cat "$STARTUP_MARKER" 2>/dev/null || echo 0)"
  local now_ts; now_ts="$(date +%s)"
  local elapsed=$(( now_ts - start_ts ))
  [[ "$elapsed" -lt "$STARTUP_GRACE_SEC" ]]
}

# =============================================================================
# Check if watchdog service is enabled
# =============================================================================

is_watchdog_service_enabled() {
  # Default: enabled. Disable by writing 'false' to watchdog-service-enabled flag
  if [[ -f "$WATCHDOG_SERVICE_FLAG" ]]; then
    local val; val="$(cat "$WATCHDOG_SERVICE_FLAG" 2>/dev/null | tr -d '[:space:]')"
    [[ "$val" != "false" ]]
  else
    return 0 # enabled by default
  fi
}

# =============================================================================
# Check staleness of watchdog heartbeat file
# =============================================================================

is_watchdog_heartbeat_stale() {
  if [[ ! -f "$WATCHDOG_HEARTBEAT" ]]; then
    return 0 # missing = stale
  fi
  local mtime_sec; mtime_sec="$(stat -f %m "$WATCHDOG_HEARTBEAT" 2>/dev/null || echo 0)"
  local now_sec; now_sec="$(date +%s)"
  local age=$(( now_sec - mtime_sec ))
  [[ "$age" -gt "$STALE_THRESHOLD_SEC" ]]
}

# =============================================================================
# Write sentinel heartbeat (at END of work cycle — DO NOT move this to the top)
# This is the work-cycle-end semantic: the heartbeat proves classifier ran
# =============================================================================

write_sentinel_heartbeat() {
  mkdir -p "$SENTINEL_DIR"
  touch "$SENTINEL_HEARTBEAT"
}

# =============================================================================
# Main work cycle
# =============================================================================

main() {
  mkdir -p "$SENTINEL_DIR"
  log "deadmans-sentinel tick started"

  # Startup grace: no alarms for first STARTUP_GRACE_SEC
  if is_in_startup_grace; then
    log "In startup grace period (${STARTUP_GRACE_SEC}s), skipping alarm check"
    write_sentinel_heartbeat
    return 0
  fi

  # Check if watchdog service is enabled
  if ! is_watchdog_service_enabled; then
    log "Watchdog service marked disabled (enabled=false in flag file), skipping alarm check"
    # Tier B still pings even when Tier A check is disabled
    write_sentinel_heartbeat
    return 0
  fi

  # Check watchdog heartbeat staleness
  if is_watchdog_heartbeat_stale; then
    local mtime_age=0
    if [[ -f "$WATCHDOG_HEARTBEAT" ]]; then
      local mtime_sec; mtime_sec="$(stat -f %m "$WATCHDOG_HEARTBEAT" 2>/dev/null || echo 0)"
      local now_sec; now_sec="$(date +%s)"
      mtime_age=$(( now_sec - mtime_sec ))
    fi

    log "WATCHDOG_DEAD: heartbeat stale (age=${mtime_age}s, threshold=${STALE_THRESHOLD_SEC}s) — sending Telegram alarm (dedup-bypass)"

    local hostname; hostname="$(hostname -s 2>/dev/null || echo 'unknown')"
    local ts; ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

    send_telegram "$(printf '[DEADMAN TIER-A]\nstate=WATCHDOG_DEAD\nreason_class=DEADMAN_TRIGGERED\nhost=%s\nheartbeat_age=%ds\nstale_threshold=%ds\nts=%s\n\nwatchdog.ts appears dead. Check: bun watchdog.ts' \
      "$hostname" "$mtime_age" "$STALE_THRESHOLD_SEC" "$ts")"
  else
    log "Watchdog heartbeat is fresh (threshold=${STALE_THRESHOLD_SEC}s)"
  fi

  # Write sentinel heartbeat at END of work cycle (not at start)
  # This is the work-cycle-end semantic (C3.8): proves the classifier ran to completion
  write_sentinel_heartbeat
  log "Sentinel heartbeat written at end of work cycle"
}

# Allow sourcing for tests
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
