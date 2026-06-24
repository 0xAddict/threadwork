#!/usr/bin/env bash
# freshness-keyword-poison.test.sh
# TDD reproduction + regression for the Zone-1 "keyword poison" false-positive.
#
# Bug (task #1473/#1474, confirmed by snoopy on #850):
#   check_structural_keywords() scans the last-5 notes on a task with NO
#   author-scoping and NO time-scoping. Once ANY agent (often the watchdog or
#   an unrelated agent) drops a note containing a structural keyword
#   (BLOCKED / ESCALATION / DECISION / ...), that keyword stays in the
#   last-5-notes window and permanently BLOCKS every subsequent send_note from
#   every agent — even an agent who has already posted AFTER the keyword note
#   (i.e. has already "seen"/acknowledged it).
#
# Correct behavior:
#   The Zone-1 scan should only fire on a structural-change keyword that is
#   NEWER than the calling agent's own most-recent note on the task (a genuinely
#   new signal the agent has not yet acknowledged). Keywords in notes the agent
#   has already posted past must NOT block. First-encounter detection (agent has
#   never posted, or a keyword note arrives after the agent's last post) is
#   preserved.
#
# NOTE: the ticket's original hypothesis ("the task's own subject/description
# leaks into the scan") is a MISDIAGNOSIS — the description is never stored in
# the notes table, and check_structural_keywords only queries notes.message.
# These tests target the real mechanism.
#
# Runs entirely against a throwaway temp sqlite DB under a temp HOME. The real
# tasks.db is NEVER touched.

set -u
HOOK="$HOME/.claude/hooks/freshness-check.sh"
TMP=$(mktemp -d -t freshness-poison-XXXX)
DB="$TMP/.claude/mcp-servers/task-board/tasks.db"
mkdir -p "$(dirname "$DB")"
mkdir -p "$TMP/.claude/state/freshness-hook"

sqlite3 "$DB" <<'SQL'
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  description TEXT,
  status TEXT,
  from_agent TEXT,
  to_agent TEXT,
  is_synthetic INTEGER DEFAULT 0,
  priority TEXT,
  parent_task_id INTEGER,
  created_at TEXT,
  claimed_at TEXT,
  last_heartbeat_at TEXT,
  last_progress_at TEXT
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  task_id INTEGER,
  from_agent TEXT,
  message TEXT,
  created_at TEXT
);
CREATE TABLE task_status_events (id INTEGER PRIMARY KEY, task_id INTEGER, detail TEXT);
CREATE TABLE memories (id INTEGER PRIMARY KEY, category TEXT, content TEXT, pinned INTEGER, importance INTEGER);

-- ===========================================================================
-- T1 (FALSE-POSITIVE / the bug): Zone-1 task. An OLD note from the watchdog
-- contains "ESCALATION". The calling agent (sadie) has since posted a NEWER,
-- clean note. sadie now tries another send_note.
-- Buggy code: BLOCK (exit 2) because the ESCALATION keyword is still in the
--   last-5 window. Correct code: ALLOW (exit 0) — sadie already posted past it.
-- ===========================================================================
INSERT INTO tasks (id, description, status, from_agent, to_agent, created_at, last_progress_at)
  VALUES (2001, 'deploy decision follow-up', 'in_progress', 'boss', 'sadie',
          datetime('now','-2 hours'), datetime('now','-10 minutes'));
INSERT INTO notes (id, task_id, from_agent, message, created_at)
  VALUES (5001, 2001, 'watchdog', 'ESCALATION L3: heartbeat overdue', datetime('now','-40 minutes'));
INSERT INTO notes (id, task_id, from_agent, message, created_at)
  VALUES (5002, 2001, 'sadie', 'investigated, all clear, normal progress', datetime('now','-9 minutes'));

