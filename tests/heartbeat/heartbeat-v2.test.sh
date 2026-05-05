#!/usr/bin/env bash
# Sprint 4: heartbeat-daemon-v2.sh — 5-scenario test suite
# RED until /Users/coachstokes/bin/heartbeat-daemon-v2.sh is implemented.
#
# Usage: bash tests/heartbeat/heartbeat-v2.test.sh
# Verifier runs this; checks git log to confirm this file predates the daemon.

set -uo pipefail

PASS=0; FAIL=0
DAEMON="/Users/coachstokes/bin/heartbeat-daemon-v2.sh"
AGENT="test"   # short name; daemon checks tmux session "claude-test", DB row agent="test"

# ─── helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL: $1  [$2]"; FAIL=$(( FAIL + 1 )); }

assert_eq() {
  local desc="$1" expected="$2" actual="${3:-}"
  [[ "$actual" == "$expected" ]] && pass "$desc" || fail "$desc" "expected='$expected' got='$actual'"
}

assert_contains() {
  local desc="$1" needle="$2" haystack="${3:-}"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$desc"
  else
    fail "$desc" "expected to contain '$needle' in: $(printf '%s' "$haystack" | head -c 200)"
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="${3:-}"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$desc"
  else
    fail "$desc" "should NOT contain '$needle'"
  fi
}

# ─── fixtures ─────────────────────────────────────────────────────────────────

TEST_SESSIONS_DB=$(mktemp /tmp/hbv2-sessions-XXXXXX.db)
TEST_HB_DB=$(mktemp /tmp/hbv2-hb-XXXXXX.db)
TG_LOG=$(mktemp /tmp/hbv2-tg-XXXXXX.log)
LLM_LOG=$(mktemp /tmp/hbv2-llm-XXXXXX.log)
FAKE_TMUX=$(mktemp /tmp/hbv2-tmux-XXXXXX.sh)

cleanup() {
  rm -f "$TEST_SESSIONS_DB" "${TEST_SESSIONS_DB}-shm" "${TEST_SESSIONS_DB}-wal" \
        "$TEST_HB_DB"       "${TEST_HB_DB}-shm"       "${TEST_HB_DB}-wal" \
        "$TG_LOG" "$LLM_LOG" "$FAKE_TMUX"
}
trap cleanup EXIT

# Fake tmux: always reports session exists (exit 0), capture-pane returns empty
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_TMUX"
chmod +x "$FAKE_TMUX"

# Minimal schema mirroring production agent_sessions
sqlite3 "$TEST_SESSIONS_DB" <<'SQL'
CREATE TABLE agent_sessions (
  agent TEXT PRIMARY KEY,
  state TEXT,
  state_source TEXT,
  state_changed_at TEXT,
  last_seen_at TEXT,
  current_task_id INTEGER,
  current_tool TEXT,
  claude_pid INTEGER
);
SQL

ts_ago() {
  python3 -c "
from datetime import datetime,timezone,timedelta
print((datetime.now(timezone.utc)-timedelta(seconds=$1)).strftime('%Y-%m-%d %H:%M:%S'))
"
}

# set_agent agent state source state_age_sec [last_seen_age_sec] [pid]
# last_seen_age defaults to state_age if omitted (common case)
set_agent() {
  local ag="$1" state="$2" src="$3" state_age="$4"
  local seen_age="${5:-$4}"
  local pid="${6:-NULL}"
  local state_ts; state_ts=$(ts_ago "$state_age")
  local seen_ts;  seen_ts=$(ts_ago "$seen_age")
  sqlite3 "$TEST_SESSIONS_DB" "
    INSERT OR REPLACE INTO agent_sessions
      (agent, state, state_source, state_changed_at, last_seen_at, claude_pid)
    VALUES ('$ag','$state','$src','$state_ts','$seen_ts',$pid);
  "
}

# ─── source daemon (RED if missing) ──────────────────────────────────────────

if [[ ! -f "$DAEMON" ]]; then
  echo "SKIP: $DAEMON does not exist — all 5 tests FAIL (RED; daemon not yet written)"
  fail "scenario-1 declared-fresh-ALIVE"            "daemon missing"
  fail "scenario-2 declared-fresh-TOOL-stuck-10min" "daemon missing"
  fail "scenario-3 declared-stale-PID-alive"        "daemon missing"
  fail "scenario-4 declared-stale-PID-dead"         "daemon missing"
  fail "scenario-5 ambiguous-Gemma"                 "daemon missing"
  echo ""
  echo "Results: $PASS pass / $FAIL fail"
  exit 1
