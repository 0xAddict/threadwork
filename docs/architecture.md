# Architecture

## Overview

Threadwork is a harness that runs multiple Claude Code instances as named agents in persistent tmux sessions. Each agent:

- Has its own Telegram bot identity (personality, chat access)
- Shares a SQLite task board with all other agents
- Can nudge other agents awake via tmux
- Posts status updates to a shared Telegram group

## Layers

### 1. Boot Layer (macOS LaunchAgent)

A LaunchAgent plist triggers `launch-all.sh` on login and every 300 seconds. The script is idempotent — it only launches sessions that don't exist yet.

### 2. Session Layer (tmux + telegram-pool.sh)

Each tmux session runs `telegram-pool.sh`, which:
- Acquires an unused bot token from the pool using SHA256-based file locks
- Parses the agent's `.conf` file for custom CLI flags
- Sets `AGENT_LABEL` and `TELEGRAM_BOT_TOKEN` as env vars
- Execs `claude` with Telegram channel + task-board MCP

The `exec` replaces the shell — when Claude exits, the tmux session ends, and the LaunchAgent restarts it within 5 minutes.

### 3. Coordination Layer (task-board MCP)

A shared MCP server backed by SQLite (WAL mode). Every agent connects to the same DB file. Tools:

| Tool | Effect |
|------|--------|
| `create_task` | Insert task + nudge target agent + post to Telegram group |
| `claim_task` | Atomic status update (pending → in_progress) with agent check |
| `complete_task` | Set result + nudge creator + post to group |
| `list_tasks` | Query by assignee or status |
| `send_note` | Append note to task + post to group |
| `nudge_agent` | `tmux send-keys` to target session |

### 4. Communication Layer (Telegram)

Each agent has a dedicated Telegram bot. The Telegram plugin (`plugin:telegram@claude-plugins-official`) handles inbound/outbound messaging. Access is controlled by `access.json` (allowlist-based DM policy, group mention requirements).

## Data Flow: Task Creation

```
Agent A calls create_task(to="steve", description="...")
  │
  ├─→ SQLite INSERT INTO tasks ... RETURNING *
  │
  ├─→ nudgeAgent("steve", "You have a new task (#N) from ...")
  │     └─→ Bun.spawn(["tmux", "send-keys", "-t", "claude-steve", message, "Enter"])
  │
  └─→ postToGroup(formatTaskCreated(task))
        └─→ fetch("https://api.telegram.org/bot.../sendMessage", { chat_id, text })
```

## Concurrency Model

- **SQLite WAL mode** allows concurrent reads across agents. Writes are serialized by SQLite's internal locking with a 5-second busy timeout.
- **Atomic claims** use `UPDATE ... WHERE status = 'pending' AND to_agent = ? RETURNING *` — only the first agent to claim succeeds.
- **Lock files** use PID-based liveness checks. If a process dies without cleanup, the next boot cycle detects the stale lock.

## File Layout (Deployed)

```
~/.claude/
├── launch-all.sh          → threadwork/scripts/launch-all.sh
├── telegram-pool.sh       → threadwork/scripts/telegram-pool.sh
├── bots/
│   ├── boss.conf          → threadwork/bots/boss.conf
│   ├── steve.conf         → threadwork/bots/steve.conf
│   ├── sadie.conf         → threadwork/bots/sadie.conf
│   └── kiera.conf         → threadwork/bots/kiera.conf
├── channels/telegram/
│   ├── access.json        (not symlinked — contains secrets)
│   ├── .env               (not symlinked — contains secrets)
│   └── locks/             (runtime, not tracked)
└── mcp-servers/task-board/
    ├── server.ts          → threadwork/mcp-servers/task-board/server.ts
    ├── db.ts              → ...
    ├── config.ts          → ...
    ├── notify.ts          → ...
    ├── nudge.ts           → ...
    ├── mcp.json           → ...
    └── tasks.db           (runtime, not tracked)
```

Arrows indicate symlinks. The repo is the source of truth; `~/.claude/` is the runtime layout.
