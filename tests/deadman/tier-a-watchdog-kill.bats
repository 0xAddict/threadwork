#!/usr/bin/env bats
# C3.1 — Kill watchdog.ts → within 11 min, Tier A emits Telegram alarm (state=WATCHDOG_DEAD)

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

@test "C3.1: missing watchdog heartbeat → WATCHDOG_DEAD logged (alarm condition met)" {
  [ ! -f "$WATCHDOG_HEARTBEAT" ]

  run_sentinel || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
}

@test "C3.1: stale watchdog heartbeat (11min old) → WATCHDOG_DEAD logged" {
  python3 -c "
import os, time
open('$WATCHDOG_HEARTBEAT', 'w').close()
t = time.time() - 660
os.utime('$WATCHDOG_HEARTBEAT', (t, t))
"
  run_sentinel || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG"
  [ "$status" -eq 0 ]
}

@test "C3.1: fresh watchdog heartbeat → no WATCHDOG_DEAD in log" {
  touch "$WATCHDOG_HEARTBEAT"

  run_sentinel || true

  run grep -q "WATCHDOG_DEAD" "$DEADMAN_LOG" 2>/dev/null
  [ "$status" -ne 0 ]
}

@test "C3.1: sentinel writes its own heartbeat at end of work cycle" {
  touch "$WATCHDOG_HEARTBEAT"

  run_sentinel || true

  [ -f "$SENTINEL_HEARTBEAT" ]
}
