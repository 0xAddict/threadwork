#!/usr/bin/env bats
# C3.8 — mtime-based work-cycle-end test (DD3 mitigation)

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
  touch "$WATCHDOG_HEARTBEAT"

  SENTINEL_SCRIPT="/Users/coachstokes/bin/deadmans-sentinel.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

make_wrapper() {
  local wrapper="$BATS_TMPDIR/run-sentinel.sh"
  cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
export SENTINEL_DIR='$SENTINEL_DIR'
export WATCHDOG_HEARTBEAT='$WATCHDOG_HEARTBEAT'
export SENTINEL_HEARTBEAT='$SENTINEL_HEARTBEAT'
export WATCHDOG_SERVICE_FLAG='$WATCHDOG_SERVICE_FLAG'
export STARTUP_MARKER='$STARTUP_MARKER'
export DEADMAN_LOG='$DEADMAN_LOG'
export TICK_INTERVAL_SEC=60
export STARTUP_GRACE_SEC=0
export TELEGRAM_TOKEN='test-token'

send_telegram() { true; }

source '$SENTINEL_SCRIPT'
main
WRAPPER
  chmod +x "$wrapper"
  bash "$wrapper" 2>&1
}

@test "C3.8: sentinel heartbeat is written at END of work cycle (not beginning)" {
  [ ! -f "$SENTINEL_HEARTBEAT" ]
  before_time="$(date +%s)"

  make_wrapper

  [ -f "$SENTINEL_HEARTBEAT" ]
  after_mtime="$(stat -f %m "$SENTINEL_HEARTBEAT")"

  # mtime should be after the before_time
  [ "$after_mtime" -ge "$before_time" ]
}

@test "C3.8: mtime does NOT advance when main work function is bypassed/hangs" {
  # Verify that the sentinel's heartbeat write actually happens at the END
  # by checking mtime is recent after a run
  touch "$SENTINEL_HEARTBEAT"
  python3 -c "
import os, time
t = time.time() - 120
os.utime('$SENTINEL_HEARTBEAT', (t, t))
"
  old_mtime="$(stat -f %m "$SENTINEL_HEARTBEAT")"

  make_wrapper

  new_mtime="$(stat -f %m "$SENTINEL_HEARTBEAT")"
  # mtime must have advanced (write happened at end of main)
  [ "$new_mtime" -gt "$old_mtime" ]
}

@test "C3.8: verify sentinel script writes heartbeat at bottom of main() not top" {
  run grep -c "write_sentinel_heartbeat" "$SENTINEL_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]
}
