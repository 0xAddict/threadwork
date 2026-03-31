# Telegram Bot Pool

## Overview

`telegram-pool.sh` allocates one Telegram bot per Claude Code session. Each bot is a distinct identity with its own token, label, and optional configuration.

## Bot Pool Format

```bash
BOTS=(
  "TOKEN|LABEL|CONFIG_FILE"
  "TOKEN|LABEL|CONFIG_FILE"
  ...
)
```

- **TOKEN** — Telegram bot token from @BotFather
- **LABEL** — Human-readable name (used as `AGENT_LABEL` env var, lowercased)
- **CONFIG_FILE** — Path to `.conf` file with per-agent CLI flags

## Lock Mechanism

Locks prevent two sessions from claiming the same bot.

**Lock ID:** First 12 characters of `SHA256(token)`. Stored at `~/.claude/channels/telegram/locks/{lock_id}.lock`.

**Lock contents:**
| Value | Meaning |
|-------|---------|
| PID (e.g., `48530`) | Locked by running process. Checked with `kill -0`. |
| `EXTERNAL` | Reserved manually. Never auto-cleaned. |

**Lifecycle:**
```
Session starts → acquire_lock (writes PID)
Session exits  → release_lock (trap on EXIT/INT/TERM/HUP)
Next boot      → stale lock cleanup (dead PID → delete)
```

To manually reserve a bot (e.g., for testing from another terminal):
```bash
LOCK_ID=$(echo -n "YOUR_BOT_TOKEN" | shasum -a 256 | cut -c1-12)
echo "EXTERNAL" > ~/.claude/channels/telegram/locks/${LOCK_ID}.lock
```

## Per-Agent Config

**File:** `bots/{agent}.conf`

Simple `KEY=VALUE` format. Comments (`#`) and blank lines are ignored.

| Key | Claude CLI Flag | Example |
|-----|----------------|---------|
| `mcp_config` | `--mcp-config PATH` | `mcp_config=/path/to/custom-mcp.json` |
| `strict_mcp_config` | `--strict-mcp-config` | `strict_mcp_config=true` |
| `settings` | `--settings PATH` | `settings=/path/to/settings.json` |
| `allowed_tools` | `--allowedTools LIST` | `allowed_tools=Bash,Read,Edit` |
| `disallowed_tools` | `--disallowedTools LIST` | `disallowed_tools=mcp__shopify__*` |
| `system_prompt` | `--system-prompt TEXT` | `system_prompt=You are Steve, CTO.` |
| `append_system_prompt` | `--append-system-prompt TEXT` | `append_system_prompt=Always be concise.` |
| `extra_flags` | Raw flags (space-split) | `extra_flags=--effort max` |

Config file is optional. If missing or empty, the agent launches with full default access.

## Launch Flow

```
telegram-pool.sh
  │
  ├─ Iterate BOTS array
  │    └─ Hash token → check lock → skip if locked
  │
  ├─ Acquire lock (write PID)
  │
  ├─ Set trap for lock cleanup
  │
  ├─ Parse .conf file → build CLI flags array
  │
  ├─ Send "I'm awake" to all allowlisted Telegram users (async, best-effort)
  │
  └─ exec claude \
       --dangerously-skip-permissions \
       --chrome \
       [per-bot flags] \
       --mcp-config task-board/mcp.json \
       --channels plugin:telegram@claude-plugins-official
```

The `exec` replaces the shell process. Environment variables `TELEGRAM_BOT_TOKEN` and `AGENT_LABEL` are set inline.

## Fallback

If all bots are locked:
```bash
AGENT_LABEL="unknown" exec claude [BASE_FLAGS] --mcp-config task-board/mcp.json
```

No Telegram channel. The agent can still use the task board and tmux nudges but can't send/receive Telegram messages.
