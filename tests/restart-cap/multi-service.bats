#!/usr/bin/env bats
# C2.11 — Three services hit cap simultaneously → three separate Telegram alerts and task-board notes

bats_require_minimum_version 1.5.0

setup() {
  TEST_DIR=$(mktemp -d)
  NOW=$(date +%s)
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "C2.11: three services capped simultaneously → sentinel processes all three" {
  # Create 3 capped tracker files
  for svc in "watchdog.ts" "heartbeat-daemon.sh" "subagent-stall-watcher.sh"; do
    python3 -c "
import json
now = $NOW
data = {
  'service': '$svc',
  'restart_timestamps_unix': [now - 50, now - 40, now - 30, now - 20, now - 10, now],
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'self-terminated-cap',
  'last_action_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
with open('${TEST_DIR}/$svc.json', 'w') as f:
    json.dump(data, f)
"
  done

  # Run sentinel once
  run bash -c "TRACKER_DIR='${TEST_DIR}' bash '${HOME}/bin/restart-intensity-sentinel.sh' --check-once 2>&1"

  [ "$status" -eq 0 ]

  # Should have 3 ALERT lines in stderr
  local alert_count
  alert_count=$(printf '%s\n' "$output" | grep -c '\[restart-intensity-cap\] ALERT:' || true)
  [ "$alert_count" -eq 3 ]
}

@test "C2.11: all three tracker files updated to sentinel-unloaded" {
  for svc in "watchdog.ts" "heartbeat-daemon.sh" "subagent-stall-watcher.sh"; do
    python3 -c "
import json
now = $NOW
data = {
  'service': '$svc',
  'restart_timestamps_unix': [now - 50, now - 40, now - 30, now - 20, now - 10, now],
  'max_r': 5,
  'max_t_sec': 60,
  'last_action': 'self-terminated-cap',
  'last_action_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
with open('${TEST_DIR}/$svc.json', 'w') as f:
    json.dump(data, f)
"
  done

  TRACKER_DIR="${TEST_DIR}" bash "${HOME}/bin/restart-intensity-sentinel.sh" --check-once 2>&1 || true

  run python3 -c "
import json, os

tracker_dir = '${TEST_DIR}'
services = ['watchdog.ts', 'heartbeat-daemon.sh', 'subagent-stall-watcher.sh']
all_ok = True

for svc in services:
    fpath = os.path.join(tracker_dir, svc + '.json')
    with open(fpath) as f:
        d = json.load(f)
    if d['last_action'] != 'sentinel-unloaded':
        print(f'FAIL: {svc} last_action={d[\"last_action\"]}')
        all_ok = False
    else:
        print(f'OK: {svc} sentinel-unloaded')

if all_ok:
    print('ALL 3 services marked sentinel-unloaded')
else:
    exit(1)
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ALL 3 services"* ]]
}
