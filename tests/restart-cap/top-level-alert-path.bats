#!/usr/bin/env bats
# C2.10 — watchdog.ts capped + sentinel-unloaded → sentinel issues alerts via heartbeat-daemon path

bats_require_minimum_version 1.5.0

setup() {
  TEST_DIR=$(mktemp -d)
  NOW=$(date +%s)
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "C2.10: sentinel emits alert when watchdog.ts is self-terminated-cap" {
  # Simulate watchdog.ts being capped (self-terminated-cap)
  python3 -c "
import json
now = $NOW
data = {
  'service': 'watchdog.ts',
  'restart_timestamps_unix': [now - 50, now - 40, now - 30, now - 20, now - 10, now],
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'self-terminated-cap',
  'last_action_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
with open('${TEST_DIR}/watchdog.ts.json', 'w') as f:
    json.dump(data, f)
"

  # Sentinel should detect and emit an alert (to stderr at minimum)
  run bash -c "TRACKER_DIR='${TEST_DIR}' bash '${HOME}/bin/restart-intensity-sentinel.sh' --check-once 2>&1"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ALERT"* ]] || [[ "$output" == *"restart-intensity"* ]]
  [[ "$output" == *"watchdog.ts"* ]]
}

@test "C2.10: sentinel marks watchdog.ts as sentinel-unloaded" {
  python3 -c "
import json
now = $NOW
data = {
  'service': 'watchdog.ts',
  'restart_timestamps_unix': [now - 50, now - 40, now - 30, now - 20, now - 10, now],
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'self-terminated-cap',
  'last_action_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
with open('${TEST_DIR}/watchdog.ts.json', 'w') as f:
    json.dump(data, f)
"

  TRACKER_DIR="${TEST_DIR}" bash "${HOME}/bin/restart-intensity-sentinel.sh" --check-once 2>&1 || true

  run python3 -c "
import json
with open('${TEST_DIR}/watchdog.ts.json') as f:
    d = json.load(f)
assert d['last_action'] == 'sentinel-unloaded', f'got: {d[\"last_action\"]}'
print('OK: watchdog.ts marked sentinel-unloaded')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"sentinel-unloaded"* ]]
}
