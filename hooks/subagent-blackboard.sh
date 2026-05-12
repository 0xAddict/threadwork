#!/usr/bin/env bash
# subagent-blackboard.sh — Blackboard enforcement hook for Claude Code
#
# Three modes (dispatched by $1):
#   precomplete-subagent  PreToolUse, sub-agent path: BLOCK complete_task if no
#                         findings/artifacts/notes exist for (task_id, agent).
#   subagent-stop         SubagentStop event: LOG a violation if the sub-agent
#                         stopped with an in_progress task but no blackboard
#                         entries. Never blocks (stop hooks cannot block).
#   precomplete-parent    PreToolUse, main-thread path: WARN on complete_task
#                         if sub-agents ran but nothing was published. Never
#                         blocks.
#
# All failure paths exit 0 so the hook never deadlocks Claude Code.

set -u

MODE="${1:-}"
STATE_DIR="$HOME/.claude/state/blackboard-hook"
DEBUG_LOG="$STATE_DIR/debug.log"
VIOLATIONS_LOG="$STATE_DIR/violations.log"
DB="$HOME/.claude/mcp-servers/task-board/tasks.db"
CACHE_TTL=10

mkdir -p "$STATE_DIR" 2>/dev/null || true

log_debug() {
  echo "$(date -u +%FT%TZ) [$MODE] $*" >> "$DEBUG_LOG" 2>/dev/null || true
}

# Read stdin once (hooks pass JSON on stdin)
STDIN_DATA=$(cat)

# --- Helpers -----------------------------------------------------------------

# Extract tool_name from hook JSON (piped on stdin).
# NOTE: must use `python3 -c` not `python3 - <<PY`, because heredoc redirection
# would steal stdin from the pipe and leave sys.stdin empty.
extract_tool_name() {
  python3 -c 'import json,sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get("tool_name", ""))
except Exception:
    pass' 2>/dev/null
}

# Extract tool_input.task_id from hook JSON (piped on stdin)
extract_task_id() {
  python3 -c 'import json,sys
try:
    data = json.loads(sys.stdin.read())
    ti = data.get("tool_input", {}) or {}
    tid = ti.get("task_id", "")
    if tid == "" or tid is None:
        sys.exit(0)
    print(tid)
except Exception:
    pass' 2>/dev/null
}

# Validate task_id is a positive integer
valid_task_id() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Validate agent label: lowercase letters, digits, underscore, hyphen
valid_agent_label() {
  case "$1" in
    ''|*[!a-z0-9_-]*) return 1 ;;
    [a-z]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Count blackboard entries (findings + artifacts + notes) for (task_id, agent).
# Echoes a single integer. On any error echoes "ERR".
count_blackboard_entries() {
  local task_id="$1"
  local agent="$2"
  local cache_file="$STATE_DIR/task-${task_id}-${agent}.cache"

  # Cache hit within TTL
  if [ -f "$cache_file" ]; then
    local now mtime age
    now=$(date +%s 2>/dev/null || echo 0)
    mtime=$(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || echo 0)
    age=$(( now - mtime ))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$CACHE_TTL" ]; then
      cat "$cache_file" 2>/dev/null && return 0
    fi
  fi

  if [ ! -f "$DB" ]; then
    log_debug "db missing: $DB"
    echo "ERR"
    return 0
  fi

  local sql
  sql="SELECT ("
  sql="${sql}(SELECT COUNT(*) FROM findings WHERE task_id=${task_id} AND agent_id='${agent}')"
  sql="${sql}+(SELECT COUNT(*) FROM artifacts WHERE task_id=${task_id} AND agent_id='${agent}')"
  sql="${sql}+(SELECT COUNT(*) FROM notes WHERE task_id=${task_id} AND from_agent='${agent}')"
  sql="${sql});"

  local result
  result=$(sqlite3 -readonly "$DB" "$sql" 2>>"$DEBUG_LOG")
  if [ -z "$result" ]; then
    log_debug "sqlite empty result for task=$task_id agent=$agent"
    echo "ERR"
    return 0
  fi

  # Cache result
  echo "$result" > "$cache_file" 2>/dev/null || true
  echo "$result"
}

# Count blackboard entries across ALL agents for a task (any author)
count_task_any_entries() {
  local task_id="$1"

  if [ ! -f "$DB" ]; then
    echo "ERR"
    return 0
  fi

  local sql
  sql="SELECT ("
  sql="${sql}(SELECT COUNT(*) FROM findings WHERE task_id=${task_id})"
  sql="${sql}+(SELECT COUNT(*) FROM artifacts WHERE task_id=${task_id})"
  sql="${sql}+(SELECT COUNT(*) FROM notes WHERE task_id=${task_id})"
  sql="${sql});"

  local result
  result=$(sqlite3 -readonly "$DB" "$sql" 2>>"$DEBUG_LOG")
  if [ -z "$result" ]; then
    echo "ERR"
    return 0
  fi
  echo "$result"
}

# Return 0 if task has any child rows (parent_task_id == id), else 1
task_has_children() {
  local task_id="$1"
  if [ ! -f "$DB" ]; then
    return 1
  fi
  local sql="SELECT COUNT(*) FROM tasks WHERE parent_task_id=${task_id};"
  local n
  n=$(sqlite3 -readonly "$DB" "$sql" 2>>"$DEBUG_LOG")
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null
}

