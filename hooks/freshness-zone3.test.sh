#!/bin/bash
# freshness-zone3.test.sh — ZONE-3 verdict-clearance fix (#1713-adjacent)
# Verifies: gate-aged (>2h) card claim WITH a recent FRESHNESS verdict passes;
# WITHOUT a verdict still hard-blocks; the verdict send_note itself always lands.
# Uses a throwaway sqlite DB via FRESHNESS_DB (test-only override). The hook's
# note-count cache lives in the REAL freshness state dir, so we use a unique
# high task id and clean its cache files up afterwards.
set -u

HOOK="$HOME/.claude/hooks/freshness-check.sh"
TMP=$(mktemp -d /tmp/fz3-test.XXXXXX)
DB="$TMP/tasks.db"
export FRESHNESS_DB="$DB"
TASK=990001
CACHE_DIR="$HOME/.claude/state/freshness-hook"

cleanup() { rm -f "$CACHE_DIR/task-$TASK-"*.cache; }
trap cleanup EXIT

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
CREATE TABLE task_status_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, detail TEXT);
CREATE TABLE memories (id INTEGER PRIMARY KEY, pinned INTEGER, category TEXT, content TEXT, importance INTEGER);
INSERT INTO tasks (id, description, status, from_agent, to_agent, is_synthetic, created_at, last_progress_at)
VALUES (990001, 'gate-queued dispatch test card zone3 clearance', 'pending', 'gwei', 'steve', 0,
        datetime('now','-5 hours'), datetime('now','-3 hours'));
SQL

PASS=0; FAIL=0

mkjson() {
  # $1=tool $2=task_id [$3=message]
  if [ -n "${3:-}" ]; then
    printf '{"tool_name": "%s", "tool_input": {"task_id": %s, "message": "%s"}}' "$1" "$2" "$3"
  else
    printf '{"tool_name": "%s", "tool_input": {"task_id": %s}}' "$1" "$2"
  fi
}

run_hook() {
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
  else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected rc=$2 got rc=$3; want '${4:-}'; stderr: $(echo "$ERR" | head -4 | tr '\n' ' '))"
  fi
}

# Z0: syntax still clean after edit
/bin/bash -n "$HOOK"; check "Z0a bash3.2 -n syntax" 0 $?
bash -n "$HOOK"; check "Z0b env-bash -n syntax" 0 $?

cleanup  # ensure no stale cache from prior runs

# Z1: gate-aged card (3h since activity), NO verdict -> ZONE-3 HARD BLOCK
run_hook prerevisit "$(mkjson mcp__task-board__claim_task $TASK)" steve
check "Z1 zone3 no-verdict still hard-blocks" 2 $RC "HARD BLOCK"
case "$ERR" in *"FRESHNESS verdict"*|*"FRESHNESS"*) PASS=$((PASS+1)); echo "PASS  Z1b block inject points at verdict path";; *) FAIL=$((FAIL+1)); echo "FAIL  Z1b inject missing verdict instructions";; esac

# Z2: the verdict send_note itself is NEVER gated (escape valve, #1617 fix a)
run_hook prerevisit "$(mkjson mcp__task-board__send_note $TASK 'FRESHNESS: STILL-FRESH gate-aged by design, dispatch proceeding')" steve
check "Z2 verdict note itself always lands" 0 $RC

# Simulate the note landing in the DB (as the MCP server would write it)
sqlite3 "$DB" "INSERT INTO notes (task_id, from_agent, message, created_at)
  VALUES ($TASK, 'steve', 'FRESHNESS: STILL-FRESH gate-aged by design, dispatch proceeding', datetime('now'));"
cleanup  # drop the 10s note-count cache written during Z1

# Z3: same gate-aged claim WITH verdict -> ALLOWED
run_hook prerevisit "$(mkjson mcp__task-board__claim_task $TASK)" steve
check "Z3 zone3 claim passes with verdict" 0 $RC

# Z4: complete_task also clears with the same verdict
cleanup
run_hook prerevisit "$(mkjson mcp__task-board__complete_task $TASK)" steve
check "Z4 zone3 complete_task passes with verdict" 0 $RC

# Z5: a DIFFERENT agent without its own verdict is still blocked
cleanup
run_hook prerevisit "$(mkjson mcp__task-board__claim_task $TASK)" sadie
check "Z5 zone3 other agent (no verdict) still blocked" 2 $RC "HARD BLOCK"

# Z6: stale verdict (>5 min old) does not clear
sqlite3 "$DB" "DELETE FROM notes; INSERT INTO notes (task_id, from_agent, message, created_at)
  VALUES ($TASK, 'steve', 'FRESHNESS: STILL-FRESH old verdict', datetime('now','-9 minutes'));"
cleanup
run_hook prerevisit "$(mkjson mcp__task-board__claim_task $TASK)" steve
check "Z6 zone3 stale (9min) verdict does not clear" 2 $RC "HARD BLOCK"

# ---------------------------------------------------------------------------
# T-series: terminal-card ZONE-3 exemption (#13014 item 8c).
# Terminal cards (completed/cancelled/done/complete) are archives — notes and
# other revisit ops must ALLOW outright with no verdict, at any age. An ACTIVE
# stale card must still hard-block (the gate's real purpose is untouched).
# ---------------------------------------------------------------------------
TTASK=990002
mkterm() {
  # $1 = task id, $2 = status — gate-aged terminal card, no notes
  sqlite3 "$DB" "DELETE FROM tasks WHERE id=$1;
    INSERT INTO tasks (id, description, status, from_agent, to_agent, is_synthetic, created_at, last_progress_at)
    VALUES ($1, 'terminal card exemption test', '$2', 'gwei', 'steve', 0,
            datetime('now','-30 hours'), datetime('now','-28 hours'));"
  rm -f "$CACHE_DIR/task-$1-"*.cache
}

for st in completed cancelled done complete; do
  mkterm $TTASK "$st"
  run_hook prerevisit "$(mkjson mcp__task-board__send_note $TTASK 'post-completion acceptance evidence note')" steve
  check "T1-$st terminal '$st' send_note allowed, no verdict, 28h stale" 0 $RC
done

# T2: complete_task on a 'done' card also exempt (revisit-class, not just notes)
mkterm $TTASK done
run_hook prerevisit "$(mkjson mcp__task-board__complete_task $TTASK)" steve
check "T2 terminal 'done' complete_task allowed" 0 $RC

# T3: other agent on terminal card also allowed (exemption is status-based)
mkterm $TTASK done
run_hook prerevisit "$(mkjson mcp__task-board__send_note $TTASK 'governance disposition appendix')" sadie
check "T3 terminal 'done' other agent allowed" 0 $RC

# T4 REGRESSION: ACTIVE statuses still hard-block at zone-3 (in_progress + pending)
for st in in_progress pending; do
  mkterm $TTASK "$st"
  run_hook prerevisit "$(mkjson mcp__task-board__send_note $TTASK 'ordinary note on stale active card')" steve
  check "T4-$st ACTIVE '$st' 28h-stale send_note still hard-blocks" 2 $RC "HARD BLOCK"
done
rm -f "$CACHE_DIR/task-$TTASK-"*.cache

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && rm -rf "$TMP"
[ "$FAIL" = "0" ]
