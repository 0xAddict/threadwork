#!/usr/bin/env bats
# C3.10 — Secret file mode != 0600 → warning log + Telegram meta-alert "secret file permissions wrong"

setup() {
  BATS_TMPDIR=$(mktemp -d /tmp/deadman-test-XXXXXX)
  SENTINEL_DIR="$BATS_TMPDIR/heartbeat-v2"
  SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
  SECRETS_FILE="$BATS_TMPDIR/healthchecks-url"
  PINGER_LOG="$BATS_TMPDIR/pinger.log"
  PING_LOG="$BATS_TMPDIR/ping.log"

  mkdir -p "$SENTINEL_DIR"
  touch "$SENTINEL_HEARTBEAT"

  PINGER_SCRIPT="/Users/coachstokes/bin/healthchecks-pinger.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

run_pinger() {
  SENTINEL_DIR="$SENTINEL_DIR" \
  SENTINEL_HEARTBEAT="$SENTINEL_HEARTBEAT" \
  SECRETS_FILE="$SECRETS_FILE" \
  PINGER_LOG="$PINGER_LOG" \
  SENTINEL_TICK_SEC=60 \
  TELEGRAM_TOKEN="" \
  bash "$PINGER_SCRIPT" 2>&1
}

@test "C3.10: secret file mode 0644 → warning logged in pinger log" {
  echo "https://hc-ping.com/test-uuid" > "$SECRETS_FILE"
  chmod 0644 "$SECRETS_FILE"

  run_pinger || true

  run cat "$PINGER_LOG"
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARN"* ]]
}

@test "C3.10: secret file mode 0644 → warning message mentions permissions" {
  echo "https://hc-ping.com/test-uuid" > "$SECRETS_FILE"
  chmod 0644 "$SECRETS_FILE"

  run_pinger || true

  run grep -i "permissions\|mode\|600" "$PINGER_LOG"
  [ "$status" -eq 0 ]
}

@test "C3.10: secret file mode 0600 → no permission warning" {
  echo "https://hc-ping.com/test-uuid" > "$SECRETS_FILE"
  chmod 0600 "$SECRETS_FILE"

  run_pinger || true

  run grep -i "permissions wrong\|wrong mode" "$PINGER_LOG" 2>/dev/null
  [ "$status" -ne 0 ]
}
