#!/bin/bash
# DUMB status cron (no LLM) — chases the boardsync harness sprint-1 status and
# posts a concise heartbeat to Gwei (REPLACE_WITH_TELEGRAM_CHAT_ID). Requested by Gwei (TG 6710)
# to kill the "is it stalled / are crons firing" doubt. Posts on CHANGE, plus a
# heartbeat every Nth tick. Self-quiets on terminal (PASS/DEPLOYED).
set -uo pipefail

SPRINT="/Users/coachstokes/boardsync-harness/.harness/sprints/sprint-1"
STATE_DIR="/Users/coachstokes/.claude/state/boardsync-harness-status"
# System-voice bot (group member) + TEAM (Two8) group per snoopy. Falls back to Gwei DM if group send fails.
TOKEN_FILE="/Users/coachstokes/.secrets/watcher-bot-token"
GROUP_CHAT_ID="-1003790554582"
GWEI_DM="REPLACE_WITH_TELEGRAM_CHAT_ID"
GWEI_CHAT_ID="$GROUP_CHAT_ID"
LAST_FILE="$STATE_DIR/last_posted"
TICK_FILE="$STATE_DIR/tick"
DONE_FILE="$STATE_DIR/done"
HEARTBEAT_EVERY=5   # force a heartbeat post every N ticks even if unchanged

mkdir -p "$STATE_DIR" 2>/dev/null
[[ -f "$DONE_FILE" ]] && exit 0
[[ -f "$TOKEN_FILE" ]] || exit 0
BOT_TOKEN="$(cat "$TOKEN_FILE")"
[[ -z "$BOT_TOKEN" ]] && exit 0

STATUS="$(cat "$SPRINT/status.txt" 2>/dev/null || echo 'unknown')"
# last verifier verdict line + codex verdict (if present)
VERIFIER="$(grep -hoE 'WORK VERIFIED [0-9]+/[0-9]+|FAIL [0-9]+/[0-9]+|PASS [0-9]+/[0-9]+' "$SPRINT/verifier-report.md" 2>/dev/null | tail -1)"
CODEX="$(grep -hoE 'ADVERSARIAL (PASS|FAIL)' "$SPRINT/codex-adversarial-report.md" 2>/dev/null | tail -1)"
# freshest mtime across the sprint dir as a liveness proxy
FRESH="$(find "$SPRINT" -type f -newermt '-6 min' 2>/dev/null | head -1)"
LIVE=$([ -n "$FRESH" ] && echo "active (<6m)" || echo "idle")

MSG="🔔[BOARD] boardsync-harness status=${STATUS} | verifier=${VERIFIER:-pending} | codex=${CODEX:-pending} | ${LIVE} | $(date '+%H:%M:%S') — mechanical status, no action needed"

# tick counter
TICK=$(( $(cat "$TICK_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$TICK" > "$TICK_FILE"
LAST="$(cat "$LAST_FILE" 2>/dev/null || echo '')"

POST=0
[[ "$MSG" != "$LAST" ]] && { [[ "${STATUS}" != "$(echo "$LAST" | grep -oE 'status=[^ ]+' )" ]] || true; }
# Post if the STATUS/verdict line changed, or every HEARTBEAT_EVERY ticks
KEY="${STATUS}|${VERIFIER}|${CODEX}"
LASTKEY="$(cat "$STATE_DIR/lastkey" 2>/dev/null || echo '')"
[[ "$KEY" != "$LASTKEY" ]] && POST=1
[[ $(( TICK % HEARTBEAT_EVERY )) -eq 0 ]] && POST=1

send_status() {  # $1=text ; tries group, falls back to Gwei DM
  local TXT="$1" RESP OK
  RESP=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${GROUP_CHAT_ID}" --data-urlencode "text=${TXT}")
  OK=$(echo "$RESP" | grep -oE '"ok":true' | head -1)
  if [[ -z "$OK" ]]; then
    # group send failed → fall back to Gwei DM + leave a breadcrumb for boss to relay to snoopy
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${GWEI_DM}" --data-urlencode "text=${TXT} (group send failed → DM fallback)" >/dev/null 2>&1
    echo "$(date '+%FT%TZ') group send FAILED: $(echo "$RESP" | head -c 200)" >> "$STATE_DIR/group-fail.log"
  fi
}

if [[ "$POST" -eq 1 ]]; then
  send_status "$MSG"
  echo "$MSG" > "$LAST_FILE"
  echo "$KEY" > "$STATE_DIR/lastkey"
fi

# Terminal: PASS X/X (work done + codex pass) or DEPLOYED marker → final post + stop
if echo "$STATUS" | grep -qE '^PASS [0-9]+/[0-9]+' && [[ "$CODEX" == "ADVERSARIAL PASS" ]]; then
  send_status "✅ [BOARD] boardsync-harness TERMINAL: ${STATUS} + ADVERSARIAL PASS — gate cleared, deploy next. (dumb status-cron signing off)"
  touch "$DONE_FILE"
fi
exit 0
