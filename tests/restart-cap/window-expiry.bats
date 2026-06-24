#!/usr/bin/env bats
# C2.4 — 4 restarts in 60s + idle 70s + 1 more restart → only most-recent in window; no cap trip

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

@test "C2.4: 4 restarts in 60s, idle 70s, 1 more → no cap trip" {
  local svc="watchdog.ts"
  local now="$NOW"

  # Simulate 4 restarts, all > 70s ago (outside the 60s window at t=now+70)
  python3 -c "
import json
now = $now
timestamps = [now - 130, now - 120, now - 110, now - 100]
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

  # 5th restart at t=now (after 70s idle, all old ones expired)
  run "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}

@test "C2.4: tracker shows only most-recent timestamp in window after expiry" {
  local svc="watchdog.ts"
  local now="$NOW"

  python3 -c "
import json
now = $now
# 4 timestamps all outside window (> 60s ago)
timestamps = [now - 130, now - 120, now - 110, now - 100]
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

  # Run startup (should succeed)
  "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now" \
    --max-r=5 \
    --max-t-sec=60 >/dev/null 2>&1 || true

  # Verify tracker: only the new timestamp ($now) should be in window
  run python3 -c "
import json
now = $now
with open('${TEST_DIR}/$svc.json') as f:
    d = json.load(f)
timestamps = d['restart_timestamps_unix']
# Filter to window
in_window = [t for t in timestamps if now - 60 <= t <= now]
print('in_window_count:', len(in_window))
print('total_count:', len(timestamps))
assert len(in_window) == 1, f'expected 1 in window, got {len(in_window)}'
print('OK')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}
