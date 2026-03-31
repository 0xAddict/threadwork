#!/bin/zsh
# install.sh — Symlink threadwork repo files into ~/.claude/ for live deployment
# Usage: ./scripts/install.sh

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "threadwork install"
echo "  repo:   $REPO_DIR"
echo "  target: $CLAUDE_DIR"
echo ""

# ─── Helper ──────────────────────────────────────────────────────────────────
link() {
  local src="$1"
  local dst="$2"

  if [[ -L "$dst" ]]; then
    # Already a symlink — update it
    rm "$dst"
  elif [[ -f "$dst" ]]; then
    # Existing real file — back it up
    echo "  backup: $dst → ${dst}.bak"
    mv "$dst" "${dst}.bak"
  fi

  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  echo "  link:   $dst → $src"
}

# ─── Scripts ─────────────────────────────────────────────────────────────────
echo "Scripts:"
link "$REPO_DIR/scripts/launch-all.sh" "$CLAUDE_DIR/launch-all.sh"
link "$REPO_DIR/scripts/telegram-pool.sh" "$CLAUDE_DIR/telegram-pool.sh"
chmod +x "$REPO_DIR/scripts/launch-all.sh" "$REPO_DIR/scripts/telegram-pool.sh"

# ─── Bot Configs ─────────────────────────────────────────────────────────────
echo ""
echo "Bot configs:"
mkdir -p "$CLAUDE_DIR/bots"
for conf in "$REPO_DIR"/bots/*.conf; do
  name="$(basename "$conf")"
  link "$conf" "$CLAUDE_DIR/bots/$name"
done

# ─── Task Board MCP ─────────────────────────────────────────────────────────
echo ""
echo "Task board MCP:"
mkdir -p "$CLAUDE_DIR/mcp-servers/task-board/tests"

for f in server.ts db.ts config.ts notify.ts nudge.ts package.json; do
  link "$REPO_DIR/mcp-servers/task-board/$f" "$CLAUDE_DIR/mcp-servers/task-board/$f"
done

for f in "$REPO_DIR"/mcp-servers/task-board/tests/*.ts; do
  name="$(basename "$f")"
  link "$f" "$CLAUDE_DIR/mcp-servers/task-board/tests/$name"
done

# Generate mcp.json with resolved path
echo ""
echo "MCP config:"
MCP_JSON="$CLAUDE_DIR/mcp-servers/task-board/mcp.json"
cat > "$MCP_JSON" <<MCPEOF
{
  "mcpServers": {
    "task-board": {
      "command": "bun",
      "args": ["run", "$CLAUDE_DIR/mcp-servers/task-board/server.ts"]
    }
  }
}
MCPEOF
echo "  wrote:  $MCP_JSON (resolved path)"

# ─── Install dependencies ───────────────────────────────────────────────────
echo ""
echo "Dependencies:"
if command -v bun &>/dev/null; then
  (cd "$CLAUDE_DIR/mcp-servers/task-board" && bun install --frozen-lockfile 2>/dev/null || bun install)
  echo "  bun install: done"
else
  echo "  WARNING: bun not found. Run 'cd ~/.claude/mcp-servers/task-board && bun install' manually."
fi

# ─── Telegram channel dirs ──────────────────────────────────────────────────
echo ""
echo "Telegram channel:"
mkdir -p "$CLAUDE_DIR/channels/telegram/locks"
mkdir -p "$CLAUDE_DIR/channels/telegram/inbox"

if [[ ! -f "$CLAUDE_DIR/channels/telegram/access.json" ]]; then
  cp "$REPO_DIR/templates/access.json.example" "$CLAUDE_DIR/channels/telegram/access.json"
  echo "  created: access.json (from template — edit with your IDs)"
else
  echo "  exists:  access.json (not overwritten)"
fi

# ─── LaunchAgent ─────────────────────────────────────────────────────────────
echo ""
echo "LaunchAgent:"
PLIST_SRC="$REPO_DIR/templates/com.threadwork.agents.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.threadwork.agents.plist"

if [[ -f "$PLIST_DST" ]]; then
  echo "  exists:  $PLIST_DST (not overwritten)"
  echo "  to update: launchctl unload $PLIST_DST && rm $PLIST_DST && rerun install"
else
  sed -e "s|THREADWORK_ROOT|$CLAUDE_DIR|g" \
      -e "s|HOME_DIR|$HOME|g" \
      "$PLIST_SRC" > "$PLIST_DST"
  echo "  wrote:  $PLIST_DST"
  echo "  run:    launchctl load $PLIST_DST"
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "Install complete."
echo ""
echo "Next steps:"
echo "  1. Edit scripts/telegram-pool.sh with your bot tokens"
echo "  2. Edit ~/.claude/channels/telegram/access.json with your Telegram user IDs"
echo "  3. Set TELEGRAM_GROUP_ID in mcp-servers/task-board/config.ts"
echo "  4. launchctl load ~/Library/LaunchAgents/com.threadwork.agents.plist"
