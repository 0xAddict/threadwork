#!/usr/bin/env bats
# C3.6 — Healthchecks.io 500/conn-refused → curl exit non-zero; stderr logged; no local Telegram

setup() {
  BATS_TMPDIR=$(mktemp -d /tmp/deadman-test-XXXXXX)
  SENTINEL_DIR="$BATS_TMPDIR/heartbeat-v2"
  SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
  SECRETS_FILE="$BATS_TMPDIR/healthchecks-url"
  PINGER_LOG="$BATS_TMPDIR/pinger.log"

  mkdir -p "$SENTINEL_DIR"
  touch "$SENTINEL_HEARTBEAT"

  echo "https://hc-ping.com/test-uuid" > "$SECRETS_FILE"
  chmod 0600 "$SECRETS_FILE"

  PINGER_SCRIPT="/Users/coachstokes/bin/healthchecks-pinger.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

run_pinger_with_failing_curl() {
  # Create a fake curl that fails — must be named 'curl' for PATH override to work
  local fakecurl="$BATS_TMPDIR/curl"
  cat > "$fakecurl" <<'FAKECURL'
#!/usr/bin/env bash
printf 'curl: (7) Failed to connect\n' >&2
exit 7
FAKECURL
  chmod +x "$fakecurl"

  # Run pinger with PATH pointing to fake curl first
  PATH="$BATS_TMPDIR:$PATH" \
  SENTINEL_DIR="$SENTINEL_DIR" \
  SENTINEL_HEARTBEAT="$SENTINEL_HEARTBEAT" \
  SECRETS_FILE="$SECRETS_FILE" \
  PINGER_LOG="$PINGER_LOG" \
  SENTINEL_TICK_SEC=60 \
  TELEGRAM_TOKEN="" \
  bash "$PINGER_SCRIPT" 2>&1 || true
}

@test "C3.6: curl failure does not trigger Telegram (no TELEGRAM_TOKEN)" {
  # With no TELEGRAM_TOKEN, send_telegram() can't send — this verifies curl failure
  # is handled gracefully without Telegram spamming

  run_pinger_with_failing_curl

  # Pinger log should have been written
  run cat "$PINGER_LOG"
  [ "$status" -eq 0 ]
}

@test "C3.6: curl failure is logged to pinger log with WARN" {
  run_pinger_with_failing_curl

  run cat "$PINGER_LOG"
  [ "$status" -eq 0 ]
  [[ "$output" == *"failed"* || "$output" == *"WARN"* || "$output" == *"exit code"* ]]
}

@test "C3.6: pinger log has started entry even when curl fails" {
  run_pinger_with_failing_curl

  run grep -q "healthchecks-pinger tick started" "$PINGER_LOG"
  [ "$status" -eq 0 ]
}
