#!/usr/bin/env bash
# spec-gate-session-scoped.sh
# PreToolUse hook for mcp__task-board__complete_task.
# Gates completion of god-mode sprint tasks unless the verifier has
# landed a pass marker. Fails open on any error (never blocks the
# wrong session).
#
# Session scope: only fires when stdin.session_id matches
#   /tmp/spec-gate-boss-session.lock (trimmed).
# Task scope: only fires when stdin.tool_input.task_id is listed in
#   /tmp/spec-gate-boss-tasks.lock (one id per line).
# Sprint gate: blocks unless a /tmp/claw-port-sprint<N>-verified.lock
#   exists, where <N> is read from /tmp/spec-gate-current-sprint.lock.

set -u
SESSION_LOCK=/tmp/spec-gate-boss-session.lock
TASKS_LOCK=/tmp/spec-gate-boss-tasks.lock
SPRINT_LOCK=/tmp/spec-gate-current-sprint.lock
ERR_LOG=/tmp/spec-gate-errors.log

emit_approve() { printf '%s\n' '{"decision":"approve"}'; exit 0; }
emit_block()   { printf '{"decision":"block","reason":%s}\n' "$1"; exit 0; }
log_err()      { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$1" >> "$ERR_LOG" 2>/dev/null; }

# Read stdin JSON
input=$(cat 2>/dev/null) || { log_err "stdin read failed"; emit_approve; }
[ -z "$input" ] && { log_err "empty stdin"; emit_approve; }

# Parse session_id + task_id. jq failure = approve (fail-open).
session_id=$(printf '%s' "$input" | /usr/bin/jq -r '.session_id // empty' 2>/dev/null) || { log_err "jq session_id failed"; emit_approve; }
task_id=$(printf '%s' "$input" | /usr/bin/jq -r '.tool_input.task_id // empty' 2>/dev/null) || { log_err "jq task_id failed"; emit_approve; }

# Session scope: if no lock, or session mismatch, approve.
[ -f "$SESSION_LOCK" ] || emit_approve
scoped_session=$(head -c 64 "$SESSION_LOCK" 2>/dev/null | tr -d '[:space:]')
[ -n "$scoped_session" ] || emit_approve
[ "$session_id" = "$scoped_session" ] || emit_approve

# Task scope: if no lock or task_id not in it, approve.
[ -f "$TASKS_LOCK" ] || emit_approve
[ -n "$task_id" ] || emit_approve
grep -qxF "$task_id" "$TASKS_LOCK" 2>/dev/null || emit_approve

# We are scoped. Check sprint verifier marker.
[ -f "$SPRINT_LOCK" ] || { log_err "sprint lock missing for task $task_id"; emit_approve; }
sprint_num=$(head -c 8 "$SPRINT_LOCK" 2>/dev/null | tr -d '[:space:]')
[ -n "$sprint_num" ] || { log_err "sprint lock empty"; emit_approve; }

verify_marker="/tmp/claw-port-sprint${sprint_num}-verified.lock"
if [ -f "$verify_marker" ]; then
  emit_approve
fi

emit_block "\"Sprint ${sprint_num} verifier has not landed ${verify_marker}. Run the Opus verifier + ensure all 6 spec-gate channels (HTTP/Visual/Console/Supabase/Lint/TSC) pass before completing task ${task_id}.\""
