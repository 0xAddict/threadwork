#!/usr/bin/env bash
# session-boot.sh — SessionStart hook
# Forces agents to self-initialize on every new Claude session.
# Outputs boot instructions that Claude acts on immediately.
# #638 extension: also reads a recent session-handoff memory if present and
# surfaces it as a banner so a freshly-cleared session auto-rehydrates from
# the prior session's evacuated state. (Deep-research v2 pattern c.)

LABEL="${AGENT_LABEL:-unknown}"

if [ "$LABEL" = "unknown" ] || [ -z "$LABEL" ]; then
  exit 0
fi

# --- Restart-window flag (TG #5371 / task #1134) ---
# Touch a per-agent flag file so the watchdog can suppress false-positive
# heartbeat-overdue nudges and circuit-open alerts during the 60–300s of
# session-restart silence. The watchdog reads the flag mtime and considers
# the window active for 300s; after that, normal alerting resumes (so a
# stalled restart still pages eventually). See watchdog.ts isRestartWindowActive().
RESTART_FLAG_DIR="$HOME/.claude/state/restart-window"
mkdir -p "$RESTART_FLAG_DIR" 2>/dev/null
touch "$RESTART_FLAG_DIR/$LABEL.flag" 2>/dev/null || true

# --- Auto-rehydrate from session-handoff memory (#638) ---
# Direct sqlite read because hooks can't invoke MCP. Look for the most recent
# handoff memory for this agent created in the last 24h. Fail-open silently.
TASKBOARD_DB="${TASKBOARD_DB:-$HOME/.claude/mcp-servers/task-board/tasks.db}"
# P4 Stage 7 KO-1 (#10376057): route the handoff memory's content through the
# memory-integrity CLI (same sanitizeMemoryContent primitive as the TS write
# paths) instead of printing row[2] directly — closes the shell-hook
# sanitizer bypass. Env-overridable so tests can point at the worktree CLI +
# a /tmp DB; defaults to the live paths so production behavior is unchanged
# when the env vars are unset.
MEMORY_INTEGRITY_CLI="${MEMORY_INTEGRITY_CLI:-$HOME/.claude/mcp-servers/task-board/memory-integrity-cli.ts}"
BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
HANDOFF_OUTPUT=""
if [ -f "$TASKBOARD_DB" ]; then
  python3 - <<PY 2>/dev/null
import sqlite3, subprocess, os
db = sqlite3.connect("${TASKBOARD_DB}")
row = db.execute("""
  SELECT id, created_at, content, source_type FROM memories
  WHERE (agent = ? OR agent = 'shared')
    AND content LIKE ?
    AND state = 'active'
    AND created_at > datetime('now', '-24 hours')
  ORDER BY created_at DESC LIMIT 1
""", ("${LABEL}", "[session-handoff:${LABEL}:%")).fetchone()
if row:
    mem_id, created_at, content, source_type = row
    source_type = source_type or 'agent'
    # Fail-closed: CLI error (missing/unreadable flag DB, bad exit, exception)
    # -> sanitized stays None -> the ENTIRE handoff banner is skipped below.
    # Never fall back to printing the raw content.
    sanitized = None
    try:
        proc = subprocess.run(
            ["${BUN_BIN}", "${MEMORY_INTEGRITY_CLI}", "--sanitize-stdin", "--source-type=" + source_type],
            input=content, capture_output=True, text=True, timeout=10,
            env={**os.environ, "TASKBOARD_DB": "${TASKBOARD_DB}"},
        )
        if proc.returncode == 0:
            sanitized = proc.stdout
    except Exception:
        sanitized = None
    if sanitized is not None:
        bar = "=" * 64
        print(bar)
        print(f"PRIOR SESSION HANDOFF — memory #{mem_id} ({created_at} UTC)")
        print(bar)
        print(sanitized)
        print(bar)
        print("END HANDOFF")
PY
fi

cat <<EOF
You are agent "${LABEL}" in the threadwork team. IMMEDIATELY on this session start:

1. Call get_boot_briefing to load your role, memories, and recent tasks
2. Call list_tasks(filter="mine") to check for pending work
3. If you have pending tasks, claim and work on them
4. If you received a nudge (message typed into your prompt), respond to it
5. Report your status via write_status or send_note

Do NOT wait for user input. Act now.
EOF

# --- Mega-skill lint (#764 sprint 2) ---
# Walk user SKILL.md files; warn if a single SKILL.md exceeds the line
# threshold without a sibling references/ directory. Folder-shaped skills
# with references/ are treated as already-decomposed and skipped regardless
# of size. Single-file skills (~/.claude/skills/*.md) have no possible
# references/ sibling so they always warn above threshold.
# Threshold: env MEGASKILL_LINT_LINES (default 200).
# Bypass: env MEGASKILL_LINT_DISABLED=1.
if [ "${MEGASKILL_LINT_DISABLED:-0}" != "1" ]; then
  MEGASKILL_LINES="${MEGASKILL_LINT_LINES:-200}"
  SKILLS_DIR="${HOME}/.claude/skills"
  if [ -d "$SKILLS_DIR" ]; then
    # Folder-shaped skills: ~/.claude/skills/<name>/SKILL.md
    for sk in "$SKILLS_DIR"/*/SKILL.md; do
      [ -f "$sk" ] || continue
      lines=$(wc -l < "$sk" | tr -d ' ')
      if [ "$lines" -gt "$MEGASKILL_LINES" ]; then
        skdir="$(dirname "$sk")"
        if [ ! -d "$skdir/references" ]; then
          echo "[megaskill-lint] WARN: $sk has $lines lines (>$MEGASKILL_LINES) and no references/ sidecar — consider splitting" >&2
        fi
      fi
    done
    # Single-file skills: ~/.claude/skills/<name>.md (cannot have sibling references/)
    for sk in "$SKILLS_DIR"/*.md; do
      [ -f "$sk" ] || continue
      lines=$(wc -l < "$sk" | tr -d ' ')
      if [ "$lines" -gt "$MEGASKILL_LINES" ]; then
        echo "[megaskill-lint] WARN: $sk has $lines lines (>$MEGASKILL_LINES) and is single-file — consider promoting to folder + references/" >&2
      fi
    done
  fi
fi
