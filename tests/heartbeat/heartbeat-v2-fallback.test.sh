#!/usr/bin/env bash
# Sprint 2: heartbeat-daemon-v2.sh — boot-recovery OS-facts fallback test suite
# Covers AC#1-#5 of the Sprint 2 contract (task #1269).
#
# This file is RED against the pre-Sprint-2 daemon (no os_facts_alive helper,
# no last-task-progress signal, deterministic-hung check fires before OS facts)
# and GREEN against the Sprint-2 daemon.
#
# Usage: bash tests/heartbeat/heartbeat-v2-fallback.test.sh
#
# Sibling of heartbeat-v2.test.sh (which stays byte-stable for AC#6). The
# Verifier runs both files and requires green on both.
#
# Defects under test:
#   D1 — deterministic-hung check (stale TOOL_IN_FLIGHT / SUBAGENT_RUNNING)
#        must consult OS facts BEFORE emitting STUCK. A live claude_pid /
#        recent last_seen_at / recent task progress => ALIVE, not STUCK.
#   D2 — last-task-progress OS signal (tasks.last_progress_at, fallback
#        tasks.last_heartbeat_at; threshold TASK_PROGRESS_FRESH_SEC=900s).

set -uo pipefail

PASS=0; FAIL=0
DAEMON="/Users/coachstokes/bin/heartbeat-daemon-v2.sh"
AGENT="test"   # daemon checks tmux session "claude-test", DB row agent="test"

# ─── helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL: $1  [$2]"; FAIL=$(( FAIL + 1 )); }

assert_eq() {
  local desc="$1" expected="$2" actual="${3:-}"
  [[ "$actual" == "$expected" ]] && pass "$desc" || fail "$desc" "expected='$expected' got='$actual'"
}

assert_ne() {
  local desc="$1" notexpected="$2" actual="${3:-}"
  [[ "$actual" != "$notexpected" ]] && pass "$desc" || fail "$desc" "should NOT be '$notexpected'"
}

assert_contains() {
  local desc="$1" needle="$2" haystack="${3:-}"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$desc"
  else
    fail "$desc" "expected to contain '$needle' in: $(printf '%s' "$haystack" | head -c 200)"
  fi
}

# ─── fixtures ─────────────────────────────────────────────────────────────────

TEST_SESSIONS_DB=$(mktemp /tmp/hbv2fb-sessions-XXXXXX.db)
TEST_HB_DB=$(mktemp /tmp/hbv2fb-hb-XXXXXX.db)
TG_LOG=$(mktemp /tmp/hbv2fb-tg-XXXXXX.log)
LLM_LOG=$(mktemp /tmp/hbv2fb-llm-XXXXXX.log)
FAKE_TMUX=$(mktemp /tmp/hbv2fb-tmux-XXXXXX.sh)

cleanup() {
  rm -f "$TEST_SESSIONS_DB" "${TEST_SESSIONS_DB}-shm" "${TEST_SESSIONS_DB}-wal" \
        "$TEST_HB_DB"       "${TEST_HB_DB}-shm"       "${TEST_HB_DB}-wal" \
        "$TG_LOG" "$LLM_LOG" "$FAKE_TMUX"
}
trap cleanup EXIT

# Fake tmux: session exists (exit 0), capture-pane returns empty
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_TMUX"
chmod +x "$FAKE_TMUX"

# Schema mirrors production: agent_sessions + tasks (tasks needed for D2 signal)
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
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT,
  status TEXT,
  last_heartbeat_at TEXT,
  last_progress_at TEXT
);
SQL

ts_ago() {
  python3 -c "
from datetime import datetime,timezone,timedelta
print((datetime.now(timezone.utc)-timedelta(seconds=$1)).strftime('%Y-%m-%d %H:%M:%S'))
"
}

# set_agent agent state source state_age_sec [last_seen_age_sec] [pid] [current_task_id]
set_agent() {
  local ag="$1" state="$2" src="$3" state_age="$4"
  local seen_age="${5:-$4}"
  local pid="${6:-NULL}"
  local task_id="${7:-NULL}"
  local state_ts; state_ts=$(ts_ago "$state_age")
  local seen_ts;  seen_ts=$(ts_ago "$seen_age")
  sqlite3 "$TEST_SESSIONS_DB" "
    INSERT OR REPLACE INTO agent_sessions
      (agent, state, state_source, state_changed_at, last_seen_at, current_task_id, claude_pid)
    VALUES ('$ag','$state','$src','$state_ts','$seen_ts',$task_id,$pid);
  "
}

