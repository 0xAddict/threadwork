#!/bin/bash
# scope-drift-advisor.test.sh — description-vs-notes drift advisory (#13014 item 12)
# Crafted-stdin matrix against the real binary. Throwaway sqlite DB via
# SCOPE_DRIFT_DB + throwaway state dir via SCOPE_DRIFT_STATE_DIR (both
# test-only overrides), so nothing touches live state.
set -u

HOOK="$HOME/.claude/hooks/scope-drift-advisor.sh"
TMP=$(mktemp -d /tmp/sda-test.XXXXXX)
DB="$TMP/tasks.db"
SD="$TMP/state"
export SCOPE_DRIFT_DB="$DB"
export SCOPE_DRIFT_STATE_DIR="$SD"
export SCOPE_DRIFT_HOOK_ENABLED=1   # bypass agents.enabled gate for the matrix
mkdir -p "$SD"

sqlite3 "$DB" <<'SQL'
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, description TEXT, status TEXT,
  from_agent TEXT, to_agent TEXT, is_synthetic INTEGER DEFAULT 0,
  priority TEXT, parent_task_id INTEGER,
  created_at TEXT, claimed_at TEXT, last_heartbeat_at TEXT, last_progress_at TEXT
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER,
  from_agent TEXT, message TEXT, created_at TEXT
);
-- #501: short desc (~40 chars), few short notes -> below both thresholds
INSERT INTO tasks (id, description, status, from_agent, to_agent)
  VALUES (501, 'short scoped card for the quiet case', 'pending', 'gwei', 'steve');
INSERT INTO notes (task_id, from_agent, message, created_at)
  VALUES (501, 'steve', 'small note one', datetime('now')),
         (501, 'steve', 'small note two', datetime('now'));
-- #502: count trigger — 12 notes (>= default 12), all tiny
INSERT INTO tasks (id, description, status, from_agent, to_agent)
  VALUES (502, 'card that accumulates many notes', 'in_progress', 'gwei', 'steve');
-- #503: length trigger — 2 notes but cumulative length >= 4 x max(desc,200)=800
INSERT INTO tasks (id, description, status, from_agent, to_agent)
  VALUES (503, 'tiny desc', 'pending', 'gwei', 'sadie');
-- #504: terminal card with huge notes -> silent (archives, item 8c spirit)
INSERT INTO tasks (id, description, status, from_agent, to_agent)
  VALUES (504, 'finished card', 'done', 'gwei', 'steve');
-- #505: synthetic -> silent
INSERT INTO tasks (id, description, status, from_agent, to_agent, is_synthetic)
  VALUES (505, 'synthetic card', 'pending', 'watchdog', 'steve', 1);
SQL
# 12 tiny notes on #502
i=0; while [ $i -lt 12 ]; do
  sqlite3 "$DB" "INSERT INTO notes (task_id, from_agent, message, created_at) VALUES (502,'steve','n$i',datetime('now'));"
  i=$((i+1))
done
# 2 long notes (450 chars each = 900 >= 800) on #503 and #504
LONG=$(printf 'x%.0s' $(seq 1 450))
sqlite3 "$DB" "INSERT INTO notes (task_id, from_agent, message, created_at) VALUES
  (503,'sadie','$LONG',datetime('now')), (503,'sadie','$LONG',datetime('now')),
  (504,'steve','$LONG',datetime('now')), (504,'steve','$LONG',datetime('now')),
  (505,'steve','$LONG',datetime('now')), (505,'steve','$LONG',datetime('now'));"

PASS=0; FAIL=0

mkjson() {
  # $1=tool $2=task_id
  printf '{"tool_name": "%s", "tool_input": {"task_id": %s, "message": "m"}}' "$1" "$2"
}

run_hook() {
  # $1=mode $2=json $3=agent (extra env via pre-set exports)
  ERR=$(printf '%s' "$2" | AGENT_LABEL="${3:-steve}" /bin/bash "$HOOK" "$1" 2>&1 >/dev/null)
  RC=$?
}

check() {
  local ok=1
  [ "$2" != "$3" ] && ok=0
  if [ -n "${4:-}" ]; then
    case "$ERR" in *"$4"*) ;; *) ok=0 ;; esac
  fi
  if [ "$ok" = "1" ]; then PASS=$((PASS+1)); echo "PASS  $1"
  else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected rc=$2 got rc=$3; want '${4:-}'; stderr: $(echo "$ERR" | head -3 | tr '\n' ' '))"
  fi
}

# S0: syntax (bash 3.2 + env bash)
/bin/bash -n "$HOOK"; check "S0a bash3.2 -n syntax" 0 $?
bash -n "$HOOK"; check "S0b env-bash -n syntax" 0 $?
if grep -nE '\$\{[a-zA-Z_]+\[[@*]\]\}|[a-zA-Z_]+\+=\(' "$HOOK" >/dev/null; then
  FAIL=$((FAIL+1)); echo "FAIL  S0c array expansion found (bash3.2/set-u hazard)"
else
  PASS=$((PASS+1)); echo "PASS  S0c no array expansions"
fi

