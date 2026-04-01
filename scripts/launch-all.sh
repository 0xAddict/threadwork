#!/bin/zsh
# launch-all.sh — Ensure all 4 Claude Code + Telegram tmux sessions are running
# Called on login via LaunchAgent, or manually: ~/.claude/launch-all.sh

SESSION_NAMES=(claude-boss claude-steve claude-sadie claude-kiera claude-snoopy)
POOL_SCRIPT="$HOME/.claude/telegram-pool.sh"
TRUST_DELAY=6  # seconds to wait for trust prompt to appear

# ─── Preflight ───────────────────────────────────────────────────────────────
# Wait for network (bots need Telegram API)
for i in {1..30}; do
  curl -s --max-time 3 https://api.telegram.org > /dev/null 2>&1 && break
  sleep 2
done

# Clear stale lockfiles (from previous boot)
LOCK_DIR="$HOME/.claude/channels/telegram/locks"
mkdir -p "$LOCK_DIR"
for lockfile in "$LOCK_DIR"/*.lock; do
  [[ -f "$lockfile" ]] || continue
  content=$(<"$lockfile")
  if [[ "$content" != "EXTERNAL" ]] && ! kill -0 "$content" 2>/dev/null; then
    rm -f "$lockfile"
  fi
done

# ─── Launch Missing Sessions ────────────────────────────────────────────────
launched=0

for session in "${SESSION_NAMES[@]}"; do
  # Skip if session already exists and has a running process
  if tmux has-session -t "$session" 2>/dev/null; then
    continue
  fi

  # Create session and run pool script
  tmux new-session -d -s "$session"
  tmux send-keys -t "$session" "source $POOL_SCRIPT" Enter

  # Auto-accept the workspace trust prompt, then load boot briefing
  (
    sleep $TRUST_DELAY
    tmux send-keys -t "$session" Enter 2>/dev/null
    sleep 12
    tmux send-keys -t "$session" "Call get_boot_briefing to load your memory and context. Then call list_tasks with filter='mine' to check for pending work. State your name, role, and current task status." Enter 2>/dev/null
  ) &

  launched=$((launched + 1))

  # Stagger launches so lockfiles don't race
  sleep 3
done

if [[ $launched -eq 0 ]]; then
  echo "All sessions already running."
else
  echo "Launched $launched session(s): ${SESSION_NAMES[*]}"
fi
