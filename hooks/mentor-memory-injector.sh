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
DB="${TASKBOARD_DB:-$HOME/.claude/mcp-servers/task-board/tasks.db}"
# P4 Stage 7 KO-1 (#10376057): pipe-through sanitizer CLI. Env-overridable so
# tests can point at the worktree CLI; defaults to the live path so
# production behavior is unchanged when unset.
MEMORY_INTEGRITY_CLI="${MEMORY_INTEGRITY_CLI:-$HOME/.claude/mcp-servers/task-board/memory-integrity-cli.ts}"
BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

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
# SELECT id, content, source_type FROM memories
#   WHERE state='active' AND pinned=1
#     AND classification='foundational'
#     AND category='preference'
#   ORDER BY id;
#
# Column separator is ASCII 0x1F (Unit Separator), NOT '|' — free-text memory
# content routinely contains literal '|' characters, and with 3 columns a
# '|'-delimited read would corrupt the content/source_type split (bash `read`
# folds all overflow fields into the LAST variable, so a mid-content pipe
# would bleed into source_type). 0x1F never appears in normal text.
QUERY="SELECT id, content, COALESCE(source_type,'agent') FROM memories WHERE state='active' AND pinned=1 AND classification='foundational' AND category='preference' ORDER BY id;"

# codex round-2 finding #2 (HIGH): sqlite3's default ROW terminator is a
# newline, so a memory whose `content` contains an embedded newline would
# split across multiple output lines and desync the `while read` loop below
# (the continuation line gets re-parsed as a NEW row, leaking raw content as
# an id/source_type field — never routed through the sanitizer CLI). Use the
# two-arg `.separator COL ROW` form to make 0x1E (Record Separator) the row
# terminator alongside the existing 0x1F (Unit Separator) column separator,
# so an embedded 0x0A stays inside the content field where it belongs.
MEMORIES=$(sqlite3 -readonly -cmd '.mode list' -cmd $'.separator \x1f \x1e' "$DB" "$QUERY" 2>>"$DEBUG_LOG" || true)

if [ -z "$MEMORIES" ]; then
  log_debug "tool=$TOOL_NAME — no pinned foundational preference memories found"
  exit 0
fi

# --- Emit to stderr (agent context, not user stdout) -------------------------

{
  echo ""
  echo "=== FOUNDATIONAL DIRECTIVES (auto-injected) ==="
  while IFS=$'\x1f' read -r -d $'\x1e' mem_id mem_content mem_source_type; do
    [ -z "$mem_id" ] && continue
    [ -z "$mem_source_type" ] && mem_source_type="agent"

    # P4 Stage 7 KO-1 (#10376057): route content through the memory-integrity
    # CLI (same sanitizeMemoryContent primitive as the TS write paths) before
    # truncation/formatting — closes the shell-hook sanitizer bypass.
    # Fail-closed: if the CLI errors, emit NOTHING for this memory (never
    # fall back to raw content).
    sanitized_content=$(printf '%s' "$mem_content" | TASKBOARD_DB="$DB" "$BUN_BIN" "$MEMORY_INTEGRITY_CLI" --sanitize-stdin --source-type="$mem_source_type" 2>>"$DEBUG_LOG")
    cli_status=$?
    if [ "$cli_status" -ne 0 ]; then
      log_debug "memory-integrity-cli failed (exit=$cli_status) for memory #${mem_id} — skipping (fail-closed)"
      continue
    fi

    # Truncate SANITIZED content to first 200 chars
    short_content="${sanitized_content:0:200}"
    if [ "${#sanitized_content}" -gt 200 ]; then
      echo "#${mem_id}: ${short_content}..."
    else
      echo "#${mem_id}: ${short_content}"
    fi
  done < <(printf '%s' "$MEMORIES")
  echo "=== END FOUNDATIONAL DIRECTIVES ==="
  echo ""
} >&2

log_debug "tool=$TOOL_NAME — injected foundational memories to stderr"

exit 0