# S1: below both thresholds -> silent
run_hook post "$(mkjson mcp__task-board__send_note 501)" steve
check "S1 below thresholds silent" 0 $RC

# S2: count threshold (12 notes) -> advisory exit 2 with suggestion text
run_hook post "$(mkjson mcp__task-board__send_note 502)" steve
check "S2 count trigger fires advisory" 2 $RC "scope drift on #502"
case "$ERR" in *"consider splitting into a proper card"*) PASS=$((PASS+1)); echo "PASS  S2b advisory suggests splitting";; *) FAIL=$((FAIL+1)); echo "FAIL  S2b missing split suggestion";; esac

# S3: rate limit — immediate second call on same card is silent
run_hook post "$(mkjson mcp__task-board__send_note 502)" steve
check "S3 once-per-card-per-day dedup" 0 $RC

# S3b: expired cooldown re-fires (stamp aged via override)
echo 1000 > "$SD/fired-502.stamp"
run_hook post "$(mkjson mcp__task-board__send_note 502)" steve
check "S3b expired cooldown re-fires" 2 $RC "scope drift on #502"
rm -f "$SD/fired-502.stamp"

# S4: length threshold (900 chars vs 4x200 floor) -> advisory
run_hook post "$(mkjson mcp__task-board__send_note 503)" sadie
check "S4 length trigger fires advisory" 2 $RC "scope drift on #503"

# S5: terminal card with same note volume -> silent
run_hook post "$(mkjson mcp__task-board__send_note 504)" steve
check "S5 terminal 'done' card silent" 0 $RC

# S6: synthetic/watchdog card -> silent
run_hook post "$(mkjson mcp__task-board__send_note 505)" steve
check "S6 synthetic card silent" 0 $RC

# S7: non-send_note tool -> silent even on a hot card
rm -f "$SD/fired-502.stamp"
run_hook post "$(mkjson mcp__task-board__claim_task 502)" steve
check "S7 non-send_note tool silent" 0 $RC

# S8: kill-switch + bypass -> silent (and logged)
SCOPE_DRIFT_HOOK_DISABLED=1 ERR=$(printf '%s' "$(mkjson mcp__task-board__send_note 502)" | AGENT_LABEL=steve SCOPE_DRIFT_HOOK_DISABLED=1 /bin/bash "$HOOK" post 2>&1 >/dev/null); RC=$?
check "S8a kill-switch silent" 0 $RC
[ -s "$SD/disabled.log" ] && { PASS=$((PASS+1)); echo "PASS  S8b disable logged"; } || { FAIL=$((FAIL+1)); echo "FAIL  S8b disable not logged"; }
ERR=$(printf '%s' "$(mkjson mcp__task-board__send_note 502)" | AGENT_LABEL=steve SCOPE_DRIFT_BYPASS=1 /bin/bash "$HOOK" post 2>&1 >/dev/null); RC=$?
check "S8c bypass silent" 0 $RC
[ -s "$SD/bypass.log" ] && { PASS=$((PASS+1)); echo "PASS  S8d bypass logged"; } || { FAIL=$((FAIL+1)); echo "FAIL  S8d bypass not logged"; }

# S9: invalid task_id / garbage stdin / missing row -> fail-open silent
run_hook post '{"tool_name": "mcp__task-board__send_note", "tool_input": {"task_id": "abc"}}' steve
check "S9a invalid task_id silent" 0 $RC
ERR=$(printf 'not json at all' | AGENT_LABEL=steve /bin/bash "$HOOK" post 2>&1 >/dev/null); RC=$?
check "S9b garbage stdin silent" 0 $RC
run_hook post "$(mkjson mcp__task-board__send_note 999999)" steve
check "S9c missing row silent" 0 $RC

# S10: agent gate — not enabled and no env flag -> silent even on hot card
ERR=$(printf '%s' "$(mkjson mcp__task-board__send_note 502)" | AGENT_LABEL=steve env -u SCOPE_DRIFT_HOOK_ENABLED SCOPE_DRIFT_DB="$DB" SCOPE_DRIFT_STATE_DIR="$SD" /bin/bash "$HOOK" post 2>&1 >/dev/null); RC=$?
check "S10 agent-gate (not enabled) silent" 0 $RC

# S11: minimal-env set-u smoke (no AGENT_LABEL at all)
ERR=$(printf '%s' "$(mkjson mcp__task-board__send_note 502)" | env -i HOME="$HOME" PATH="$PATH" SCOPE_DRIFT_DB="$DB" SCOPE_DRIFT_STATE_DIR="$SD" SCOPE_DRIFT_HOOK_ENABLED=1 /bin/bash "$HOOK" post 2>&1 >/dev/null); RC=$?
check "S11 minimal-env set-u smoke (no AGENT_LABEL)" 0 $RC

# S12: unknown mode -> silent
ERR=$(printf '%s' "$(mkjson mcp__task-board__send_note 502)" | AGENT_LABEL=steve /bin/bash "$HOOK" pre 2>&1 >/dev/null); RC=$?
check "S12 unknown mode (pre) fail-open" 0 $RC

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && rm -rf "$TMP"
[ "$FAIL" = "0" ]