# set_agent_nostate agent last_seen_age_sec [pid] [current_task_id]
# Seeds a row whose `state` declaration is absent (NULL) — modelling an agent
# that has not wired the emit-state.sh hook — but whose OS-fact columns
# (last_seen_at / claude_pid) ARE populated. state_changed_at is left NULL so
# the daemon treats the declaration as maximally stale.
set_agent_nostate() {
  local ag="$1" seen_age="$2"
  local pid="${3:-NULL}"
  local task_id="${4:-NULL}"
  local seen_ts; seen_ts=$(ts_ago "$seen_age")
  sqlite3 "$TEST_SESSIONS_DB" "
    INSERT OR REPLACE INTO agent_sessions
      (agent, state, state_source, state_changed_at, last_seen_at, current_task_id, claude_pid)
    VALUES ('$ag',NULL,NULL,NULL,'$seen_ts',$task_id,$pid);
  "
}

# read the most recent heartbeat reason for the agent under test
last_reason() {
  sqlite3 "$TEST_HB_DB" \
    "SELECT COALESCE(reason,'') FROM heartbeats_v2 WHERE agent='$AGENT' ORDER BY id DESC LIMIT 1;" \
    2>/dev/null || echo ""
}

# set_task id progress_age_sec [heartbeat_age_sec]
# progress_age < 0  => last_progress_at left NULL (forces last_heartbeat_at fallback)
set_task() {
  local id="$1" prog_age="$2" hb_age="${3:-$2}"
  local prog_ts hb_ts
  if (( prog_age < 0 )); then prog_ts="NULL"; else prog_ts="'$(ts_ago "$prog_age")'"; fi
  if (( hb_age < 0 ));   then hb_ts="NULL";   else hb_ts="'$(ts_ago "$hb_age")'";     fi
  sqlite3 "$TEST_SESSIONS_DB" "
    INSERT OR REPLACE INTO tasks (id, description, status, last_heartbeat_at, last_progress_at)
    VALUES ($id,'fixture task','in_progress',$hb_ts,$prog_ts);
  "
}

# ─── source daemon (RED if missing) ──────────────────────────────────────────

if [[ ! -f "$DAEMON" ]]; then
  echo "SKIP: $DAEMON does not exist — all tests FAIL (RED)"
  fail "scenario-1 stale-hung-tool-live-PID"      "daemon missing"
  fail "scenario-2 stale-hung-tool-recent-seen"   "daemon missing"
  fail "scenario-3 stale-hung-tool-task-progress" "daemon missing"
  fail "scenario-4 genuine-hung-all-signals-dead" "daemon missing"
  fail "scenario-5 absent-declaration-live-PID"   "daemon missing"
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

# Stub: capture Telegram calls
send_telegram() { printf '%s\n' "$1" >> "$TG_LOG"; }

# Stub: capture LLM calls + return controlled response
LLM_STUB_RESPONSE="STUCK stub hung response"
classify_with_openrouter() {
  local ag="$1" enriched="$2" _key="$3"
  printf 'AGENT=%s\nINPUT=%s\n---\n' "$ag" "$enriched" >> "$LLM_LOG"
  echo "$LLM_STUB_RESPONSE"
}

init_db_v2

reset_hb_db() {
  rm -f "$TEST_HB_DB" "${TEST_HB_DB}-shm" "${TEST_HB_DB}-wal"
  init_db_v2
}

# Helper: read the classification_method of the most recent heartbeat row
last_method() {
  sqlite3 "$TEST_HB_DB" \
    "SELECT COALESCE(classification_method,'') FROM heartbeats_v2 WHERE agent='$AGENT' ORDER BY id DESC LIMIT 1;" \
    2>/dev/null || echo ""
}

# ─── AC#1 — stale hung-tool + live claude_pid → ALIVE, not STUCK (D1) ────────
# declared=TOOL_IN_FLIGHT, age 700s (> TOOL_IN_FLIGHT_HUNG_SEC=600), PID alive.
# Pre-Sprint-2: deterministic-hung check fires first → STUCK (the #843 bug).
# Sprint-2: os_facts_alive consulted first → ALIVE.

echo "Scenario 1: stale hung-tool + live claude_pid → ALIVE (D1 fix)"
reset_hb_db; > "$TG_LOG"
ALIVE_PID="$$"   # test script PID — guaranteed alive
set_agent "$AGENT" "TOOL_IN_FLIGHT" "hook" "700" "700" "$ALIVE_PID"

result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq "stale TOOL_IN_FLIGHT + live PID is ALIVE" "ALIVE" "$result"
assert_ne "not classified STUCK"                     "STUCK" "$result"
m1=$(last_method)
assert_contains "method names the hung-override path" "os-facts" "$m1"

# ─── AC#2 — stale hung-tool + recent last_seen_at → ALIVE (D1) ───────────────
# PID dead, but last_seen_at within LAST_SEEN_ALIVE_SEC=120s.

