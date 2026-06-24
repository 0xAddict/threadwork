#!/usr/bin/env bash
# mentor-memory-injector.sh — PreToolUse hook
#
# Purpose: Before any of the 5 Stokes-facing tool invocations, query SQLite for
# pinned foundational preference memories and inject them to stderr so the agent
# sees the directives in context.
#
# Target tools:
#   mcp__task-board__claim_task
#   mcp__task-board__send_note
#   mcp__task-board__nudge_agent
#   mcp__task-board__complete_task
#   mcp__plugin_telegram_telegram__reply
#
# Exit codes: 0 always — this hook is informational, never blocking.
#
# Bypass / disable conventions (mirrors freshness-check.sh):
#   MENTOR_MEMORY_INJECTOR_DISABLED=1   global kill-switch
#   MENTOR_MEMORY_INJECTOR_BYPASS=1     per-call bypass
#
# Logs:
#   ~/.claude/state/mentor-memory-injector/debug.log
#   ~/.claude/state/mentor-memory-injector/bypass.log
#   ~/.claude/state/mentor-memory-injector/disabled.log

set -u

STATE_DIR="$HOME/.claude/state/mentor-memory-injector"
DEBUG_LOG="$STATE_DIR/debug.log"
BYPASS_LOG="$STATE_DIR/bypass.log"
DISABLED_LOG="$STATE_DIR/disabled.log"
DB="$HOME/.claude/mcp-servers/task-board/tasks.db"

mkdir -p "$STATE_DIR" 2>/dev/null || true

log_debug() {
  echo "$(date -u +%FT%TZ) $*" >> "$DEBUG_LOG" 2>/dev/null || true
}

# --- Kill-switch / bypass ------------------------------------------------------

if [ "${MENTOR_MEMORY_INJECTOR_DISABLED:-}" = "1" ]; then
  echo "$(date -u +%FT%TZ) DISABLED" >> "$DISABLED_LOG" 2>/dev/null || true
  exit 0
fi

if [ "${MENTOR_MEMORY_INJECTOR_BYPASS:-}" = "1" ]; then
  echo "$(date -u +%FT%TZ) BYPASS" >> "$BYPASS_LOG" 2>/dev/null || true
  exit 0
fi

# --- Read stdin (hook JSON) ---------------------------------------------------

STDIN_DATA=$(cat)

# Extract tool_name from hook JSON
TOOL_NAME=$(python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get("tool_name", ""))
except Exception:
    pass
' 2>/dev/null <<< "$STDIN_DATA")

# --- Tool filter: only fire on the 5 target tools ----------------------------

case "$TOOL_NAME" in
  mcp__task-board__claim_task|\
  mcp__task-board__send_note|\
  mcp__task-board__nudge_agent|\
  mcp__task-board__complete_task|\
  mcp__plugin_telegram_telegram__reply)
    : # target tool — proceed
    ;;
  *)
    # Not a target tool — exit silently (allow)
    exit 0
    ;;
esac

# --- DB availability check ---------------------------------------------------

if [ ! -f "$DB" ]; then
  log_debug "db missing: $DB — skipping memory injection"
  exit 0
fi

# --- Query pinned foundational preference memories ---------------------------
# SELECT id, content FROM memories
#   WHERE state='active' AND pinned=1
#     AND classification='foundational'
#     AND category='preference'
#   ORDER BY id;

QUERY="SELECT id, content FROM memories WHERE state='active' AND pinned=1 AND classification='foundational' AND category='preference' ORDER BY id;"

MEMORIES=$(sqlite3 -readonly "$DB" "$QUERY" 2>>"$DEBUG_LOG" || true)

if [ -z "$MEMORIES" ]; then
  log_debug "tool=$TOOL_NAME — no pinned foundational preference memories found"
  exit 0
fi

# --- Emit to stderr (agent context, not user stdout) -------------------------

{
  echo ""
  echo "=== FOUNDATIONAL DIRECTIVES (auto-injected) ==="
  while IFS='|' read -r mem_id mem_content; do
    [ -z "$mem_id" ] && continue
    # Truncate content to first 200 chars
    short_content="${mem_content:0:200}"
    if [ "${#mem_content}" -gt 200 ]; then
      echo "#${mem_id}: ${short_content}..."
    else
      echo "#${mem_id}: ${short_content}"
    fi
  done <<< "$MEMORIES"
  echo "=== END FOUNDATIONAL DIRECTIVES ==="
  echo ""
} >&2

log_debug "tool=$TOOL_NAME — injected foundational memories to stderr"

exit 0
