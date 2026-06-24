#!/usr/bin/env bats
# C2.5 — Concurrent startup race: only one acquires flock; other waits or fails cleanly

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

@test "C2.5: concurrent startups via flock — tracker file remains valid JSON" {
  local svc="watchdog.ts"
  local now="$NOW"

  # Run 3 concurrent startups
  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=10 \
    --max-t-sec=60 &
  local pid1=$!

  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$((now + 1))" \
    --max-r=10 \
    --max-t-sec=60 &
  local pid2=$!

  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$((now + 2))" \
    --max-r=10 \
    --max-t-sec=60 &
  local pid3=$!

  wait $pid1 $pid2 $pid3 || true

  # The tracker file should still be valid JSON (no corruption)
  run python3 -c "
import json
with open('${TEST_DIR}/$svc.json') as f:
    d = json.load(f)
assert 'service' in d
assert 'restart_timestamps_unix' in d
print('OK: tracker is valid JSON with', len(d['restart_timestamps_unix']), 'timestamps')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}

@test "C2.5: single startup succeeds even with empty tracker dir" {
  local svc="heartbeat-daemon.sh"
  local now="$NOW"

  run "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}
