#!/bin/zsh
# telegram-typing-stop.sh — PostToolUse hook
# Reads JSON from stdin, extracts chat_id and session_id from tool context,
# kills THIS session's typing loop and cleans up the placeholder message.
# Matcher in settings.json filters to telegram reply tool only.

STATE_DIR="/tmp/telegram_typing"

# Read stdin JSON
INPUT=$(cat)

# Extract chat_id and session_id (printf prevents zsh echo from interpreting \n)
eval "$(printf '%s\n' "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
print('CHAT_ID=' + repr(str(ti.get('chat_id', ''))))
print('SESSION_ID=' + repr(d.get('session_id', '')))
" 2>/dev/null)"

if [[ -z "$CHAT_ID" || -z "$SESSION_ID" ]]; then
  exit 0
fi

# Kill this session's typing loop
FLAG="${STATE_DIR}/${CHAT_ID}.${SESSION_ID}.flag"
if [[ -f "$FLAG" ]]; then
  pid=$(cat "$FLAG" 2>/dev/null)
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null
  fi
  rm -f "$FLAG"
fi

# Delete placeholder message if it exists
PLACEHOLDER_FILE="${STATE_DIR}/${CHAT_ID}.msgid"
PLACEHOLDER_LOCK="${STATE_DIR}/${CHAT_ID}.placeholder.lock"
if [[ -f "$PLACEHOLDER_FILE" ]] && [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
  msg_id=$(<"$PLACEHOLDER_FILE")
  if [[ -n "$msg_id" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage" \
      -d "chat_id=${CHAT_ID}" -d "message_id=${msg_id}" > /dev/null 2>&1 &
  fi
  rm -f "$PLACEHOLDER_FILE"
fi
rmdir "$PLACEHOLDER_LOCK" 2>/dev/null

# Also kill any OTHER stale sessions' loops for this chat (cleanup)
for flag in "${STATE_DIR}/${CHAT_ID}".*.flag(N); do
  [[ -f "$flag" ]] || continue
  pid=$(cat "$flag" 2>/dev/null)
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null
  fi
  rm -f "$flag"
done

exit 0