# Sum blackboard entries on all direct child tasks of the given parent
count_children_any_entries() {
  local parent_id="$1"
  if [ ! -f "$DB" ]; then
    echo "ERR"
    return 0
  fi
  local sql
  sql="SELECT COALESCE(SUM(cnt),0) FROM ("
  sql="${sql}SELECT (SELECT COUNT(*) FROM findings f WHERE f.task_id=t.id)"
  sql="${sql}+(SELECT COUNT(*) FROM artifacts a WHERE a.task_id=t.id)"
  sql="${sql}+(SELECT COUNT(*) FROM notes n WHERE n.task_id=t.id) AS cnt"
  sql="${sql} FROM tasks t WHERE t.parent_task_id=${parent_id}"
  sql="${sql});"
  local result
  result=$(sqlite3 -readonly "$DB" "$sql" 2>>"$DEBUG_LOG")
  if [ -z "$result" ]; then
    echo "ERR"
    return 0
  fi
  echo "$result"
}

# Find most recent in_progress task for agent. Echoes task_id or "".
find_recent_in_progress_task() {
  local agent="$1"
  if [ ! -f "$DB" ]; then
    return 0
  fi
  local sql
  sql="SELECT id FROM tasks WHERE to_agent='${agent}' AND status='in_progress' "
  sql="${sql}ORDER BY COALESCE(claimed_at, created_at) DESC LIMIT 1;"
  sqlite3 -readonly "$DB" "$sql" 2>>"$DEBUG_LOG"
}

# --- Mode dispatch -----------------------------------------------------------

case "$MODE" in

  precomplete-subagent)
    TOOL_NAME=$(echo "$STDIN_DATA" | extract_tool_name)
    if [ "$TOOL_NAME" != "mcp__task-board__complete_task" ]; then
      exit 0
    fi

    TASK_ID=$(echo "$STDIN_DATA" | extract_task_id)
    AGENT="${AGENT_LABEL:-}"

    if ! valid_task_id "$TASK_ID"; then
      log_debug "invalid/missing task_id: '$TASK_ID'"
      exit 0
    fi
    if ! valid_agent_label "$AGENT"; then
      log_debug "invalid/missing AGENT_LABEL: '$AGENT'"
      exit 0
    fi

    COUNT=$(count_blackboard_entries "$TASK_ID" "$AGENT")
    if [ "$COUNT" = "ERR" ]; then
      log_debug "count err task=$TASK_ID agent=$AGENT — allowing"
      exit 0
    fi

    if [ "$COUNT" -gt 0 ] 2>/dev/null; then
      exit 0
    fi

    cat >&2 <<EOF
🚫 Blackboard required (task #${TASK_ID}): Call write_finding, write_artifact, or send_note BEFORE complete_task.
Sub-agents must publish results to the blackboard — raw context MUST NOT leak back to parent threads.
Fix: mcp__task-board__write_finding(task_id=${TASK_ID}, finding_type="result", summary="...") then retry complete_task.
EOF
    exit 2
    ;;

  subagent-stop)
    AGENT="${AGENT_LABEL:-}"
    if ! valid_agent_label "$AGENT"; then
      log_debug "invalid/missing AGENT_LABEL on stop: '$AGENT'"
      exit 0
    fi

    TASK_ID=$(find_recent_in_progress_task "$AGENT")
    if ! valid_task_id "$TASK_ID"; then
      # No in_progress task — nothing to check
      exit 0
    fi

    COUNT=$(count_blackboard_entries "$TASK_ID" "$AGENT")
    if [ "$COUNT" = "ERR" ]; then
      log_debug "count err on stop task=$TASK_ID agent=$AGENT"
      exit 0
    fi

    if [ "$COUNT" -eq 0 ] 2>/dev/null; then
      echo "$(date -u +%FT%TZ) agent=${AGENT} task=${TASK_ID} violation=stopped_without_blackboard" \
        >> "$VIOLATIONS_LOG" 2>/dev/null || true
    fi
    exit 0
    ;;

  precomplete-parent)
    TOOL_NAME=$(echo "$STDIN_DATA" | extract_tool_name)
    if [ "$TOOL_NAME" != "mcp__task-board__complete_task" ]; then
      exit 0
    fi

    TASK_ID=$(echo "$STDIN_DATA" | extract_task_id)
    if ! valid_task_id "$TASK_ID"; then
      log_debug "parent: invalid/missing task_id: '$TASK_ID'"
      exit 0
    fi

    # Only warn if this task had sub-agents (child tasks)
    if ! task_has_children "$TASK_ID"; then
      exit 0
    fi

    PARENT_COUNT=$(count_task_any_entries "$TASK_ID")
    CHILD_COUNT=$(count_children_any_entries "$TASK_ID")

    if [ "$PARENT_COUNT" = "ERR" ] || [ "$CHILD_COUNT" = "ERR" ]; then
      log_debug "parent: count err task=$TASK_ID"
      exit 0
    fi

    if [ "$PARENT_COUNT" -eq 0 ] 2>/dev/null && [ "$CHILD_COUNT" -eq 0 ] 2>/dev/null; then
      cat >&2 <<EOF
⚠️  Warning: closing task #${TASK_ID} — sub-agents ran but no blackboard entries exist.
Context may have leaked from sub-agent threads into this main thread. Consider write_finding before complete_task.
EOF
    fi
    exit 0
    ;;

  *)
    log_debug "unknown mode: '$MODE'"
    exit 0
    ;;
esac
