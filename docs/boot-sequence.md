# Boot Sequence

## LaunchAgent

**File:** `templates/com.threadwork.agents.plist`

Registered at `~/Library/LaunchAgents/com.threadwork.agents.plist`. Triggers on:
- `RunAtLoad: true` — fires on user login
- `StartInterval: 300` — re-checks every 5 minutes (heals crashed sessions)

Runs `/bin/zsh -l launch-all.sh` with explicit PATH (bun, local bins, system bins) and HOME set.

### Manual control

```bash
# Load (register + run)
launchctl load ~/Library/LaunchAgents/com.threadwork.agents.plist

# Unload (stop monitoring)
launchctl unload ~/Library/LaunchAgents/com.threadwork.agents.plist

# Force immediate run
~/.claude/launch-all.sh
```

## launch-all.sh

**File:** `scripts/launch-all.sh`

### Sequence

1. **Network wait** — polls `https://api.telegram.org` up to 30 times (2s apart). Blocks until Telegram API is reachable. This handles cold boot where Wi-Fi isn't ready yet.

2. **Stale lock cleanup** — iterates `~/.claude/channels/telegram/locks/*.lock`. Each lock contains either a PID or `"EXTERNAL"`. PIDs are checked with `kill -0`; dead PIDs get their lock files removed. `EXTERNAL` locks survive (used for manual bot reservation).

3. **Session launch** — for each session name in `SESSION_NAMES`:
   - Skip if `tmux has-session -t $session` succeeds (already running)
   - `tmux new-session -d -s $session` — create detached session
   - `tmux send-keys` — source the pool script
   - Background subshell sends Enter after 6 seconds (auto-accepts Claude's workspace trust prompt)
   - 3-second sleep between sessions to prevent lock contention

### Configuration

```bash
SESSION_NAMES=(claude-boss claude-steve claude-sadie claude-kiera)
POOL_SCRIPT="$HOME/.claude/telegram-pool.sh"
TRUST_DELAY=6
```

To add or remove agents, edit `SESSION_NAMES`. Each name must have a corresponding bot entry in `telegram-pool.sh` and a `.conf` file in `bots/`.

### Failure modes

| Scenario | Behavior |
|----------|----------|
| No network after 60s | Script proceeds; Claude launches without Telegram |
| All bots locked | Agent launches without Telegram channel (fallback in pool script) |
| tmux not installed | `tmux new-session` fails silently; LaunchAgent retries in 5 min |
| Claude crashes | tmux session ends; next LaunchAgent cycle relaunches |

## Session Lifecycle

```
LaunchAgent (every 5 min)
  └─→ launch-all.sh
        └─→ tmux new-session -d -s claude-boss
              └─→ source telegram-pool.sh
                    └─→ exec claude [flags]    ← replaces shell
                          │
                          ├─ Agent runs...
                          │
                          └─ Exit (crash or /exit)
                               └─ tmux session ends
                                    └─ Lock file auto-released (trap)
                                         └─ Next LaunchAgent cycle recreates
```