fi

# shellcheck disable=SC1090
source "$DAEMON"

# Override runtime paths + stubs after sourcing
TASKS_DB_PATH="$TEST_SESSIONS_DB"
HEARTBEAT_DB_PATH="$TEST_HB_DB"
TMUX_BIN="$FAKE_TMUX"

# Stub: capture all Telegram calls to TG_LOG
send_telegram() { printf '%s\n' "$1" >> "$TG_LOG"; }

# Stub: capture LLM calls + return controlled response
LLM_STUB_RESPONSE="ALIVE stub response"
classify_with_openrouter() {
  local ag="$1" enriched="$2" _key="$3"
  printf 'AGENT=%s\nINPUT=%s\n---\n' "$ag" "$enriched" >> "$LLM_LOG"
  echo "$LLM_STUB_RESPONSE"
}

# Initialise the heartbeat-v2 DB tables
init_db_v2

# ─── scenario 1: declared-fresh-ALIVE ────────────────────────────────────────

echo "Scenario 1: declared-fresh-ALIVE"
> "$TG_LOG"
set_agent "$AGENT" "ACTIVE_THINKING" "mcp" "30"

result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq    "external status is ALIVE"           "ALIVE" "$result"
tg1=$(cat "$TG_LOG")
assert_not_contains "compact: no Declared: line"  "Declared:" "$tg1"
assert_not_contains "compact: no Source: line"    "Source:"   "$tg1"

# ─── scenario 2: declared-fresh-TOOL-stuck-10min ─────────────────────────────

echo "Scenario 2: declared-fresh-TOOL-stuck-10min"
> "$TG_LOG"
set_agent "$AGENT" "TOOL_IN_FLIGHT" "hook" "650"  # 650 > TOOL_IN_FLIGHT_HUNG_SEC=600

result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq    "external status is STUCK"           "STUCK" "$result"
tg2=$(cat "$TG_LOG")
assert_contains "STUCK alert has Declared: line"  "Declared:" "$tg2"
assert_contains "STUCK alert has Source: line"    "Source:"   "$tg2"

# ─── scenario 3: declared-stale-PID-alive ────────────────────────────────────
# state_changed_at stale (400s) but last_seen_at recent (60s) + PID alive

echo "Scenario 3: declared-stale-PID-alive"
> "$TG_LOG"
ALIVE_PID="$$"   # test script PID — guaranteed alive for duration of test
set_agent "$AGENT" "ACTIVE_THINKING" "mcp" "400" "60" "$ALIVE_PID"

result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq    "external status is ALIVE (OS facts resolve)"  "ALIVE" "$result"
tg3=$(cat "$TG_LOG")
assert_not_contains "compact: no Declared: line"  "Declared:" "$tg3"
assert_not_contains "compact: no Source: line"    "Source:"   "$tg3"

# ─── scenario 4: declared-stale-PID-dead → LLM fallback ─────────────────────

echo "Scenario 4: declared-stale-PID-dead"
> "$TG_LOG"; > "$LLM_LOG"
LLM_STUB_RESPONSE="ALIVE stub-alive response"
set_agent "$AGENT" "ACTIVE_THINKING" "hook" "400" "400" "999999"  # PID 999999 = dead

result=$(classify_agent_v2 "$AGENT" "fake-api-key")
llm4=$(cat "$LLM_LOG")
assert_contains "LLM called for stale+dead-PID agent"  "AGENT=$AGENT"  "$llm4"
assert_eq       "result matches LLM stub"               "ALIVE"         "$result"

# ─── scenario 5: ambiguous-Gemma (enriched prompt, STUCK result) ─────────────

echo "Scenario 5: ambiguous→Gemma"
> "$TG_LOG"; > "$LLM_LOG"
LLM_STUB_RESPONSE="STUCK hanging on API call"
set_agent "$AGENT" "UNKNOWN" "heartbeat" "400" "400" "NULL"

result=$(classify_agent_v2 "$AGENT" "fake-api-key")
llm5=$(cat "$LLM_LOG")
assert_contains "LLM called for UNKNOWN state"                   "AGENT=$AGENT"  "$llm5"
assert_contains "enriched LLM input includes declared state"     "UNKNOWN"       "$llm5"
assert_eq       "external status is STUCK (from LLM)"            "STUCK"         "$result"
tg5=$(cat "$TG_LOG")
assert_contains "STUCK alert has Declared: line"  "Declared:" "$tg5"
assert_contains "STUCK alert has Source: line"    "Source:"   "$tg5"

# ─── summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS pass / $FAIL fail"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
