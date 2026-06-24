#!/usr/bin/env bats
# C3.5 — Fresh install: 300s startup grace, no alarms before grace, missing heartbeats trigger after

setup() {
  BATS_TMPDIR=$(mktemp -d /tmp/deadman-test-XXXXXX)
  SENTINEL_DIR="$BATS_TMPDIR/heartbeat-v2"
  WATCHDOG_HEARTBEAT="$SENTINEL_DIR/watchdog-heartbeat"
  SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
  WATCHDOG_SERVICE_FLAG="$SENTINEL_DIR/watchdog-service-enabled"
  STARTUP_MARKER="$SENTINEL_DIR/sentinel-startup-ts"
  DEADMAN_LOG="$BATS_TMPDIR/deadman.log"

  mkdir -p "$SENTINEL_DIR"
  SENTINEL_SCRIPT="/Users/coachstokes/bin/deadmans-sentinel.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

run_sentinel() {
  local grace="$1"
  SENTINEL_DIR="$SENTINEL_DIR" \
  WATCHDOG_HEARTBEAT="$WATCHDOG_HEARTBEAT" \
  SENTINEL_HEARTBEAT="$SENTINEL_HEARTBEAT" \
  WATCHDOG_SERVICE_FLAG="$WATCHDOG_SERVICE_FLAG" \
  STARTUP_MARKER="$STARTUP_MARKER" \
  DEADMAN_LOG="$DEADMAN_LOG" \
  TICK_INTERVAL_SEC=60 \
  STARTUP_GRACE_SEC="$grace" \
  TELEGRAM_TOKEN="" \
  bash "$SENTINEL_SCRIPT" 2>&1
}

@test "C3.5: no alarm during startup grace period even with missing heartbeat" {
  [ ! -f "$STARTUP_MARKER" ]
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel 300 || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG" 2>/dev/null
  [ "$status" -ne 0 ]

  [ -f "$STARTUP_MARKER" ]
}

@test "C3.5: alarm fires after grace period expires with missing heartbeat" {
  echo "$(( $(date +%s) - 600 ))" > "$STARTUP_MARKER"
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel 300 || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
}

@test "C3.5: no alarm during grace when startup marker is recent (60s old, grace=300s)" {
  echo "$(( $(date +%s) - 60 ))" > "$STARTUP_MARKER"
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel 300 || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG" 2>/dev/null
  [ "$status" -ne 0 ]
}
