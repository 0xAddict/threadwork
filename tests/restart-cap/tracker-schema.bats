#!/usr/bin/env bats
# C2.12 — Tracker file schema validates: keys service, restart_timestamps_unix, max_r, max_t_sec, last_action, last_action_at

bats_require_minimum_version 1.5.0

TASK_BOARD_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
BUN="${HOME}/.bun/bin/bun"

setup() {
  TEST_DIR=$(mktemp -d)
  NOW=$(date +%s)
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "C2.12: tracker file contains all required schema keys after startup" {
  local svc="watchdog.ts"
  local now="$NOW"

  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60 >/dev/null 2>&1 || true

  run python3 -c "
import json
with open('${TEST_DIR}/$svc.json') as f:
    d = json.load(f)

required_keys = ['service', 'restart_timestamps_unix', 'max_r', 'max_t_sec', 'last_action', 'last_action_at']
missing = [k for k in required_keys if k not in d]
if missing:
    print('FAIL: missing keys:', missing)
    exit(1)

# Validate types
assert isinstance(d['service'], str), 'service must be string'
assert isinstance(d['restart_timestamps_unix'], list), 'restart_timestamps_unix must be list'
assert isinstance(d['max_r'], int), 'max_r must be int'
assert isinstance(d['max_t_sec'], int), 'max_t_sec must be int'
assert d['last_action'] in ('running', 'self-terminated-cap', 'sentinel-unloaded'), \
    f'last_action must be enum, got: {d[\"last_action\"]}'
assert isinstance(d['last_action_at'], str), 'last_action_at must be string (ISO8601)'
assert 'T' in d['last_action_at'] and 'Z' in d['last_action_at'], \
    f'last_action_at must be ISO8601: {d[\"last_action_at\"]}'

print('OK: all schema keys present with correct types')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}

@test "C2.12: tracker schema service field matches requested service" {
  local svc="heartbeat-daemon.sh"
  local now="$NOW"

  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60 >/dev/null 2>&1 || true

  run python3 -c "
import json
with open('${TEST_DIR}/$svc.json') as f:
    d = json.load(f)
assert d['service'] == '$svc', f'expected $svc, got {d[\"service\"]}'
print('OK:', d['service'])
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"heartbeat-daemon.sh"* ]]
}

@test "C2.12: tracker schema restart_timestamps_unix contains only integers" {
  local svc="subagent-stall-watcher.sh"
  local now="$NOW"

  # Run 3 startups to populate timestamps
  for i in 1 2 3; do
    "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
      --service="$svc" \
      --tracker-dir="$TEST_DIR" \
      --now="$((now + i * 5))" \
      --max-r=10 \
      --max-t-sec=60 >/dev/null 2>&1 || true
  done

  run python3 -c "
import json
with open('${TEST_DIR}/$svc.json') as f:
    d = json.load(f)

timestamps = d['restart_timestamps_unix']
assert len(timestamps) > 0, 'should have timestamps'
for ts in timestamps:
    assert isinstance(ts, int), f'timestamp must be int, got {type(ts)}: {ts}'
print('OK:', len(timestamps), 'integer timestamps')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}
