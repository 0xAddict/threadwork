#!/bin/bash
# stokes-daily-tracker-poll.sh — 60s Telegram reply poller
#
# Architecture mirrors memory-promotion-poller.sh.
# Polls getUpdates; routes messages by chat_id:
#   REPLACE_WITH_TELEGRAM_CHAT_ID  → Stokes self-report path (GATE 1)
#   REPLACE_WITH_TELEGRAM_CHAT_ID  → GweiSprayer /show query path (W6)
#   all others  → ignored + logged
#
# On Stokes self-report:
#   1. GATE 2: if today's daily_entries locked=1, log to attempted_edits, reply locked msg
#   2. GATE 3: if no row yet + prompts_sent today → capture self-report
#   3. Run Kairos + TipTap summarization
#   4. Call Opus 4.7 thinking-high verdict via stokes-daily-tracker-verdict.py
#   5. Write locked=1 row to daily_entries
#   6. Ack Stokes: "Logged. Sleep well."
#   7. Notify GweiSprayer (REPLACE_WITH_TELEGRAM_CHAT_ID) with full diff immediately

set -uo pipefail

# CAPTURE via the dedicated Woodchuck bot's OWN getUpdates stream.
# Dedicated token (bot_id 8668963584) => no 409 with the shared agent bot or old manager bot.
# Token lives (0600) in woodchuck.env; never hard-code it here.
STATE_DIR="$HOME/.claude/state/stokes-daily-tracker"
WOODCHUCK_ENV="$STATE_DIR/woodchuck.env"
if [ -f "$WOODCHUCK_ENV" ]; then
  # shellcheck disable=SC1090
  . "$WOODCHUCK_ENV"
fi
TG_TOKEN="${WOODCHUCK_TG_TOKEN:-}"
STOKES_CHAT="REPLACE_WITH_TELEGRAM_CHAT_ID"
GWEISPRAYER_CHAT="REPLACE_WITH_TELEGRAM_CHAT_ID"
DB="$STATE_DIR/journal.db"
KAIROS_DB="$HOME/bin/kairos.db"
VERDICT_PY="$HOME/bin/stokes-daily-tracker-verdict.py"
QUERY_SH="$HOME/bin/stokes-daily-tracker-query.sh"
# Dedicated offset file for the Woodchuck stream — must NOT reuse the old
# manager-bot offset (different bot, different update_id sequence).
STATE_FILE="$STATE_DIR/last_update_id.woodchuck"
LOG="$STATE_DIR/poll.log"
TS=$(date -u +%FT%TZ)
TODAY=$(TZ="Europe/Helsinki" date +%Y-%m-%d)

mkdir -p "$STATE_DIR"

if [ -z "$TG_TOKEN" ]; then
  echo "[$TS] ERROR: Woodchuck token not found ($WOODCHUCK_ENV missing or WOODCHUCK_TG_TOKEN unset) — cannot poll. Exiting." >> "$LOG"
  exit 1
fi

# Read offset
if [ -f "$STATE_FILE" ] && [ -s "$STATE_FILE" ]; then
  OFFSET=$(cat "$STATE_FILE")
else
  OFFSET=0
fi

log() {
  echo "[$TS] $*" >> "$LOG"
}

tg_send() {
  local chat_id="$1"
  local text="$2"
  curl -s --max-time 20 -X POST \
    "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" \
    2>>"$LOG"
}

log "poll start offset=$OFFSET today=$TODAY (bot=woodchuck/8668963584)"

# Fetch updates
RESPONSE=$(curl -s --max-time 20 \
  "https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${OFFSET}&timeout=0" \
  2>>"$LOG")

if [ -z "$RESPONSE" ]; then
  log "ERROR: empty response"
  exit 1
fi

OK=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok','false'))" 2>/dev/null)
if [ "$OK" != "True" ] && [ "$OK" != "true" ]; then
  log "ERROR: Telegram API ok=false: $RESPONSE"
  exit 1
fi

TOTAL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',[])))" 2>/dev/null || echo 0)
log "received $TOTAL updates"

if [ "$TOTAL" -eq 0 ]; then
  log "no updates"
  exit 0
fi

MAX_UPDATE_ID="$OFFSET"

