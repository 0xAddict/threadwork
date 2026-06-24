#!/bin/bash
# memory-promotion-poller.sh — polls Telegram for /promote commands from GweiSprayer
#
# Runs every 60s via launchd (com.threadwork.memory-promotion-poller).
# Reads /promote <ID> <ID> ... messages from chat REPLACE_WITH_TELEGRAM_CHAT_ID only.
# Validates each ID is state='proposed' then promotes it to state='active'.
# Sends a confirmation TG message with counts and reasons.
#
# State: ~/.claude/state/memory-promotion/last_update_id
# Log:   ~/.claude/state/memory-promotion/poller.log

set -u

TG_TOKEN="${TG_TOKEN:-REPLACE_WITH_BOT_TOKEN}"  # SCRUBBED: set via env/keychain (was hardcoded)
TG_CHAT="REPLACE_WITH_TELEGRAM_CHAT_ID"
DB="$HOME/.claude/mcp-servers/task-board/tasks.db"
STATE_DIR="$HOME/.claude/state/memory-promotion"
STATE_FILE="$STATE_DIR/last_update_id"
LOG="$STATE_DIR/poller.log"
TS=$(date -u +%FT%TZ)

mkdir -p "$STATE_DIR"

# Read offset (default 0 if file missing or empty)
if [ -f "$STATE_FILE" ] && [ -s "$STATE_FILE" ]; then
  OFFSET=$(cat "$STATE_FILE")
else
  OFFSET=0
fi

log() {
  echo "[$TS] $*" >> "$LOG"
}

log "poll start offset=$OFFSET"

# Fetch updates from Telegram
RESPONSE=$(curl -s --max-time 15 "https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${OFFSET}&timeout=0" 2>>"$LOG")

if [ -z "$RESPONSE" ]; then
  log "ERROR: empty response from Telegram"
  exit 1
fi

OK=$(echo "$RESPONSE" | jq -r '.ok' 2>/dev/null)
if [ "$OK" != "true" ]; then
  log "ERROR: Telegram API returned ok=false: $RESPONSE"
  exit 1
fi

# Count total updates received
TOTAL_UPDATES=$(echo "$RESPONSE" | jq '.result | length' 2>/dev/null)
log "received $TOTAL_UPDATES updates"

if [ "$TOTAL_UPDATES" -eq 0 ]; then
  log "no updates — exiting"
  exit 0
fi

# Track highest update_id for atomic offset write
MAX_UPDATE_ID="$OFFSET"

# Process all updates
PROMOTED_IDS=()
REJECTED_LIST=()

while IFS= read -r update; do
  UPDATE_ID=$(echo "$update" | jq -r '.update_id')
  MSG_TEXT=$(echo "$update" | jq -r '.message.text // empty')
  CHAT_ID=$(echo "$update" | jq -r '.message.chat.id // empty')

  # Track max update_id
  if [ -n "$UPDATE_ID" ] && [ "$UPDATE_ID" -gt "$MAX_UPDATE_ID" ] 2>/dev/null; then
    MAX_UPDATE_ID="$UPDATE_ID"
  fi

  # Skip non-message updates
  if [ -z "$MSG_TEXT" ] || [ -z "$CHAT_ID" ]; then
    log "update $UPDATE_ID: no message text or chat_id — skipping"
    continue
  fi

  # GATE 1: Only accept messages from GweiSprayer (chat_id REPLACE_WITH_TELEGRAM_CHAT_ID)
  if [ "$CHAT_ID" != "$TG_CHAT" ]; then
    log "update $UPDATE_ID: REJECTED chat_id=$CHAT_ID (not authorized)"
    continue
  fi

  # GATE 2: Match exact /promote pattern: /promote followed by space-separated integers
  if ! echo "$MSG_TEXT" | grep -qE "^/promote(\s+[0-9]+)+\s*$"; then
    log "update $UPDATE_ID: message does not match /promote pattern: '$MSG_TEXT' — skipping"
    continue
  fi

  log "update $UPDATE_ID: processing promote command from chat $CHAT_ID: $MSG_TEXT"

  # Extract all integer IDs from the /promote command
  IDS=$(echo "$MSG_TEXT" | grep -oE '[0-9]+')

  for MEM_ID in $IDS; do
    # Check state in DB — must be 'proposed'
    CURRENT_STATE=$(sqlite3 "$DB" "SELECT state FROM memories WHERE id=$MEM_ID;" 2>>"$LOG")

    if [ -z "$CURRENT_STATE" ]; then
      REJECTED_LIST+=("$MEM_ID: not found in DB")
      log "  ID $MEM_ID: not found — rejected"
      continue
    fi

    if [ "$CURRENT_STATE" != "proposed" ]; then
      REJECTED_LIST+=("$MEM_ID: already $CURRENT_STATE (not proposed)")
      log "  ID $MEM_ID: state=$CURRENT_STATE — rejected (not proposed)"
      continue
    fi

    # Promote: UPDATE only if still proposed (idempotency via WHERE state='proposed')
    ROWS=$(sqlite3 "$DB" "UPDATE memories SET state='active', last_validated=datetime('now') WHERE id=$MEM_ID AND state='proposed'; SELECT changes();" 2>>"$LOG")

    if [ "$ROWS" = "1" ]; then
      PROMOTED_IDS+=("$MEM_ID")
      log "  ID $MEM_ID: promoted to active"
    else
      # Concurrent update or already promoted — treat as non-error
      REJECTED_LIST+=("$MEM_ID: no rows updated (already active?)")
      log "  ID $MEM_ID: UPDATE returned 0 rows — may already be active"
    fi
  done

done < <(echo "$RESPONSE" | jq -c '.result[]')

# Build confirmation message
N_PROMOTED="${#PROMOTED_IDS[@]}"
N_REJECTED="${#REJECTED_LIST[@]}"

if [ "$N_PROMOTED" -gt 0 ] || [ "$N_REJECTED" -gt 0 ]; then
  PROMO_STR=""
  if [ "$N_PROMOTED" -gt 0 ]; then
    PROMO_STR=$(printf '%s\n' "${PROMOTED_IDS[@]}" | tr '\n' ' ')
  fi

  REJECT_STR=""
  if [ "$N_REJECTED" -gt 0 ]; then
    REJECT_STR=$(printf '  - %s\n' "${REJECTED_LIST[@]}")
  fi

  ACK_MSG="Memory promotion result:
Promoted: $N_PROMOTED
${PROMO_STR:+IDs: $PROMO_STR
}Rejected: $N_REJECTED
${REJECT_STR:-}"

  log "sending ack: promoted=$N_PROMOTED rejected=$N_REJECTED"
  curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${ACK_MSG}" >> "$LOG" 2>&1
fi

# Atomically update offset to max_update_id + 1 (so we don't reprocess)
NEW_OFFSET=$((MAX_UPDATE_ID + 1))
TMPFILE=$(mktemp "$STATE_DIR/.last_update_id.XXXXXX")
echo "$NEW_OFFSET" > "$TMPFILE"
mv "$TMPFILE" "$STATE_FILE"

log "poll complete: promoted=$N_PROMOTED rejected=$N_REJECTED new_offset=$NEW_OFFSET"
exit 0
