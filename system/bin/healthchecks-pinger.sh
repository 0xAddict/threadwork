#!/usr/bin/env bash
# =============================================================================
# healthchecks-pinger.sh — Tier B: External healthchecks.io pinger
#
# Sprint 1 / DEL-3 — Launched by launchd (com.threadwork.healthchecks-pinger)
# Tick interval: 60s
# Behavior:
#   1. Read ping URL from ~/.claude/state/secrets/healthchecks-url (mode 0600)
#   2. Check if Tier A sentinel heartbeat is fresh (acts as "all-fresh guard")
#   3. If fresh → ping healthchecks.io (keep external check alive)
#   4. If stale → stop pinging (healthchecks.io detects silence and fires alarm)
#   5. On secret file permission error → log warning + Telegram meta-alert
# =============================================================================

set -uo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

SECRETS_FILE="${SECRETS_FILE:-$HOME/.claude/state/secrets/healthchecks-url}"
SENTINEL_DIR="${SENTINEL_DIR:-$HOME/.claude/state/heartbeat-v2}"
SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
PINGER_LOG="${PINGER_LOG:-$HOME/Library/Logs/com.threadwork.healthchecks-pinger.log}"
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-REPLACE_WITH_TELEGRAM_CHAT_ID}"

# Sentinel staleness threshold: 2.2x the sentinel's tick interval
SENTINEL_TICK_SEC="${SENTINEL_TICK_SEC:-60}"
SENTINEL_STALE_SEC=$(( SENTINEL_TICK_SEC * 2 + SENTINEL_TICK_SEC / 5 ))

# =============================================================================
# Logging
# =============================================================================

log() {
  local ts; ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '[%s] %s\n' "$ts" "$*" >> "$PINGER_LOG" 2>/dev/null || true
  printf '[%s] %s\n' "$ts" "$*" >&2 || true
}

# =============================================================================
# Telegram send (for meta-alerts)
# =============================================================================

send_telegram() {
  local text="$1"
  if [[ -z "${TELEGRAM_TOKEN:-}" ]]; then
    log "WARN: TELEGRAM_TOKEN not set"
    return 1
  fi
  curl -s -X POST \
    "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    > /dev/null 2>&1 || log "WARN: Telegram send failed"
}

# =============================================================================
# Read and validate secret file
# =============================================================================

read_ping_url() {
  if [[ ! -f "$SECRETS_FILE" ]]; then
    log "ERROR: healthchecks-url secret file not found at $SECRETS_FILE"
    return 1
  fi

  # Check file permissions (must be 0600)
  local mode; mode="$(stat -f '%Lp' "$SECRETS_FILE" 2>/dev/null || echo '000')"
  if [[ "$mode" != "600" ]]; then
    log "WARN: Secret file permissions wrong: expected 600, got ${mode}"
    send_telegram "[META-ALERT] secret file permissions wrong: $SECRETS_FILE has mode ${mode} (expected 600)"
    return 1
  fi

  local url; url="$(cat "$SECRETS_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -z "$url" ]]; then
    log "ERROR: healthchecks-url secret file is empty"
    return 1
  fi

  # Validate URL format
  if ! echo "$url" | grep -qE 'https://hc-ping\.com|https://healthchecks\.io'; then
    log "ERROR: healthchecks-url does not look like a healthchecks.io URL: $url"
    return 1
  fi

  echo "$url"
  return 0
}

# =============================================================================
# Check if Tier A sentinel heartbeat is fresh
# =============================================================================

is_sentinel_fresh() {
  if [[ ! -f "$SENTINEL_HEARTBEAT" ]]; then
    log "WARN: Sentinel heartbeat file not found at $SENTINEL_HEARTBEAT"
    return 1 # stale
  fi
  local mtime_sec; mtime_sec="$(stat -f %m "$SENTINEL_HEARTBEAT" 2>/dev/null || echo 0)"
  local now_sec; now_sec="$(date +%s)"
  local age=$(( now_sec - mtime_sec ))
  if [[ "$age" -gt "$SENTINEL_STALE_SEC" ]]; then
    log "Sentinel heartbeat stale (age=${age}s, threshold=${SENTINEL_STALE_SEC}s) — not pinging"
    return 1 # stale
  fi
  return 0 # fresh
}

# =============================================================================
# Ping healthchecks.io
# =============================================================================

ping_healthchecks() {
  local url="$1"
  local exit_code=0
  curl -s --max-time 10 --retry 2 "$url" > /dev/null 2>&1 || exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    log "WARN: healthchecks.io ping failed (curl exit code $exit_code) — stderr logged above"
    # Log to stderr but do NOT send local Telegram (C3.6)
    printf '[%s] healthchecks-pinger: curl failed with exit code %d for URL: %s\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$exit_code" "$url" >&2 || true
    return $exit_code
  fi
  log "Pinged healthchecks.io successfully"
  return 0
}

# =============================================================================
# Main work cycle
# =============================================================================

main() {
  log "healthchecks-pinger tick started"

  # Read ping URL
  local ping_url
  if ! ping_url="$(read_ping_url)"; then
    log "Could not read valid ping URL, skipping ping this tick"
    return 0
  fi

  # Check if Tier A sentinel is fresh (all-fresh guard)
  if ! is_sentinel_fresh; then
    log "Tier A sentinel heartbeat is stale — stopping pings (healthchecks.io will alarm)"
    return 0
  fi

  # Ping healthchecks.io
  ping_healthchecks "$ping_url"
}

# Allow sourcing for tests
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