# Process each update
while IFS= read -r update; do
  UPDATE_ID=$(echo "$update" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('update_id',''))" 2>/dev/null)
  CHAT_ID=$(echo "$update" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',{}).get('chat',{}).get('id',''))" 2>/dev/null)
  MSG_TEXT=$(echo "$update" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',{}).get('text',''))" 2>/dev/null)
  MSG_ID=$(echo "$update" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',{}).get('message_id',''))" 2>/dev/null)

  # Track max update_id
  if [ -n "$UPDATE_ID" ] && [ "$UPDATE_ID" -gt "$MAX_UPDATE_ID" ] 2>/dev/null; then
    MAX_UPDATE_ID="$UPDATE_ID"
  fi

  if [ -z "$CHAT_ID" ] || [ -z "$MSG_TEXT" ]; then
    log "update $UPDATE_ID: no chat_id or text — skipping"
    continue
  fi

  log "update $UPDATE_ID: chat_id=$CHAT_ID msg_id=$MSG_ID text_len=${#MSG_TEXT}"

  # ── GATE 1: Route by chat_id ─────────────────────────────────────────────
  if [ "$CHAT_ID" = "$GWEISPRAYER_CHAT" ]; then
    # GweiSprayer /show query path (W6)
    log "update $UPDATE_ID: GweiSprayer query: $MSG_TEXT"
    if echo "$MSG_TEXT" | grep -qE "^/show"; then
      bash "$QUERY_SH" "$MSG_TEXT" 2>>"$LOG" || log "query.sh error"
    fi
    continue
  fi

  if [ "$CHAT_ID" != "$STOKES_CHAT" ]; then
    log "update $UPDATE_ID: IGNORED — chat_id=$CHAT_ID is not Stokes ($STOKES_CHAT) or GweiSprayer ($GWEISPRAYER_CHAT)"
    continue
  fi

  # ── STOKES PATH ──────────────────────────────────────────────────────────
  # GATE 2: Check if today's row is locked (edit-block)
  EXISTING_LOCKED=$(sqlite3 "$DB" \
    "SELECT locked FROM daily_entries WHERE date='$TODAY';" 2>/dev/null || echo "")

  if [ "$EXISTING_LOCKED" = "1" ]; then
    # Stokes is trying to edit a locked row — check regex
    EDIT_REGEX='(edit|revise|change|fix|amend|correct).*\b(yesterday|last week|day|entry|log|journal)\b'
    if echo "$MSG_TEXT" | grep -qiE "$EDIT_REGEX"; then
      log "update $UPDATE_ID: BLOCKED edit attempt — matches edit-block regex"
      ESCAPED=$(echo "$MSG_TEXT" | sed "s/'/''/g")
      sqlite3 "$DB" "INSERT INTO attempted_edits(ts, source_chat_id, telegram_msg_id, attempted_content, blocked_reason) \
        VALUES (datetime('now'), $STOKES_CHAT, $MSG_ID, '$ESCAPED', 'locked row edit attempt');" 2>>"$LOG"
      tg_send "$STOKES_CHAT" "Daily entries are locked once written. New entry tomorrow at 20:30." >> "$LOG" 2>&1
    else
      log "update $UPDATE_ID: today's row locked but message is not an edit attempt — ignoring"
    fi
    continue
  fi

  # GATE 3: Check if prompts_sent has today's row AND daily_entries doesn't
  PROMPT_SENT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM prompts_sent WHERE date='$TODAY';" 2>/dev/null || echo 0)
  if [ "$PROMPT_SENT" -eq 0 ]; then
    log "update $UPDATE_ID: no prompt sent today — not yet in active capture window, ignoring"
    continue
  fi

  if [ -n "$EXISTING_LOCKED" ]; then
    # Row exists but not locked — already started processing?
    log "update $UPDATE_ID: daily_entries row exists for today (unlocked) — may be duplicate; ignoring"
    continue
  fi

  # ── CAPTURE: this is the self-report ────────────────────────────────────
  log "update $UPDATE_ID: CAPTURING self-report from Stokes"
  SELF_REPORT="$MSG_TEXT"

  # ── Summarise Kairos for today ───────────────────────────────────────────
  KAIROS_SUMMARY=""
  if [ -f "$KAIROS_DB" ]; then
    KAIROS_RAW=$(sqlite3 "$KAIROS_DB" \
      "SELECT timestamp || ' | ' || COALESCE(active_app,'?') || ' | ' || COALESCE(inference,'') \
       FROM observations \
       WHERE date(timestamp)=date('now','localtime') \
       ORDER BY timestamp;" 2>/dev/null || echo "")
    if [ -n "$KAIROS_RAW" ]; then
      OBS_COUNT=$(echo "$KAIROS_RAW" | wc -l | tr -d ' ')
      APPS=$(echo "$KAIROS_RAW" | awk -F'|' '{print $2}' | sort | uniq -c | sort -rn | head -10)
      KAIROS_SUMMARY="Observations today: $OBS_COUNT entries.
Top apps by frequency:
$APPS

Sample inferences (first 5):
$(echo "$KAIROS_RAW" | head -5)"
    else
      KAIROS_SUMMARY="No Kairos observations recorded for today."
    fi
  else
    KAIROS_SUMMARY="Kairos DB not accessible."
  fi

  # ── Summarise TipTap for today ───────────────────────────────────────────
  TIPTAP_SUMMARY=""
  LEVELDB_LOG="$HOME/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/000289.log"
  if [ -f "$LEVELDB_LOG" ]; then
    # Extract readable strings near updatedAt timestamps from today
    TIPTAP_RAW=$(strings "$LEVELDB_LOG" 2>/dev/null | grep -i "updatedAt\|content\|title" | head -20 || echo "")
    if [ -n "$TIPTAP_RAW" ]; then
      TIPTAP_SUMMARY="TipTap/IndexedDB leveldb strings (today's activity):
$TIPTAP_RAW"
    else
      TIPTAP_SUMMARY="No TipTap activity strings found in leveldb log."
    fi
  else
    TIPTAP_SUMMARY="TipTap leveldb log not found."
  fi

  log "kairos_summary length=${#KAIROS_SUMMARY} tiptap_summary length=${#TIPTAP_SUMMARY}"

  # ── Opus 4.7 thinking-high verdict pass ─────────────────────────────────
  log "calling verdict.py with claude-opus-4-7 thinking-high (budget_tokens=8000)"
  VERDICT_JSON=$(python3 "$VERDICT_PY" \
    --self-report "$SELF_REPORT" \
    --kairos-summary "$KAIROS_SUMMARY" \
    --tiptap-summary "$TIPTAP_SUMMARY" \
    --date "$TODAY" 2>>"$LOG")

  VERDICT_FIELD=$(echo "$VERDICT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('verdict','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
  log "verdict result: $VERDICT_FIELD"

  # ── Write locked=1 row to daily_entries ─────────────────────────────────
  ESCAPED_SR=$(echo "$SELF_REPORT" | sed "s/'/''/g")
  ESCAPED_KS=$(echo "$KAIROS_SUMMARY" | sed "s/'/''/g")
  ESCAPED_TS=$(echo "$TIPTAP_SUMMARY" | sed "s/'/''/g")
  ESCAPED_VJ=$(echo "$VERDICT_JSON" | sed "s/'/''/g")

  sqlite3 "$DB" "INSERT INTO daily_entries(date, self_report, kairos_summary, tiptap_summary, verdict, written_at, locked) \
    VALUES ('$TODAY', '$ESCAPED_SR', '$ESCAPED_KS', '$ESCAPED_TS', '$ESCAPED_VJ', datetime('now'), 1);" 2>>"$LOG"

  log "daily_entries row written with locked=1 for date=$TODAY"

  # ── Ack Stokes ───────────────────────────────────────────────────────────
  tg_send "$STOKES_CHAT" "Logged. Sleep well." >> "$LOG" 2>&1
  log "acked Stokes"

  # ── Notify GweiSprayer with full diff ───────────────────────────────────
  VERDICT_SUMMARY=$(echo "$VERDICT_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f\"Verdict: {d.get('verdict','?')} (confidence={d.get('confidence','?')})\\nEvidence for: {d.get('evidence_for','?')}\\nEvidence against: {d.get('evidence_against','?')}\\nRecommendation: {d.get('recommendation','?')}\")
except:
    print('Verdict parse error')
" 2>/dev/null || echo "$VERDICT_JSON")

  DIFF_MSG="Daily tracker reconciliation — $TODAY

SELF-REPORT (Stokes verbatim):
$SELF_REPORT

KAIROS SUMMARY:
$KAIROS_SUMMARY

TIPTAP SUMMARY:
$TIPTAP_SUMMARY

VERDICT:
$VERDICT_SUMMARY

Full verdict JSON:
$VERDICT_JSON"

  # Truncate to ~4000 chars for TG limit
  DIFF_MSG_TRUNCATED=$(echo "$DIFF_MSG" | head -c 4000)
  tg_send "$GWEISPRAYER_CHAT" "$DIFF_MSG_TRUNCATED" >> "$LOG" 2>&1
  log "GweiSprayer notified with verdict diff"

done < <(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for item in d.get('result', []):
    print(json.dumps(item))
" 2>/dev/null)

# Update offset
NEW_OFFSET=$((MAX_UPDATE_ID + 1))
TMPFILE=$(mktemp "$STATE_DIR/.last_update_id.XXXXXX")
echo "$NEW_OFFSET" > "$TMPFILE"
mv "$TMPFILE" "$STATE_FILE"

log "poll complete new_offset=$NEW_OFFSET"
exit 0
