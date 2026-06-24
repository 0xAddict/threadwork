#!/usr/bin/env bats
# C3.7 — Tier A's own heartbeat stale → Tier B detects, stops pinging

setup() {
  BATS_TMPDIR=$(mktemp -d /tmp/deadman-test-XXXXXX)
  SENTINEL_DIR="$BATS_TMPDIR/heartbeat-v2"
  SENTINEL_HEARTBEAT="$SENTINEL_DIR/sentinel-heartbeat"
  SECRETS_FILE="$BATS_TMPDIR/healthchecks-url"
  PINGER_LOG="$BATS_TMPDIR/pinger.log"

  mkdir -p "$SENTINEL_DIR"
  echo "https://hc-ping.com/test-uuid" > "$SECRETS_FILE"
  chmod 0600 "$SECRETS_FILE"

  local fakecurl="$BATS_TMPDIR/curl"
  cat > "$fakecurl" <<'FAKECURL'
#!/usr/bin/env bash
printf 'curl-called: %s\n' "$*" >> "${PING_LOG:-/dev/null}"
exit 0
FAKECURL
  chmod +x "$fakecurl"

  PINGER_SCRIPT="/Users/coachstokes/bin/healthchecks-pinger.sh"
}

teardown() {
  rm -rf "$BATS_TMPDIR"
}

run_pinger() {
  PATH="$BATS_TMPDIR:$PATH" \
  SENTINEL_DIR="$SENTINEL_DIR" \
  SENTINEL_HEARTBEAT="$SENTINEL_HEARTBEAT" \
  SECRETS_FILE="$SECRETS_FILE" \
  PINGER_LOG="$PINGER_LOG" \
  SENTINEL_TICK_SEC=60 \
  PING_LOG="$BATS_TMPDIR/ping.log" \
  TELEGRAM_TOKEN="" \
  bash "$PINGER_SCRIPT" 2>&1 || true
}

@test "C3.7: Tier B stops pinging when Tier A sentinel heartbeat is stale" {
  python3 -c "
import os, time
open('$SENTINEL_HEARTBEAT', 'w').close()
t = time.time() - 7200
os.utime('$SENTINEL_HEARTBEAT', (t, t))
"
  run_pinger

  run [ -f "$BATS_TMPDIR/ping.log" ]
  if [ "$status" -eq 0 ]; then
    run grep -q "curl-called" "$BATS_TMPDIR/ping.log"
    [ "$status" -ne 0 ]
  fi
}

@test "C3.7: when Tier A sentinel is alive, Tier B continues pinging" {
  touch "$SENTINEL_HEARTBEAT"

  run_pinger

  run cat "$BATS_TMPDIR/ping.log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"curl-called"* ]]
}
