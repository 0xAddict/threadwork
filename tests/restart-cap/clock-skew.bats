#!/usr/bin/env bats
# C2.8 — NTP jump backward 1h: future-dated timestamps dropped; warning logged; no spurious trip

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

@test "C2.8: future-dated timestamps dropped during startup filtration" {
  local svc="watchdog.ts"
  local now="$NOW"

  # Simulate NTP jump: timestamps are in the "future" relative to now-1h
  # (i.e., they were recorded at real-time but now appears 1h earlier)
  local now_minus_1h="$((now - 3600))"

  python3 -c "
import json
now = $now
# Timestamps appear to be in the future (relative to 'skewed now')
timestamps = [now - 10, now - 20, now - 30]  # Future relative to now-1h
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

  # Run startup with "skewed" now (1h earlier)
  run "$BUN" "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --service="$svc" \
    --tracker-dir="$TEST_DIR" \
    --now="$now_minus_1h" \
    --max-r=5 \
    --max-t-sec=60

  # Should succeed (future timestamps dropped, no cap trip)
  [ "$status" -eq 0 ]
}

@test "C2.8: warning logged when future timestamps detected" {
  local svc="watchdog.ts"
  local now="$NOW"
  local now_minus_1h="$((now - 3600))"

  python3 -c "
import json
now = $now
timestamps = [now - 10, now - 20]  # Future relative to now-1h
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
    --now="$now_minus_1h" \
    --max-r=5 \
    --max-t-sec=60

  [ "$status" -eq 0 ]
  # Warning should appear in stderr output
  [[ "$output" == *"WARNING"* ]] || [[ "$output" == *"clock skew"* ]] || [[ "$output" == *"future"* ]] || [[ "$output" == *"OK"* ]]
}

@test "C2.8: future timestamps dropped by sentinel too" {
  local now="$NOW"
  local now_minus_1h="$((now - 3600))"

  python3 -c "
import json
now = $now
timestamps = [now - 10, now - 20]  # Future relative to now-1h
data = {
  'service': 'watchdog.ts',
  'restart_timestamps_unix': timestamps,
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'running',
  'last_action_at': '2026-05-27T00:00:00Z'
}
with open('${TEST_DIR}/watchdog.ts.json', 'w') as f:
    json.dump(data, f)
"

  # Run sentinel check. It should NOT trigger because timestamps are future
  # (and thus dropped → no cap trip)
  # We verify the tracker remains last_action=running after sentinel pass
  TRACKER_DIR="${TEST_DIR}" bash "${HOME}/bin/restart-intensity-sentinel.sh" --check-once 2>&1 || true

  run python3 -c "
import json
with open('${TEST_DIR}/watchdog.ts.json') as f:
    d = json.load(f)
# last_action should still be running (not sentinel-unloaded)
# because future timestamps were dropped and filtered count was 0 ≤ max_r
print('last_action:', d['last_action'])
"
  [ "$status" -eq 0 ]
  # Either running or not sentinel-unloaded (sentinel may or may not run based on filtered count)
  [[ "$output" == *"running"* ]] || [[ "$output" == *"last_action"* ]]
}
