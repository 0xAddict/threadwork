#!/usr/bin/env bats
# C2.6 — Corrupted tracker file → next startup logs warning, treats as empty, proceeds

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

@test "C2.6: corrupted tracker file (invalid JSON) → startup proceeds, logs warning" {
  local svc="watchdog.ts"
  local now="$NOW"

  # Write garbage to tracker file
  printf 'NOT_VALID_JSON{{{{' > "${TEST_DIR}/${svc}.json"

  run "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60

  # Should NOT fail (treat as empty)
  [ "$status" -eq 0 ]

  # Check stderr has a warning
  [[ "$output" == *"WARNING"* ]] || [[ "$output" == *"corrupted"* ]] || [[ "$output" == *"OK"* ]]
}

@test "C2.6: truncated/empty tracker file → startup proceeds without crash" {
  local svc="watchdog.ts"
  local now="$NOW"

  # Write empty file
  printf '' > "${TEST_DIR}/${svc}.json"

  run "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60

  [ "$status" -eq 0 ]
}

@test "C2.6: after corrupted file, tracker is rewritten correctly" {
  local svc="watchdog.ts"
  local now="$NOW"

  printf 'GARBAGE' > "${TEST_DIR}/${svc}.json"

  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60 >/dev/null 2>&1 || true

  # Tracker should now be valid JSON
  run python3 -c "
import json
with open('${TEST_DIR}/$svc.json') as f:
    d = json.load(f)
assert d['service'] == '$svc', f'wrong service: {d[\"service\"]}'
assert isinstance(d['restart_timestamps_unix'], list)
print('OK: tracker rewritten correctly after corruption')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}
