#!/usr/bin/env bash
# emit-state.sh — Claude Code hook: declare agent operational state
#
# Args: $1=STATE  $2=TASK_ID (optional)  $3=TOOL (optional)
# Stdin: Claude Code hook JSON payload (optional; tool_name extracted if $3 empty)
#
# Wire-up (settings.json):
#   SessionStart         → emit-state.sh IDLE_BOOT
#   UserPromptSubmit     → emit-state.sh ACTIVE_THINKING
#   PreToolUse (Agent)   → emit-state.sh SUBAGENT_RUNNING
#   PreToolUse (generic) → emit-state.sh TOOL_IN_FLIGHT  (tool_name from stdin)
#   PostToolUse          → emit-state.sh ACTIVE_THINKING
#   SubagentStop         → emit-state.sh ACTIVE_THINKING
#   Stop                 → emit-state.sh WAITING_HUMAN
#
# Never fails loudly. SQLite write is async (background subshell, .timeout 100)
# so tool flow is never blocked. JSONL is synchronous and fast.
#
# Spec: state-contracts-redesign-spec.md §5 step 2

set +e

STATE="${1:-}"
TASK_ID="${2:-}"
TOOL="${3:-}"

[ -z "$STATE" ] && exit 0

TMUX_BIN="/Users/coachstokes/.local/bin/tmux"

# Read stdin for hook JSON payload (non-blocking; only if stdin is piped, not a terminal)
HOOK_JSON=""
if [ ! -t 0 ]; then
  HOOK_JSON=$(cat 2>/dev/null || true)
fi

# Extract tool_name from stdin JSON if not passed as $3
if [ -z "$TOOL" ] && [ -n "$HOOK_JSON" ]; then
  TOOL=$(printf '%s' "$HOOK_JSON" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4 2>/dev/null || true)
fi

AGENT="$("$TMUX_BIN" display-message -p '#S' 2>/dev/null | sed 's/^claude-//')"
[ -z "$AGENT" ] && exit 0

DB="$HOME/.claude/mcp-servers/task-board/tasks.db"
JSONL_DIR="$HOME/.claude/state/heartbeat-v2"
mkdir -p "$JSONL_DIR" 2>/dev/null

NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
PID="${CLAUDE_PID:-$$}"

# JSONL append (synchronous — fast, no sqlite contention)
printf '{"ts":"%s","agent":"%s","state":"%s","task_id":"%s","tool":"%s","pid":%s,"source":"hook"}\n' \
  "$NOW" "$AGENT" "$STATE" "$TASK_ID" "$TOOL" "$PID" \
  >> "$JSONL_DIR/state-$AGENT.jsonl" 2>/dev/null

# Rotate JSONL at 10 MB (macOS stat -f%z, Linux stat -c%s)
JSONL_FILE="$JSONL_DIR/state-$AGENT.jsonl"
if [ -f "$JSONL_FILE" ]; then
  FILE_SIZE=$(stat -f%z "$JSONL_FILE" 2>/dev/null || stat -c%s "$JSONL_FILE" 2>/dev/null || echo 0)
  if [ "$FILE_SIZE" -gt 10485760 ]; then
    mv "$JSONL_FILE" "${JSONL_FILE}.$(date +%s).bak" 2>/dev/null || true
  fi
fi

# SQLite UPSERT (async background subshell — .timeout 100, never blocks tool flow)
(
  sqlite3 -cmd ".timeout 100" "$DB" <<SQL 2>/dev/null
INSERT INTO agent_sessions (agent, state, state_changed_at, state_source, current_task_id, current_tool, claude_pid, last_seen_at)
VALUES ('${AGENT}', '${STATE}', '${NOW}', 'hook', NULLIF('${TASK_ID}',''), NULLIF('${TOOL}',''), ${PID}, '${NOW}')
ON CONFLICT(agent) DO UPDATE SET
  state            = excluded.state,
  state_changed_at = excluded.state_changed_at,
  state_source     = excluded.state_source,
  current_task_id  = COALESCE(excluded.current_task_id, agent_sessions.current_task_id),
  current_tool     = excluded.current_tool,
  claude_pid       = excluded.claude_pid,
  last_seen_at     = excluded.last_seen_at;
SQL
) &

exit 0
