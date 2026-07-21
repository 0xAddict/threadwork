#!/bin/bash
# Launch wrapper for THE WATCHER (board-watcher).
#
# Why a wrapper: the production callback long-poll source
# (createProductionCallbackSource) is gated strictly on the WATCHER_BOT_TOKEN
# env var so it never collides with an agent grammY getUpdates stream. The
# launchd plist only knows WATCHER_BOT_TOKEN_FILE (a path), so this wrapper
# reads the token file into the env var at launch time, keeping the literal
# token out of the plist and out of git. Mirrors the heartbeat-v2 secrets.env
# sourcing pattern.
#
# It also pins the correct compiled entry point (dist/src/index.js).
set -euo pipefail

ROOT="/Users/coachstokes/threadwork-dashboard/board-watcher"
TOKEN_FILE="${WATCHER_BOT_TOKEN_FILE:-/Users/coachstokes/.secrets/watcher-bot-token}"

# node is managed by Volta (~/.volta/bin), which is not on the plist's static
# PATH. Put it first so `node` resolves, with an absolute fallback.
export PATH="/Users/coachstokes/.volta/bin:${PATH}"
NODE_BIN="$(command -v node || echo /Users/coachstokes/.volta/bin/node)"

if [[ -r "$TOKEN_FILE" ]]; then
  # Export the dedicated watcher bot token so the long-poll callback source
  # activates. Never echoed/logged.
  WATCHER_BOT_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  export WATCHER_BOT_TOKEN
fi

# Enable live tmux nudge to Boss on dispatch signals (#1789 follow-up).
# WATCHER_DISPATCH_ENABLED is deliberately absent — it stays OFF until #1603.
export WATCHER_TMUX_NOTIFY=1
# #2198 compliance: absolute tmux binary path — launchd daemons run with a
# minimal PATH that may not include ~/.local/bin. Never use bare 'tmux'.
export WATCHER_TMUX_BIN="/Users/coachstokes/.local/bin/tmux"

cd "$ROOT"
exec "$NODE_BIN" "$ROOT/dist/src/index.js"
