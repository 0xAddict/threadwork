#!/usr/bin/env bats
# C2.7 — restart-intensity-clear: rejects no --reason; with --reason deletes tracker + appends audit-log

bats_require_minimum_version 1.5.0

CLEAR_TOOL="${HOME}/.claude/tools/restart-intensity-clear"

setup() {
  TEST_DIR=$(mktemp -d)
  # Point the clear tool at our test tracker dir via env var
  export TRACKER_DIR="$TEST_DIR"

  # Create a fake tracker file in the TRACKER_DIR
  python3 -c "
import json
data = {
  'service': 'watchdog.ts',
  'restart_timestamps_unix': [1716830000, 1716830012],
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'self-terminated-cap',
  'last_action_at': '2026-05-27T00:00:00Z'
}
with open('${TEST_DIR}/watchdog.ts.json', 'w') as f:
    json.dump(data, f)
"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "C2.7: clear tool without --reason exits non-zero" {
  run env TRACKER_DIR="${TEST_DIR}" bash "$CLEAR_TOOL" watchdog.ts

  [ "$status" -ne 0 ]
  [[ "$output" == *"--reason"* ]] || [[ "$output" == *"required"* ]]
}

@test "C2.7: clear tool with --reason deletes tracker file" {
  cp "${TEST_DIR}/watchdog.ts.json" "${TEST_DIR}/watchdog.ts.json.bak"

  run env TRACKER_DIR="${TEST_DIR}" bash "$CLEAR_TOOL" watchdog.ts '--reason=fixed config bug'

  [ "$status" -eq 0 ]
  [ ! -f "${TEST_DIR}/watchdog.ts.json" ]
}

@test "C2.7: clear tool with --reason appends audit log" {
  run env TRACKER_DIR="${TEST_DIR}" bash "$CLEAR_TOOL" watchdog.ts '--reason=operator intervention test'

  [ "$status" -eq 0 ]
  [ -f "${TEST_DIR}/audit.log" ]
  grep -q "watchdog.ts" "${TEST_DIR}/audit.log"
  grep -q "operator intervention test" "${TEST_DIR}/audit.log"
}

@test "C2.7: clear tool with = in reason value works" {
  run env TRACKER_DIR="${TEST_DIR}" bash "$CLEAR_TOOL" heartbeat-daemon.sh '--reason=OOM killed, restarting'

  [ "$status" -eq 0 ]
}
