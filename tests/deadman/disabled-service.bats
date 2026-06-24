#!/usr/bin/env bats
# C3.4 — Mark subagent-stall-watcher as enabled:false → missing heartbeat does NOT trigger Tier A

setup() {
  BATS_TMPDIR=$(mktemp -d /tmp/deadman-test-XXXXXX)
  SENTINEL_DIR="$BATS_TMPDIR/heartbeat-v2"
  WATCHDOG_HEARTBEAT="$SENTINEL_DIR/watchdog-heartbeat"
  SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
  WATCHDOG_SERVICE_FLAG="$SENTINEL_DIR/watchdog-service-enabled"
  STARTUP_MARKER="$SENTINEL_DIR/sentinel-startup-ts"
  DEADMAN_LOG="$BATS_TMPDIR/deadman.log"

  mkdir -p "$SENTINEL_DIR"
  echo "$(( $(date +%s) - 600 ))" > "$STARTUP_MARKER"
  echo "false" > "$WATCHDOG_SERVICE_FLAG"

  SENTINEL_SCRIPT="/Users/coachstokes/bin/deadmans-sentinel.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

run_sentinel_with_flag() {
  local flag="$1"
  echo "$flag" > "$WATCHDOG_SERVICE_FLAG"
  SENTINEL_DIR="$SENTINEL_DIR" \
  WATCHDOG_HEARTBEAT="$WATCHDOG_HEARTBEAT" \
  SENTINEL_HEARTBEAT="$SENTINEL_HEARTBEAT" \
  WATCHDOG_SERVICE_FLAG="$WATCHDOG_SERVICE_FLAG" \
  STARTUP_MARKER="$STARTUP_MARKER" \
  DEADMAN_LOG="$DEADMAN_LOG" \
  TICK_INTERVAL_SEC=60 \
  STARTUP_GRACE_SEC=0 \
  TELEGRAM_TOKEN="" \
  bash "$SENTINEL_SCRIPT" 2>&1
}

@test "C3.4: disabled watchdog service → no WATCHDOG_DEAD logged (no alarm)" {
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel_with_flag "false" || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG" 2>/dev/null
  [ "$status" -ne 0 ]
}

@test "C3.4: disabled watchdog service → sentinel still writes its own heartbeat" {
  run_sentinel_with_flag "false" || true

  [ -f "$SENTINEL_HEARTBEAT" ]
}

@test "C3.4: enabled service → stale heartbeat triggers WATCHDOG_DEAD" {
  rm -f "$DEADMAN_LOG"

  run_sentinel_with_flag "true" || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
}
