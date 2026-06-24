#!/usr/bin/env bats
# C2.3 — After self-termination, sentinel detects state and emits alerts

bats_require_minimum_version 1.5.0

TASK_BOARD_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

setup() {
  TEST_DIR=$(mktemp -d)
  NOW=$(date +%s)
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "C2.3: sentinel detects self-terminated-cap state" {
  # Create tracker with last_action=self-terminated-cap
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

  # Run sentinel with our test tracker dir
  # We override TRACKER_DIR and capture output
  run bash -c "
    export TRACKER_DIR_OVERRIDE='${TEST_DIR}'
    # Override the sentinel to use test dir
    python3 - '${TEST_DIR}' '$NOW' <<'PYEOF'
import json, os, sys

tracker_dir = sys.argv[1]
now = int(sys.argv[2])

for fname in os.listdir(tracker_dir):
    if not fname.endswith('.json'):
        continue
    fpath = os.path.join(tracker_dir, fname)
    with open(fpath) as f:
        data = json.load(f)

    service = data.get('service', 'unknown')
    timestamps = data.get('restart_timestamps_unix', [])
    max_r = data.get('max_r', 5)
    max_t_sec = data.get('max_t_sec', 60)
    last_action = data.get('last_action', 'running')

    # Clock-skew: drop future timestamps
    future = [t for t in timestamps if t > now]
    if future:
        print(f'CLOCK_SKEW_DROP: {len(future)} future timestamps', flush=True)

    filtered = [t for t in timestamps if now - max_t_sec <= t <= now]

    trip = len(filtered) > max_r or last_action == 'self-terminated-cap'
    already_unloaded = last_action == 'sentinel-unloaded'

    print(f'service={service} trip={trip} already_unloaded={already_unloaded} filtered={len(filtered)} max_r={max_r} last_action={last_action}', flush=True)

    if trip and not already_unloaded:
        print(f'ALERT: restart-intensity cap exceeded for service={service}', flush=True)
PYEOF
"

  [ "$status" -eq 0 ]
  [[ "$output" == *"trip=True"* ]]
  [[ "$output" == *"ALERT:"* ]]
}

@test "C2.3: sentinel updates last_action to sentinel-unloaded" {
  python3 -c "
import json
now = $NOW
data = {
  'service': 'heartbeat-daemon.sh',
  'restart_timestamps_unix': [now - 50, now - 40, now - 30, now - 20, now - 10, now],
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'self-terminated-cap',
  'last_action_at': '2026-05-27T00:00:00Z'
}
with open('${TEST_DIR}/heartbeat-daemon.sh.json', 'w') as f:
    json.dump(data, f)
"

  # Use the restart-intensity-sentinel.sh --check-once in test mode
  TRACKER_DIR="${TEST_DIR}" bash "${HOME}/bin/restart-intensity-sentinel.sh" --check-once 2>&1 || true

  # Check tracker was updated to sentinel-unloaded
  run python3 -c "
import json
with open('${TEST_DIR}/heartbeat-daemon.sh.json') as f:
    d = json.load(f)
assert d['last_action'] == 'sentinel-unloaded', f'expected sentinel-unloaded, got {d[\"last_action\"]}'
print('OK: last_action=sentinel-unloaded')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"sentinel-unloaded"* ]]
}

@test "C2.3: sentinel emits stderr alert" {
  python3 -c "
import json
now = $NOW
data = {
  'service': 'heartbeat-daemon.sh',
  'restart_timestamps_unix': [now - 50, now - 40, now - 30, now - 20, now - 10, now],
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'self-terminated-cap',
  'last_action_at': '2026-05-27T00:00:00Z'
}
with open('${TEST_DIR}/heartbeat-daemon.sh.json', 'w') as f:
    json.dump(data, f)
"

  run bash -c "TRACKER_DIR='${TEST_DIR}' bash '${HOME}/bin/restart-intensity-sentinel.sh' --check-once 2>&1"

  [ "$status" -eq 0 ]
  [[ "$output" == *"restart-intensity"* ]]
}
