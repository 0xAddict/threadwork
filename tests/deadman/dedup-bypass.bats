#!/usr/bin/env bats
# C3.11 — Tier A Telegram path uses dedup-bypass; WATCHDOG_DEAD alarm fires every tick

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
  SENTINEL_SCRIPT="/Users/coachstokes/bin/deadmans-sentinel.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

run_sentinel() {
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

@test "C3.11: WATCHDOG_DEAD condition is logged on first tick" {
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel || true

  run grep -c "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

@test "C3.11: WATCHDOG_DEAD condition logged AGAIN on second tick (dedup-bypass: no state stored)" {
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel || true
  run_sentinel || true

  run grep -c "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]
}

@test "C3.11: dedup-bypass fires every tick while watchdog remains dead (3 ticks)" {
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel || true
  run_sentinel || true
  run_sentinel || true

  run grep -c "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
  [ "$output" -ge 3 ]
}