-- ===========================================================================
-- T2 (POSITIVE / genuine detection must survive): Zone-1 task. The MOST RECENT
-- note contains a structural keyword and it is NEWER than the calling agent's
-- last note (here sadie has never posted). This is a genuine new signal.
-- Both buggy and fixed code: BLOCK (exit 2).
-- ===========================================================================
INSERT INTO tasks (id, description, status, from_agent, to_agent, created_at, last_progress_at)
  VALUES (2002, 'normal task', 'in_progress', 'boss', 'sadie',
          datetime('now','-2 hours'), datetime('now','-10 minutes'));
INSERT INTO notes (id, task_id, from_agent, message, created_at)
  VALUES (5010, 2002, 'boss', 'DECISION REVERSED — re-scope required', datetime('now','-8 minutes'));

-- ===========================================================================
-- T3 (POSITIVE / new keyword AFTER agent's last post): Zone-1 task. sadie
-- posted a clean note, then LATER boss posted an ESCALATION note. sadie now
-- tries to post again. The keyword note is NEWER than sadie's last note → it is
-- an unacknowledged new signal → must BLOCK (exit 2) under both old and new.
-- ===========================================================================
INSERT INTO tasks (id, description, status, from_agent, to_agent, created_at, last_progress_at)
  VALUES (2003, 'task with late escalation', 'in_progress', 'boss', 'sadie',
          datetime('now','-2 hours'), datetime('now','-10 minutes'));
INSERT INTO notes (id, task_id, from_agent, message, created_at)
  VALUES (5020, 2003, 'sadie', 'clean progress note', datetime('now','-15 minutes'));
INSERT INTO notes (id, task_id, from_agent, message, created_at)
  VALUES (5021, 2003, 'boss', 'ESCALATION: needs human revisit', datetime('now','-6 minutes'));

-- ===========================================================================
-- T4 (control / clean): Zone-1 task, no keyword anywhere. Must ALLOW (exit 0).
-- ===========================================================================
INSERT INTO tasks (id, description, status, from_agent, to_agent, created_at, last_progress_at)
  VALUES (2004, 'clean task', 'in_progress', 'boss', 'sadie',
          datetime('now','-2 hours'), datetime('now','-10 minutes'));
INSERT INTO notes (id, task_id, from_agent, message, created_at)
  VALUES (5030, 2004, 'sadie', 'just a normal note', datetime('now','-9 minutes'));
SQL

run_hook() {
  local task_id="$1" agent="${2:-sadie}"
  local stdin_json
  stdin_json=$(printf '{"tool_name":"mcp__task-board__send_note","tool_input":{"task_id":%s}}' "$task_id")
  ( export HOME="$TMP" AGENT_LABEL="$agent" FRESHNESS_HOOK_ENABLED=1
    echo "$stdin_json" | "$HOOK" prerevisit ) 2>/dev/null 1>/dev/null
  echo "$?"
}

pass=0; fail=0
check() {
  local desc="$1" expected="$2" got="$3"
  if [ "$got" = "$expected" ]; then
    echo "PASS  $desc -> exit $got"
    pass=$((pass+1))
  else
    echo "FAIL  $desc -> exit $got (expected $expected)"
    fail=$((fail+1))
  fi
}

echo "=== Zone-1 keyword-poison reproduction/regression ==="
# THE BUG: must ALLOW after fix. Against unpatched script this FAILS (returns 2).
check "T1 stale ESCALATION note, agent posted past it -> ALLOW" 0 "$(run_hook 2001 sadie)"
# Genuine detection must survive:
check "T2 newest note has DECISION REVERSED (agent never posted) -> BLOCK" 2 "$(run_hook 2002 sadie)"
check "T3 keyword note newer than agent's last note -> BLOCK"             2 "$(run_hook 2003 sadie)"
check "T4 clean Zone-1 task -> ALLOW"                                     0 "$(run_hook 2004 sadie)"

echo ""
echo "Pass: $pass  Fail: $fail  Total: 4"
rm -rf "$TMP"
exit $fail
