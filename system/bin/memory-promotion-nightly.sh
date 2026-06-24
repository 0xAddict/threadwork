#!/bin/bash
# memory-promotion-nightly.sh — nightly digest of qualifying proposed memories
#
# Candidate criteria (for digest — no auto-promotion):
#   state = 'proposed'
#   AND age > 14 days (created_at older than 14 days ago)
#   AND category IN ('preference', 'learning', 'role')
#   AND challenge_count = 0  (no team objection)
#   AND content does NOT start with '[session-handoff:' (session memories shouldn't be foundational forever)
#   AND content does NOT match 'VERIFICATION TEST%' (stale test artifacts)
#
# GweiSprayer reviews the digest and replies with /promote <ID> <ID> ...
# to approve specific memory promotions via the poller daemon.
#
# Logs to ~/.claude/state/memory-promotion/log

set -u

DB="$HOME/.claude/mcp-servers/task-board/tasks.db"
STATE_DIR="$HOME/.claude/state/memory-promotion"
LOG="$STATE_DIR/log"
TG_TOKEN="${TG_TOKEN:-REPLACE_WITH_BOT_TOKEN}"  # SCRUBBED: set via env/keychain (was hardcoded)
TG_CHAT="REPLACE_WITH_TELEGRAM_CHAT_ID"

mkdir -p "$STATE_DIR"
ts=$(date -u +%FT%TZ)
local_ts=$(date '+%Y-%m-%d %H:%M %Z')

# Optional flag: --dry-run to preview without DB writes
DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

# Step 1: Identify candidates that would be promoted
candidates=$(sqlite3 "$DB" <<SQL
SELECT id || '|' || agent || '|' || category || '|' || CAST((julianday('now')-julianday(created_at)) AS INT) || 'd|' || substr(content, 1, 80)
FROM memories
WHERE state='proposed'
  AND datetime(created_at) < datetime('now', '-14 days')
  AND category IN ('preference','learning','role')
  AND challenge_count = 0
  AND content NOT LIKE '[session-handoff:%'
  AND content NOT LIKE 'VERIFICATION TEST%'
ORDER BY id;
SQL
)

n_candidates=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memories WHERE state='proposed' AND datetime(created_at) < datetime('now', '-14 days') AND category IN ('preference','learning','role') AND challenge_count = 0 AND content NOT LIKE '[session-handoff:%' AND content NOT LIKE 'VERIFICATION TEST%';" 2>>"$LOG")

# Step 2: (no auto-promotion — human approval required via /promote command)

# Step 3: Report remaining proposed (needs manual review)
remaining=$(sqlite3 "$DB" <<SQL
SELECT id || '|' || agent || '|' || category || '|' || CAST((julianday('now')-julianday(created_at)) AS INT) || 'd|' || substr(content, 1, 80)
FROM memories
WHERE state='proposed'
ORDER BY id;
SQL
)

n_remaining=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memories WHERE state='proposed';" 2>>"$LOG")

# Step 4: Build TG message
if [ "$DRY_RUN" -eq 1 ]; then
  mode_tag="[DRY-RUN]"
else
  mode_tag="[LIVE]"
fi

msg="🌙 Nightly memory digest — $local_ts $mode_tag

Candidates ready for approval: $n_candidates (age>14d + preference/learning/role + no challenges)
Total still proposed: $n_remaining

CANDIDATES (approve with /promote):
${candidates:-(none)}

ALL PROPOSED (full list):
${remaining:-(none)}

To approve specific memories, reply with:
  /promote <ID> <ID> ...
Example: /promote 891 905 1331

Select the IDs you want to activate. The poller will promote only those you specify.

Criteria: age>14d AND category IN (preference,learning,role) AND challenge_count=0 AND not a session-handoff or stale test."

# Step 5: Send TG (single message, plain text, no Markdown)
if [ -n "$TG_TOKEN" ]; then
  # Truncate to 4000 chars to fit TG's 4096 limit
  msg_truncated=$(echo "$msg" | head -c 4000)
  curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${msg_truncated}" >> "$LOG" 2>&1
fi

# Step 6: Log to disk
{
  echo "=== $ts $mode_tag ==="
  echo "candidates=$n_candidates remaining=$n_remaining"
  echo "candidates:"
  echo "${candidates:-(none)}"
  echo "remaining:"
  echo "${remaining:-(none)}"
  echo ""
} >> "$LOG"

exit 0
