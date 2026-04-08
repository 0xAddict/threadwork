#!/bin/zsh
# telegram-typing-start.sh — UserPromptSubmit hook
# Reads JSON from stdin, checks if prompt contains a Telegram message,
# and starts a typing indicator loop if so.
# NOTE: UserPromptSubmit fires on EVERY prompt — we filter internally.
# Session-scoped: each Claude session manages its own loop. Multiple sessions
# sending typing to the same chat_id is harmless (Telegram deduplicates).

STATE_DIR="/tmp/telegram_typing"
SCRIPT_DIR="$(dirname "$0")"

mkdir -p "$STATE_DIR"

# Read stdin JSON
INPUT=$(cat)

# Extract session_id and prompt (printf prevents zsh echo from interpreting \n in JSON)
eval "$(printf '%s\n' "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('SESSION_ID=' + repr(d.get('session_id', '')))
print('PROMPT=' + repr(d.get('prompt', '')))
" 2>/dev/null)"

# Only act on Telegram messages
if ! echo "$PROMPT" | grep -q 'source="plugin:telegram:telegram"'; then
  exit 0
fi

# Extract chat_id from the channel tag in the prompt
CHAT_ID=$(echo "$PROMPT" | grep -o 'chat_id="[^"]*"' | head -1 | sed 's/chat_id="//;s/"//')
if [[ -z "$CHAT_ID" || -z "$SESSION_ID" ]]; then
  exit 0
fi

# Need bot token from environment
if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then
  exit 0
fi

# Session-scoped flag file — each session owns its own loop
FLAG="${STATE_DIR}/${CHAT_ID}.${SESSION_ID}.flag"

# If this session already has a live loop for this chat, skip
if [[ -f "$FLAG" ]]; then
  old_pid=$(cat "$FLAG" 2>/dev/null)
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    exit 0
  fi
  rm -f "$FLAG"
fi

# Send immediate typing indicator (don't wait for loop)
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction" \
  -d "chat_id=${CHAT_ID}" -d "action=typing" > /dev/null 2>&1 &

# Start background typing loop (session-scoped flag, shared placeholder lock)
nohup "$SCRIPT_DIR/telegram-typing-loop.sh" "$CHAT_ID" "$TELEGRAM_BOT_TOKEN" "$SESSION_ID" \
  > /dev/null 2>&1 &

exit 0
