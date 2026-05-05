#!/usr/bin/env bash
# Sprint 5: soak monitoring tests
# RED until scripts/heartbeat-v2-flag.sh + scripts/heartbeat-v2-monitor.sh exist.
#
# Usage: bash tests/soak/soak-monitoring.test.sh
# Verifier checks git log: this file must predate the scripts.

set -uo pipefail

PASS=0; FAIL=0
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
FLAG_SCRIPT="$REPO/scripts/heartbeat-v2-flag.sh"
MONITOR_SCRIPT="$REPO/scripts/heartbeat-v2-monitor.sh"
TASKS_DB_DEFAULT="$HOME/.claude/mcp-servers/task-board/tasks.db"

# ─── helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL: $1  [$2]"; FAIL=$(( FAIL + 1 )); }

assert_eq() {
  local desc="$1" expected="$2" actual="${3:-}"
  [[ "$actual" == "$expected" ]] && pass "$desc" || fail "$desc" "expected='$expected' got='$actual'"
}

# ─── fixtures ─────────────────────────────────────────────────────────────────

TEST_TASKS_DB=$(mktemp /tmp/soak-tasks-XXXXXX.db)
TEST_V1_DB=$(mktemp /tmp/soak-v1-XXXXXX.db)
TEST_V2_DB=$(mktemp /tmp/soak-v2-XXXXXX.db)

cleanup() {
  rm -f "$TEST_TASKS_DB" "$TEST_V1_DB" "$TEST_V2_DB" \
        "${TEST_TASKS_DB}-shm" "${TEST_TASKS_DB}-wal" \
        "${TEST_V1_DB}-shm"    "${TEST_V1_DB}-wal" \
        "${TEST_V2_DB}-shm"    "${TEST_V2_DB}-wal"
}
trap cleanup EXIT

# Bootstrap feature_flags table in test tasks DB
sqlite3 "$TEST_TASKS_DB" <<'SQL'
CREATE TABLE feature_flags (
  flag_name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO feature_flags (flag_name, enabled) VALUES ('heartbeat_v2_enabled', 0);
SQL

# Bootstrap heartbeat DBs (same schema as daemons)
sqlite3 "$TEST_V1_DB" <<'SQL'
CREATE TABLE heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  consecutive_stuck INTEGER DEFAULT 0
);
SQL

sqlite3 "$TEST_V2_DB" <<'SQL'
CREATE TABLE heartbeats_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  agent TEXT NOT NULL,
  declared_state TEXT,
  declared_source TEXT,
  state_age_sec INTEGER,
  external_status TEXT NOT NULL,
  classification_method TEXT,
  reason TEXT,
  consecutive_stuck INTEGER DEFAULT 0
);
SQL

# ─── staged soak data ─────────────────────────────────────────────────────────
# Scenario A: boss — ALIVE at T-5min, then STUCK at T
#   V1 fires STUCK despite recent ALIVE → false positive in v1
#   V2 trusted declared state → ALIVE at T → no false positive in v2
# Scenario B: steve — STUCK at T-5min, then STUCK at T
#   Both v1 and v2 fire sustained STUCK → true positives (not false positive)
# Expected: v1_fp=1, v2_fp=0

