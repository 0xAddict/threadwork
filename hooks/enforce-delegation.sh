#!/usr/bin/env bash
# enforce-delegation.sh — PreToolUse hook for Claude Code
# Agent Level Enforcement:
#   Level 0 (Snoopy): No restrictions
#   Level 1 (Boss):   Logs direct tool use, allows (has discretion)
#   Level 2 (Workers): BLOCKS direct execution in main thread (agent_id absent)
#
# Sub-agent detection via agent_id field:
#   - When agent_id is PRESENT in the hook JSON → sub-agent tool call → allow
#   - When agent_id is ABSENT → main thread tool call → apply level-based blocking
#
# Exit codes: 0 = allow, 2 = block (with message to stderr)

# Fast path: if no TELEGRAM_BOT_TOKEN, not an agent session
[ -z "$TELEGRAM_BOT_TOKEN" ] && exit 0
[ -z "$AGENT_LABEL" ] && exit 0

# Read stdin JSON
STDIN_DATA=$(cat)
TOOL=$(echo "$STDIN_DATA" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)

[ -z "$TOOL" ] && exit 0

# --- Detect sub-agent context via agent_id ---
# agent_id is present in the JSON when a sub-agent makes the tool call,
# and absent when the main thread makes the call.
HAS_AGENT_ID=$(echo "$STDIN_DATA" | grep -c '"agent_id"')

# Agent tool itself is always allowed (main thread spawning sub-agents)
[ "$TOOL" = "Agent" ] && exit 0

# --- Agent Level Lookup ---
LEVELS_FILE="$HOME/.claude/hooks/agent-levels.json"
AGENT_LEVEL=2  # Default: worker level

if [ -f "$LEVELS_FILE" ]; then
  LEVEL_VAL=$(python3 -c "
import json, sys
with open('$LEVELS_FILE') as f:
    data = json.load(f)
level = data.get('levels', {}).get('${AGENT_LABEL}', 2)
print(level)
" 2>/dev/null)
  [ -n "$LEVEL_VAL" ] && AGENT_LEVEL=$LEVEL_VAL
fi

# Level 0 = superuser, no restrictions (but still warn parent closures)
if [ "$AGENT_LEVEL" -eq 0 ]; then
  if [ "$TOOL" = "mcp__task-board__complete_task" ] && [ -x "$HOME/.claude/hooks/subagent-blackboard.sh" ]; then
    "$HOME/.claude/hooks/subagent-blackboard.sh" precomplete-parent <<<"$STDIN_DATA" || true
  fi
  exit 0
fi

# --- Check if tool is always allowed ---
is_always_allowed() {
  python3 -c "
import json, sys
with open('$LEVELS_FILE') as f:
    data = json.load(f)
allowed = data.get('always_allowed', [])
tool = '${TOOL}'
for a in allowed:
    if tool == a or tool.startswith(a):
        sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

if is_always_allowed; then
  exit 0
fi

TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

if [ "$AGENT_LEVEL" -eq 1 ]; then
  # Level 1 (Boss): Log only, always allow
  echo "$TIMESTAMP level=1 agent=$AGENT_LABEL tool=$TOOL has_agent_id=$HAS_AGENT_ID action=LOG" >> /tmp/delegation-audit.log
  # Warn on parent closures (main thread complete_task with sub-agents having run)
  if [ "$HAS_AGENT_ID" -eq 0 ] && [ "$TOOL" = "mcp__task-board__complete_task" ] && [ -x "$HOME/.claude/hooks/subagent-blackboard.sh" ]; then
    "$HOME/.claude/hooks/subagent-blackboard.sh" precomplete-parent <<<"$STDIN_DATA" || true
  fi
  # Freshness gate (Phase A: env-gated). Mirrors the precomplete branch above.
  if [ "${FRESHNESS_HOOK_ENABLED:-0}" = "1" ] && [ "$TOOL" = "mcp__task-board__claim_task" ] && [ -x "$HOME/.claude/hooks/freshness-check.sh" ]; then
    "$HOME/.claude/hooks/freshness-check.sh" preclaim <<<"$STDIN_DATA" || exit 2
  fi
  exit 0
fi

if [ "$AGENT_LEVEL" -eq 2 ]; then
  # Check hard-blocked tools (blocked even for sub-agents at L2)
  is_hard_blocked() {
    python3 -c "
import json, sys
with open('$LEVELS_FILE') as f:
    data = json.load(f)
blocked = data.get('hard_blocked_for_l2', [])
tool = '${TOOL}'
for b in blocked:
    if tool == b or tool.startswith(b):
        sys.exit(0)
sys.exit(1)
" 2>/dev/null
  }

  if is_hard_blocked; then
    echo "$TIMESTAMP level=2 agent=$AGENT_LABEL tool=$TOOL action=HARD_BLOCK" >> /tmp/delegation-audit.log
    echo "HARD BLOCKED: Tool '$TOOL' is restricted to Level 0-1 agents only (Boss/Snoopy). Level 2 agents cannot use this tool even via sub-agents." >&2
    exit 2
  fi

  if [ "$HAS_AGENT_ID" -gt 0 ]; then
    # agent_id present → this is a sub-agent tool call → allow
    echo "$TIMESTAMP level=2 agent=$AGENT_LABEL tool=$TOOL has_agent_id=yes action=ALLOW_SUBAGENT" >> /tmp/delegation-audit.log
    # Fire heartbeat relay (non-blocking, never fails the hook)
    if [ -x "$HOME/.claude/hooks/subagent-heartbeat.sh" ]; then
      "$HOME/.claude/hooks/subagent-heartbeat.sh" tool-call <<<"$STDIN_DATA" >/dev/null 2>&1 || true
    fi
    # Blackboard enforcement: block complete_task if no findings/artifacts/notes
    if [ "$TOOL" = "mcp__task-board__complete_task" ] && [ -x "$HOME/.claude/hooks/subagent-blackboard.sh" ]; then
      "$HOME/.claude/hooks/subagent-blackboard.sh" precomplete-subagent <<<"$STDIN_DATA" || exit 2
    fi
    # Freshness gate (Phase A: env-gated). Mirrors the precomplete branch above.
    if [ "${FRESHNESS_HOOK_ENABLED:-0}" = "1" ] && [ "$TOOL" = "mcp__task-board__claim_task" ] && [ -x "$HOME/.claude/hooks/freshness-check.sh" ]; then
      "$HOME/.claude/hooks/freshness-check.sh" preclaim <<<"$STDIN_DATA" || exit 2
    fi
    exit 0
  else
    # agent_id absent → main thread trying to execute directly → BLOCK
    echo "$TIMESTAMP level=2 agent=$AGENT_LABEL tool=$TOOL has_agent_id=no action=BLOCK" >> /tmp/delegation-audit.log
    echo "BLOCKED: Level 2 agents must delegate work to sub-agents. Tool '$TOOL' cannot be used directly. Spawn a sub-agent with the Agent tool first, then have IT execute this work." >&2
    exit 2
  fi
fi

# Unknown level — allow but log
echo "$TIMESTAMP level=$AGENT_LEVEL agent=$AGENT_LABEL tool=$TOOL action=UNKNOWN_LEVEL" >> /tmp/delegation-audit.log
exit 0
