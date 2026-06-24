#!/usr/bin/env bats
# C2.9 — Direct child of watchdog.ts crashes 6x in 60s → watchdog.ts stops respawning; emits alert

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

@test "C2.9: ChildRestartCap stops respawning after max_r exceeded" {
  run "$BUN" -e "
import { ChildRestartCap } from '${TASK_BOARD_DIR}/src/restart-cap/tracker'

const cap = new ChildRestartCap(5, 60)
const now = Math.floor(Date.now() / 1000)
const childId = 'some-worker-process'

const alerts = []
const alertCb = (id, count) => { alerts.push({ id, count }) }

// 6 restarts within 60s
const results = []
for (let i = 0; i < 6; i++) {
  const r = cap.onChildRestart(childId, now + i * 5, alertCb)
  results.push({ capped: r.capped, count: r.count })
}

// First 5 should not be capped (counts 1-5, all <= max_r=5)
for (let i = 0; i < 5; i++) {
  if (results[i].capped) {
    process.stderr.write('FAIL: restart ' + i + ' should not be capped\n')
    process.exit(1)
  }
}

// 6th should be capped
if (!results[5].capped) {
  process.stderr.write('FAIL: 6th restart should be capped\n')
  process.exit(1)
}

// Alert should have fired
if (alerts.length !== 1) {
  process.stderr.write('FAIL: expected 1 alert, got ' + alerts.length + '\n')
  process.exit(1)
}

// After cap, isCapped returns true
if (!cap.isCapped(childId)) {
  process.stderr.write('FAIL: isCapped should be true after cap\n')
  process.exit(1)
}

console.log('OK: child cap works correctly')
process.exit(0)
"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}

@test "C2.9: ChildRestartCap does not trip when restarts are spread out" {
  run "$BUN" -e "
import { ChildRestartCap } from '${TASK_BOARD_DIR}/src/restart-cap/tracker'

const cap = new ChildRestartCap(5, 60)
const now = Math.floor(Date.now() / 1000)
const childId = 'worker'

// 4 restarts, then 70s gap, then 1 more
for (let i = 0; i < 4; i++) {
  cap.onChildRestart(childId, now + i * 10)
}

// After 70s gap, previous restarts should be out of window
const r = cap.onChildRestart(childId, now + 70 + 200)
if (r.capped) {
  process.stderr.write('FAIL: should not trip after window expiry\n')
  process.exit(1)
}

console.log('OK: no spurious cap after window expiry')
process.exit(0)
"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}
