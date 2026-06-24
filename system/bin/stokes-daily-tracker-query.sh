#!/bin/bash
# stokes-daily-tracker-query.sh — GweiSprayer /show query interface
#
# Called by the poller (stokes-daily-tracker-poll.sh) when chat REPLACE_WITH_TELEGRAM_CHAT_ID sends:
#   /show YYYY-MM-DD    → single day entry
#   /show last7         → last 7 days (DESC)
#
# Replies to GweiSprayer (chat REPLACE_WITH_TELEGRAM_CHAT_ID) with read-only TG-formatted text.

set -uo pipefail

TG_TOKEN="${TG_TOKEN:-REPLACE_WITH_BOT_TOKEN}"  # SCRUBBED: set via env/keychain (was hardcoded)
GWEISPRAYER_CHAT="REPLACE_WITH_TELEGRAM_CHAT_ID"
DB="$HOME/.claude/state/stokes-daily-tracker/journal.db"
LOG="$HOME/.claude/state/stokes-daily-tracker/query.log"
TS=$(date -u +%FT%TZ)

# Arg: the full message text (e.g. "/show 2026-05-27" or "/show last7")
MSG_TEXT="${1:-}"

log() {
  echo "[$TS] $*" >> "$LOG"
}

tg_send() {
  local text="$1"
  local truncated
  truncated=$(echo "$text" | head -c 4000)
  curl -s --max-time 20 -X POST \
    "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${GWEISPRAYER_CHAT}" \
    --data-urlencode "text=${truncated}" \
    >> "$LOG" 2>&1
}

format_entry() {
  local row="$1"
  # Row format: id|date|self_report|kairos_summary|tiptap_summary|verdict|written_at|locked
  local id date self_report kairos_summary tiptap_summary verdict written_at locked
  id=$(echo "$row" | cut -d'|' -f1)
  date=$(echo "$row" | cut -d'|' -f2)
  self_report=$(echo "$row" | cut -d'|' -f3)
  verdict=$(echo "$row" | cut -d'|' -f6)
  written_at=$(echo "$row" | cut -d'|' -f7)
  locked=$(echo "$row" | cut -d'|' -f8)

  local verdict_field
  verdict_field=$(echo "$verdict" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    v = d.get('verdict','?')
    c = d.get('confidence','?')
    rec = d.get('recommendation','?')
    print(f'{v} (confidence={c})\nRec: {rec}')
except:
    sys.stdout.write(sys.stdin.read()[:200] if sys.stdin.readable() else '?')
" 2>/dev/null || echo "${verdict:0:200}")

  echo "📅 $date (id=$id, locked=$locked)
Written: $written_at

Self-report:
$self_report

Verdict: $verdict_field
---"
}

if [ -z "$MSG_TEXT" ]; then
  log "query.sh called with empty message"
  tg_send "Usage: /show YYYY-MM-DD or /show last7"
  exit 0
fi

log "query: $MSG_TEXT"

if echo "$MSG_TEXT" | grep -qiE "^/show last ?7"; then
  # /show last7: last 7 days
  ROWS=$(sqlite3 "$DB" \
    "SELECT id||'|'||date||'|'||COALESCE(self_report,'')||'|'||COALESCE(kairos_summary,'')||'|'||COALESCE(tiptap_summary,'')||'|'||COALESCE(verdict,'')||'|'||written_at||'|'||locked \
     FROM daily_entries \
     WHERE date >= date('now', 'localtime', '-7 days') \
     ORDER BY date DESC;" 2>/dev/null || echo "")

  if [ -z "$ROWS" ]; then
    tg_send "No entries in the last 7 days."
    log "no entries for last7"
    exit 0
  fi

  REPLY="Last 7 days — Daily Tracker Entries:"$'\n'
  while IFS= read -r row; do
    [ -z "$row" ] && continue
    REPLY="$REPLY"$'\n'"$(format_entry "$row")"
  done <<< "$ROWS"
  tg_send "$REPLY"
  log "replied with last7 entries"

elif echo "$MSG_TEXT" | grep -qE "^/show [0-9]{4}-[0-9]{2}-[0-9]{2}"; then
  # /show YYYY-MM-DD: single day
  TARGET_DATE=$(echo "$MSG_TEXT" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
  ROW=$(sqlite3 "$DB" \
    "SELECT id||'|'||date||'|'||COALESCE(self_report,'')||'|'||COALESCE(kairos_summary,'')||'|'||COALESCE(tiptap_summary,'')||'|'||COALESCE(verdict,'')||'|'||written_at||'|'||locked \
     FROM daily_entries WHERE date='$TARGET_DATE';" 2>/dev/null || echo "")

  if [ -z "$ROW" ]; then
    tg_send "No daily_entries row for $TARGET_DATE."
    log "no entry found for $TARGET_DATE"
  else
    tg_send "Entry for $TARGET_DATE:"$'\n'"$(format_entry "$ROW")"
    log "replied with entry for $TARGET_DATE"
  fi

else
  tg_send "Unrecognised query. Usage: /show YYYY-MM-DD or /show last7"
  log "unrecognised query: $MSG_TEXT"
fi

exit 0
