#!/bin/zsh
# telegram-typing-loop.sh — Background process that sends typing indicators
# Usage: telegram-typing-loop.sh <chat_id> <bot_token> [session_id]
# Runs until the flag file is removed or safety timeout (10 min)
# Session-scoped: flag file includes session_id so each session owns its loop.
# Placeholder message uses atomic mkdir lock so only one session sends it.

CHAT_ID="$1"
TOKEN="$2"
SESSION_ID="${3:-default}"
STATE_DIR="/tmp/telegram_typing"
FLAG_FILE="${STATE_DIR}/${CHAT_ID}.${SESSION_ID}.flag"
PLACEHOLDER_LOCK="${STATE_DIR}/${CHAT_ID}.placeholder.lock"
PLACEHOLDER_FILE="${STATE_DIR}/${CHAT_ID}.msgid"
START_TIME=$(date +%s)
SAFETY_TIMEOUT=600  # 10 minutes max
PLACEHOLDER_DELAY=6  # seconds before sending placeholder
OWNS_PLACEHOLDER=false

# Create session-scoped flag file
echo $$ > "$FLAG_FILE"

while [[ -f "$FLAG_FILE" ]]; do
  elapsed=$(( $(date +%s) - START_TIME ))

  # Safety timeout
  if (( elapsed > SAFETY_TIMEOUT )); then
    rm -f "$FLAG_FILE"
    break
  fi

  # Send typing indicator
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendChatAction" \
    -d "chat_id=${CHAT_ID}" -d "action=typing" > /dev/null 2>&1

  # Send placeholder after delay — atomic mkdir lock means only first session wins
  if [[ "$OWNS_PLACEHOLDER" == "false" ]] && (( elapsed >= PLACEHOLDER_DELAY )); then
    if mkdir "$PLACEHOLDER_LOCK" 2>/dev/null; then
      OWNS_PLACEHOLDER=true
      AGENT_NAME="${AGENT_LABEL:-agent}"
      response=$(curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=$(printf '\xF0\x9F\x94\x84') ${AGENT_NAME} is working on this...")
      msg_id=$(printf '%s\n' "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('message_id',''))" 2>/dev/null)
      if [[ -n "$msg_id" ]]; then
        echo "$msg_id" > "$PLACEHOLDER_FILE"
      fi
    fi
  fi

  # Update placeholder with elapsed time after 60s (every 30s) — only the owner
  if [[ "$OWNS_PLACEHOLDER" == "true" ]] && (( elapsed > 60 )) && (( elapsed % 30 < 5 )); then
    if [[ -f "$PLACEHOLDER_FILE" ]]; then
      msg_id=$(<"$PLACEHOLDER_FILE")
      mins=$(( elapsed / 60 ))
      secs=$(( elapsed % 60 ))
      curl -s -X POST "https://api.telegram.org/bot${TOKEN}/editMessageText" \
        -d "chat_id=${CHAT_ID}" \
        -d "message_id=${msg_id}" \
        -d "text=$(printf '\xF0\x9F\x94\x84') ${AGENT_NAME} is still working... (${mins}m ${secs}s)" > /dev/null 2>&1
    fi
  fi

  sleep 4
done

# Cleanup: if we own the placeholder lock, release it
if [[ "$OWNS_PLACEHOLDER" == "true" ]]; then
  rmdir "$PLACEHOLDER_LOCK" 2>/dev/null
fi
