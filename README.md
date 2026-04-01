# threadwork

Multi-agent orchestration harness for Claude Code. Runs persistent Claude Code sessions as named agents, coordinated through a shared task board and Telegram.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  macOS LaunchAgents                                  │
│  com.threadwork.agents — boot + heal every 5 min     │
│  com.threadwork.consolidate — 3am nightly cleanup    │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│  launch-all.sh                                        │
│  - Waits for network                                  │
│  - Clears stale locks                                 │
│  - Creates 4 tmux sessions (staggered 3s apart)       │
│  - Auto-accepts trust prompt + loads boot briefing    │
│  - Each runs: source telegram-pool.sh                 │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│  telegram-pool.sh (per session)                       │
│  - Acquires SHA256-locked Telegram bot from pool      │
│  - Parses per-agent .conf for custom flags            │
│  - Sets AGENT_LABEL + TELEGRAM_BOT_TOKEN env vars     │
│  - exec claude --channels + --mcp-config task-board   │
└──────────────┬──────────────────────────────────────┘
               │
    ┌──────────┼──────────┬──────────┐
    ▼          ▼          ▼          ▼
 ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
 │ Boss │ │Steve │ │Sadie │ │Kiera │  ← Claude Code sessions in tmux
 └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘
    │        │        │        │
    └────────┴────┬───┴────────┘
                  │
    ┌─────────────┴─────────────┐
    │  task-board MCP server     │
    │  SQLite (WAL) shared DB    │
    │  12 tools:                 │
    │    Tasks: create, claim,   │
    │    complete, list, note,   │
    │    nudge                   │
    │    Memory: save, recall,   │
    │    briefing, promote, pin  │
    │    Audit: query log         │
    ├────────────────────────────┤
    │  Nudge: tmux send-keys     │
    │  Notify: Telegram Bot API  │
    │  Memory: per-agent +       │
    │  shared, importance decay  │
    └────────────────────────────┘
```

## Components

| Component | Location | Docs |
|-----------|----------|------|
| Boot orchestrator | `scripts/launch-all.sh` | [boot-sequence.md](docs/boot-sequence.md) |
| Bot pool allocator | `scripts/telegram-pool.sh` | [telegram-pool.md](docs/telegram-pool.md) |
| Task board MCP | `mcp-servers/task-board/` | [task-board.md](docs/task-board.md) |
| Agent configs | `bots/*.conf` | [telegram-pool.md](docs/telegram-pool.md#per-agent-config) |
| LaunchAgent template | `templates/com.threadwork.agents.plist` | [boot-sequence.md](docs/boot-sequence.md#launchagent) |
| Memory system | `mcp-servers/task-board/memory.ts` | [memory-system.md](docs/memory-system.md) |
| Nightly consolidation | `mcp-servers/task-board/consolidate.ts` | [memory-system.md](docs/memory-system.md#nightly-consolidation) |
| Consolidation LaunchAgent | `templates/com.threadwork.consolidate.plist` | [boot-sequence.md](docs/boot-sequence.md#consolidation-launchagent) |
| Audit log | `mcp-servers/task-board/audit.ts` | [task-board.md](docs/task-board.md#audit-log) |
| Watchdog | `mcp-servers/task-board/watchdog.ts` | [architecture.md](docs/architecture.md#5-watchdog-layer) |
| Watchdog LaunchAgent | `templates/com.threadwork.watchdog.plist` | [boot-sequence.md](docs/boot-sequence.md#watchdog-launchagent) |
| Agent operating manual | `CLAUDE.md` (deployed to `~/.claude/`) | [architecture.md](docs/architecture.md#6-onboarding-layer) |
| Role seeder | `mcp-servers/task-board/seed-roles.ts` | [memory-system.md](docs/memory-system.md#seeded-role-memories) |

## Prerequisites

- macOS (LaunchAgent-based boot)
- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) CLI
- [tmux](https://github.com/tmux/tmux)
- 1-4 Telegram bots (via [@BotFather](https://t.me/BotFather))

## Quick Start

```bash
git clone git@github.com:YOUR_USER/threadwork.git ~/threadwork
cd ~/threadwork

# Install task board dependencies
cd mcp-servers/task-board && bun install && cd ../..

# Seed agent role memories (one-time)
cd mcp-servers/task-board && bun run seed-roles.ts && cd ../..

# Edit telegram-pool.sh with your bot tokens
$EDITOR scripts/telegram-pool.sh

# Run the install script (creates symlinks into ~/.claude/)
./scripts/install.sh

# Load the LaunchAgent
launchctl load ~/Library/LaunchAgents/com.threadwork.agents.plist
```

## Tests

```bash
cd mcp-servers/task-board
bun test
```

41 tests across 8 files.

## License

MIT