echo "Scenario 2: stale hung-tool + recent last_seen → ALIVE (D1 fix)"
reset_hb_db; > "$TG_LOG"
set_agent "$AGENT" "SUBAGENT_RUNNING" "hook" "3000" "30" "999999"  # PID dead, seen 30s ago

result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq "stale SUBAGENT_RUNNING + recent last_seen is ALIVE" "ALIVE" "$result"
assert_ne "not classified STUCK"                               "STUCK" "$result"

# ─── AC#3 — stale hung-tool + recent task progress → ALIVE (D2) ──────────────
# PID dead, last_seen stale, but the agent's current task shows recent progress.
# Sub-case 3a: tasks.last_progress_at is fresh.
# Sub-case 3b: tasks.last_progress_at is NULL → falls back to last_heartbeat_at.

echo "Scenario 3a: stale hung-tool + fresh tasks.last_progress_at → ALIVE (D2 fix)"
reset_hb_db; > "$TG_LOG"
set_agent "$AGENT" "TOOL_IN_FLIGHT" "hook" "5000" "5000" "999999" "4242"
set_task 4242 120 9000   # last_progress_at 120s ago (fresh), last_heartbeat stale
result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq "fresh last_progress_at resolves ALIVE" "ALIVE" "$result"
# The decision path is auditable via classification_method + reason: the
# hung-override method names the override, and the reason records exactly
# which OS signal fired — here the last-task-progress signal.
m3=$(last_method)
assert_contains "method names the OS-facts hung-override" "os-facts" "$m3"
r3=$(last_reason)
assert_contains "reason records the task-progress signal fired" "task_progress_alive=1" "$r3"

echo "Scenario 3b: last_progress_at NULL → fallback to last_heartbeat_at → ALIVE (D2 fix)"
reset_hb_db; > "$TG_LOG"
set_agent "$AGENT" "TOOL_IN_FLIGHT" "hook" "5000" "5000" "999999" "4343"
set_task 4343 -1 200   # last_progress_at NULL, last_heartbeat_at 200s ago (fresh)
result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq "fallback to last_heartbeat_at resolves ALIVE" "ALIVE" "$result"

# ─── AC#4 — genuine hung: ALL OS signals negative → STUCK preserved ──────────
# declared=TOOL_IN_FLIGHT stale, PID dead, last_seen stale, task progress stale.
# The fallback must NOT blanket-suppress real hangs.

echo "Scenario 4: genuine hung — all OS signals dead → STUCK"
reset_hb_db; > "$TG_LOG"
set_agent "$AGENT" "TOOL_IN_FLIGHT" "hook" "5000" "5000" "999999" "4444"
set_task 4444 9000 9000   # task progress 9000s ago — stale, > 900s threshold
result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq "genuine hang still classified STUCK" "STUCK" "$result"
tg4=$(cat "$TG_LOG")
assert_contains "STUCK alert has Declared: line" "Declared:" "$tg4"

# ─── AC#5 — absent declaration + live OS signal → not CRASHED/STUCK ──────────
# The agent's `state` declaration is absent (NULL) — modelling an agent that
# never wired the emit-state.sh PreToolUse hook — but the tmux session exists
# and an OS-fact column is live. The daemon must NOT classify CRASHED/STUCK
# purely from the missing declaration: it must resolve ALIVE via OS facts.
# (Genuine tmux-session-missing → CRASHED at the daemon's Step 1 is unchanged
#  and correct; this scenario keeps the session present.)
#
# Sub-case 5a: live claude_pid.   Sub-case 5b: recent last_seen_at.

echo "Scenario 5a: absent declaration + live claude_pid → ALIVE via OS facts"
reset_hb_db; > "$TG_LOG"
ALIVE_PID="$$"
set_agent_nostate "$AGENT" "9000" "$ALIVE_PID"   # state NULL, last_seen stale, PID alive
result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq "absent declaration + live PID resolves ALIVE" "ALIVE" "$result"
assert_ne "not CRASHED"                                  "CRASHED" "$result"
assert_ne "not STUCK"                                    "STUCK"   "$result"
m5=$(last_method)
assert_contains "resolved via OS facts, not the missing declaration" "os-facts" "$m5"

echo "Scenario 5b: absent declaration + recent last_seen_at → ALIVE via OS facts"
reset_hb_db; > "$TG_LOG"
set_agent_nostate "$AGENT" "30" "999999"   # state NULL, last_seen 30s ago, PID dead
result=$(classify_agent_v2 "$AGENT" "fake-api-key")
assert_eq "absent declaration + recent last_seen resolves ALIVE" "ALIVE" "$result"
assert_ne "not CRASHED"                                          "CRASHED" "$result"

# ─── summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS pass / $FAIL fail"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
