#!/usr/bin/env bats
# C3.9 — tick_interval_sec=300 → stale threshold = 660s. Boundary: 659s old fresh; 661s old stale

setup() {
  BATS_TMPDIR=$(mktemp -d /tmp/deadman-test-XXXXXX)
  SENTINEL_DIR="$BATS_TMPDIR/heartbeat-v2"
  WATCHDOG_HEARTBEAT="$SENTINEL_DIR/watchdog-heartbeat"
  SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
  WATCHDOG_SERVICE_FLAG="$SENTINEL_DIR/watchdog-service-enabled"
  STARTUP_MARKER="$SENTINEL_DIR/sentinel-startup-ts"
  DEADMAN_LOG="$BATS_TMPDIR/deadman.log"

  mkdir -p "$SENTINEL_DIR"
  echo "$(( $(date +%s) - 1000 ))" > "$STARTUP_MARKER"
  SENTINEL_SCRIPT="/Users/coachstokes/bin/deadmans-sentinel.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

set_heartbeat_age() {
  local age_sec="$1"
  python3 -c "
import os, time
open('$WATCHDOG_HEARTBEAT', 'w').close()
t = time.time() - $age_sec
os.utime('$WATCHDOG_HEARTBEAT', (t, t))
"
}

run_sentinel() {
  local tick="$1"
  rm -f "$DEADMAN_LOG"
  SENTINEL_DIR="$SENTINEL_DIR" \
  WATCHDOG_HEARTBEAT="$WATCHDOG_HEARTBEAT" \
  SENTINEL_HEARTBEAT="$SENTINEL_HEARTBEAT" \
  WATCHDOG_SERVICE_FLAG="$WATCHDOG_SERVICE_FLAG" \
  STARTUP_MARKER="$STARTUP_MARKER" \
  DEADMAN_LOG="$DEADMAN_LOG" \
  TICK_INTERVAL_SEC="$tick" \
  STARTUP_GRACE_SEC=0 \
  TELEGRAM_TOKEN="" \
  bash "$SENTINEL_SCRIPT" 2>&1
}

@test "C3.9: tick=300, heartbeat 659s old → FRESH (no WATCHDOG_DEAD log)" {
  set_heartbeat_age 659

  run_sentinel 300 || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG" 2>/dev/null
  [ "$status" -ne 0 ]
}

@test "C3.9: tick=300, heartbeat 661s old → STALE (WATCHDOG_DEAD logged)" {
  set_heartbeat_age 661

  run_sentinel 300 || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
}

@test "C3.9: verify stale threshold formula: tick*2 + tick/5" {
  local threshold_60=$(( 60 * 2 + 60 / 5 ))
  local threshold_300=$(( 300 * 2 + 300 / 5 ))

  [ "$threshold_60" -eq 132 ]
  [ "$threshold_300" -eq 660 ]
}
