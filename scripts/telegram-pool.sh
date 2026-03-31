#!/bin/zsh
# telegram-pool.sh — Launch Claude Code with a free Telegram bot from the pool
# Usage: source ~/.claude/telegram-pool.sh (or via launch-all.sh)

# ─── Bot Pool ────────────────────────────────────────────────────────────────
# Format: "TOKEN|LABEL|CONFIG_FILE"
# CONFIG_FILE is optional — points to a per-bot MCP/settings config.
# If blank or missing, the bot launches with full default access.
#
# IMPORTANT: Populate this array with your own Telegram bot tokens.
# Create bots via @BotFather on Telegram.
BOTS=(
  "YOUR_BOT_TOKEN_1|Boss|$HOME/.claude/bots/boss.conf"
  "YOUR_BOT_TOKEN_2|Steve|$HOME/.claude/bots/steve.conf"
  "YOUR_BOT_TOKEN_3|Sadie|$HOME/.claude/bots/sadie.conf"
  "YOUR_BOT_TOKEN_4|Kiera|$HOME/.claude/bots/kiera.conf"
)

# ─── Config ──────────────────────────────────────────────────────────────────
LOCK_DIR="$HOME/.claude/channels/telegram/locks"
BASE_FLAGS=(--dangerously-skip-permissions --chrome)
CHANNEL_FLAGS=(--channels plugin:telegram@claude-plugins-official)

# ─── Lock Management ────────────────────────────────────────────────────────
mkdir -p "$LOCK_DIR"

is_locked() {
  local lockfile="$LOCK_DIR/$1.lock"
  if [[ ! -f "$lockfile" ]]; then
    return 1  # not locked
  fi
  local content
  content=$(<"$lockfile")
  # "EXTERNAL" means locked by something outside this pool (never stale)
  if [[ "$content" == "EXTERNAL" ]]; then
    return 0  # locked
  fi
  # Check if the PID in the lockfile is still running
  if kill -0 "$content" 2>/dev/null; then
    return 0  # locked and process alive
  else
    # Stale lock — clean it up
    rm -f "$lockfile"
    return 1  # not locked
  fi
}

acquire_lock() {
  local lockfile="$LOCK_DIR/$1.lock"
  echo "$$" > "$lockfile"
}

release_lock() {
  local lockfile="$LOCK_DIR/$1.lock"
  rm -f "$lockfile"
}

# ─── Parse Bot Config File ──────────────────────────────────────────────────
# Config files use simple KEY=VALUE format:
#   mcp_config=/path/to/mcp.json
#   settings=/path/to/settings.json
#   allowed_tools=Bash,Read,Edit
#   disallowed_tools=mcp__shopify__*
#   system_prompt=You are Steve, a helpful assistant.
#   append_system_prompt=Always be concise.
#   extra_flags=--effort max
parse_bot_flags() {
  local conf_file="$1"
  local -a flags=()

  if [[ ! -f "$conf_file" ]]; then
    return
  fi

  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    # Trim whitespace
    key="${key## }"; key="${key%% }"
    value="${value## }"; value="${value%% }"

    case "$key" in
      mcp_config)
        [[ -f "$value" ]] && flags+=(--mcp-config "$value")
        ;;
      strict_mcp_config)
        [[ "$value" == "true" ]] && flags+=(--strict-mcp-config)
        ;;
      settings)
        [[ -f "$value" ]] && flags+=(--settings "$value")
        ;;
      allowed_tools)
        flags+=(--allowedTools "$value")
        ;;
      disallowed_tools)
        flags+=(--disallowedTools "$value")
        ;;
      system_prompt)
        flags+=(--system-prompt "$value")
        ;;
      append_system_prompt)
        flags+=(--append-system-prompt "$value")
        ;;
      extra_flags)
        # Split on spaces for additional raw flags
        flags+=(${=value})
        ;;
    esac
  done < "$conf_file"

  echo "${flags[@]}"
}

# ─── Find a Free Bot ────────────────────────────────────────────────────────
CHOSEN_TOKEN=""
CHOSEN_LABEL=""
CHOSEN_ID=""
CHOSEN_CONF=""

for entry in "${BOTS[@]}"; do
  local token="${entry%%|*}"
  local rest="${entry#*|}"
  local label="${rest%%|*}"
  local conf="${rest#*|}"
  # Use a hash of the token as the lock ID (avoids special chars in filenames)
  local lock_id
  lock_id=$(echo -n "$token" | shasum -a 256 | cut -c1-12)

  if ! is_locked "$lock_id"; then
    CHOSEN_TOKEN="$token"
    CHOSEN_LABEL="$label"
    CHOSEN_ID="$lock_id"
    CHOSEN_CONF="$conf"
    break
  fi
done

# ─── Launch ──────────────────────────────────────────────────────────────────
if [[ -z "$CHOSEN_TOKEN" ]]; then
  echo "⚠  No free Telegram bots — launching Claude Code without Telegram channel."
  echo ""
  AGENT_LABEL="unknown" exec claude "${BASE_FLAGS[@]}" --mcp-config "$HOME/.claude/mcp-servers/task-board/mcp.json"
else
  acquire_lock "$CHOSEN_ID"

  # Clean up lock on exit (normal exit, interrupt, or termination)
  trap "release_lock '$CHOSEN_ID'" EXIT INT TERM HUP

  echo "✓  Using Telegram bot: $CHOSEN_LABEL"

  # Build per-bot flags from config file
  local -a bot_flags=()
  if [[ -n "$CHOSEN_CONF" && -f "$CHOSEN_CONF" ]]; then
    bot_flags=($(parse_bot_flags "$CHOSEN_CONF"))
    echo "  Config: $CHOSEN_CONF"
  fi
  echo ""

  # Send "I'm awake" message via Telegram Bot API
  ACCESS_FILE="$HOME/.claude/channels/telegram/access.json"
  if [[ -f "$ACCESS_FILE" ]]; then
    CHAT_IDS=($(python3 -c "
import json, sys
with open('$ACCESS_FILE') as f:
    data = json.load(f)
for uid in data.get('allowFrom', []):
    print(uid)
" 2>/dev/null))

    for chat_id in "${CHAT_IDS[@]}"; do
      curl -s -X POST "https://api.telegram.org/bot${CHOSEN_TOKEN}/sendMessage" \
        -d "chat_id=${chat_id}" \
        -d "text=👋 ${CHOSEN_LABEL} is awake and ready." \
        > /dev/null 2>&1 &
    done
  fi

  # Launch Claude Code with base flags + per-bot flags + channel
  TELEGRAM_BOT_TOKEN="$CHOSEN_TOKEN" AGENT_LABEL="${(L)CHOSEN_LABEL}" exec claude "${BASE_FLAGS[@]}" "${bot_flags[@]}" --mcp-config "$HOME/.claude/mcp-servers/task-board/mcp.json" "${CHANNEL_FLAGS[@]}"
fi