T_MINUS_5="$(python3 -c "
from datetime import datetime,timezone,timedelta
print((datetime.now(timezone.utc)-timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")"
T_NOW="$(python3 -c "
from datetime import datetime,timezone
print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
")"

# V1 data
sqlite3 "$TEST_V1_DB" <<SQL
INSERT INTO heartbeats (timestamp, agent, status, reason) VALUES
  ('$T_MINUS_5', 'boss',  'ALIVE',  'working normally'),
  ('$T_NOW',     'boss',  'STUCK',  'pane output stale'),
  ('$T_MINUS_5', 'steve', 'STUCK',  'stuck first check'),
  ('$T_NOW',     'steve', 'STUCK',  'still stuck');
SQL

# V2 data: boss is ALIVE at T (v2 correctly trusted declared state)
sqlite3 "$TEST_V2_DB" <<SQL
INSERT INTO heartbeats_v2 (timestamp, agent, external_status, classification_method, reason, declared_state, declared_source) VALUES
  ('$T_MINUS_5', 'boss',  'ALIVE', 'deterministic-fresh', 'fresh declared state', 'ACTIVE_THINKING', 'mcp'),
  ('$T_NOW',     'boss',  'ALIVE', 'deterministic-fresh', 'fresh declared state', 'ACTIVE_THINKING', 'mcp'),
  ('$T_MINUS_5', 'steve', 'STUCK', 'deterministic-hung-tool', 'hung tool', 'TOOL_IN_FLIGHT', 'hook'),
  ('$T_NOW',     'steve', 'STUCK', 'deterministic-hung-tool', 'still hung', 'TOOL_IN_FLIGHT', 'hook');
SQL

# ─── check scripts exist (RED if missing) ─────────────────────────────────────

missing=0
[[ ! -f "$FLAG_SCRIPT" ]]    && missing=1
[[ ! -f "$MONITOR_SCRIPT" ]] && missing=1

if (( missing )); then
  echo "SKIP: scripts not yet implemented (RED)"
  [[ ! -f "$FLAG_SCRIPT" ]]    && echo "  Missing: $FLAG_SCRIPT"
  [[ ! -f "$MONITOR_SCRIPT" ]] && echo "  Missing: $MONITOR_SCRIPT"
  fail "feature-flag enable sets flag=1"      "script missing"
  fail "feature-flag disable sets flag=0"     "script missing"
  fail "v1 false-positive count = 1"          "script missing"
  fail "v2 false-positive count = 0"          "script missing"
  fail "v2 fp rate <= 50% of v1 fp rate"      "script missing"
  echo ""
  echo "Results: $PASS pass / $FAIL fail"
  exit 1
fi

# ─── test 1 & 2: feature flag toggle ─────────────────────────────────────────

echo "Test 1: feature flag enable"
bash "$FLAG_SCRIPT" enable "$TEST_TASKS_DB" > /dev/null 2>&1
flag_val=$(sqlite3 "$TEST_TASKS_DB" "SELECT enabled FROM feature_flags WHERE flag_name='heartbeat_v2_enabled';")
assert_eq "flag=1 after enable"  "1" "$flag_val"

echo "Test 2: feature flag disable"
bash "$FLAG_SCRIPT" disable "$TEST_TASKS_DB" > /dev/null 2>&1
flag_val=$(sqlite3 "$TEST_TASKS_DB" "SELECT enabled FROM feature_flags WHERE flag_name='heartbeat_v2_enabled';")
assert_eq "flag=0 after disable" "0" "$flag_val"

# ─── test 3–5: monitoring query on staged data ────────────────────────────────

echo "Test 3-5: monitoring query on staged data"
monitor_out=$(bash "$MONITOR_SCRIPT" "$TEST_V1_DB" "$TEST_V2_DB" 2>/dev/null)

# Monitor script must output two lines: v1_fp=N and v2_fp=N
v1_fp=$(printf '%s' "$monitor_out" | grep '^v1_fp=' | cut -d= -f2 | tr -d '[:space:]')
v2_fp=$(printf '%s' "$monitor_out" | grep '^v2_fp=' | cut -d= -f2 | tr -d '[:space:]')

assert_eq "v1 false-positive count = 1" "1" "$v1_fp"
assert_eq "v2 false-positive count = 0" "0" "$v2_fp"

# v2 fp rate <= 50% of v1's: v2_fp / v1_fp <= 0.5 (0 <= 50% of 1)
if [[ -n "$v1_fp" && -n "$v2_fp" ]] && (( v1_fp > 0 )); then
  if (( v2_fp * 2 <= v1_fp )); then
    pass "v2 fp rate <= 50% of v1 fp rate"
  else
    fail "v2 fp rate <= 50% of v1 fp rate" "v2_fp=$v2_fp v1_fp=$v1_fp"
  fi
elif [[ "$v2_fp" == "0" && "$v1_fp" == "0" ]]; then
  fail "v2 fp rate <= 50% of v1 fp rate" "both zero — staged data not producing v1 false positives"
else
  pass "v2 fp rate <= 50% of v1 fp rate"
fi

# ─── summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS pass / $FAIL fail"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
