#!/usr/bin/env bats
# C2.2 — 6th startup self-terminates with non-zero code; tracker last_action=self-terminated-cap

bats_require_minimum_version 1.5.0

TASK_BOARD_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

setup() {
  TEST_DIR=$(mktemp -d)
  NOW=$(date +%s)
  BUN="${HOME}/.bun/bin/bun"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "C2.2: 6th startup within 60s self-terminates with non-zero exit code" {
  local svc="watchdog.ts"
  local now="$NOW"

  # Simulate 5 previous restarts in the last 60s
  python3 -c "
import json
now = $now
timestamps = [now - 50, now - 40, now - 30, now - 20, now - 10]
data = {
  'service': '$svc',
  'restart_timestamps_unix': timestamps,
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'running',
  'last_action_at': '2026-05-27T00:00:00Z'
}
with open('${TEST_DIR}/$svc.json', 'w') as f:
    json.dump(data, f)
"

  # 6th startup should fail with exit code 1
  run "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60

  [ "$status" -ne 0 ]
}

@test "C2.2: tracker last_action=self-terminated-cap after 6th startup" {
  local svc="watchdog.ts"
  local now="$NOW"

  python3 -c "
import json
now = $now
timestamps = [now - 50, now - 40, now - 30, now - 20, now - 10]
data = {
  'service': '$svc',
  'restart_timestamps_unix': timestamps,
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'running',
  'last_action_at': '2026-05-27T00:00:00Z'
}
with open('${TEST_DIR}/$svc.json', 'w') as f:
    json.dump(data, f)
"

  # Run 6th startup (will fail)
  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60 || true

  # Check tracker file has last_action=self-terminated-cap
  run python3 -c "
import json
with open('${TEST_DIR}/$svc.json') as f:
    d = json.load(f)
assert d['last_action'] == 'self-terminated-cap', f'expected self-terminated-cap, got {d[\"last_action\"]}'
print('OK: last_action=self-terminated-cap')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"self-terminated-cap"* ]]
}

@test "C2.2: 5th startup within 60s does NOT self-terminate" {
  local svc="watchdog.ts"
  local now="$NOW"

  # Only 4 previous restarts → 5th startup should succeed
  python3 -c "
import json
now = $now
timestamps = [now - 50, now - 40, now - 30, now - 20]
data = {
  'service': '$svc',
  'restart_timestamps_unix': timestamps,
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'running',
  'last_action_at': '2026-05-27T00:00:00Z'
}
with open('${TEST_DIR}/$svc.json', 'w') as f:
    json.dump(data, f)
"

  run "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60

  [ "$status" -eq 0 ]
}
