# threadwork

Multi-agent orchestration harness for Claude Code. Runs persistent Claude Code sessions as named agents, coordinated through a shared task board, structured decision-making, and Telegram.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  macOS LaunchAgents                                  │
│  com.threadwork.agents — boot + heal every 5 min     │
│  com.threadwork.consolidate — 3am nightly cleanup    │
│  com.threadwork.watchdog — process health monitor    │
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
    │  40 tools across 8 groups: │
    │                            │
    │  Tasks (7): create, dele-  │
    │    gate, claim, complete,  │
    │    list, send_note, nudge  │
    │  Delegation (4): spawn/    │
    │    close subagent, get     │
    │    children, interrupt     │
    │  Memory (9): save, recall, │
    │    briefing, promote, pin, │
    │    challenge, supersede,   │
    │    consolidate, health     │
    │  Status (3): write, read,  │
    │    clear                   │
    │  Decisions (6): open,      │
    │    submit, critique, list, │
    │    brief, finalize         │
    │  Blackboard (3): write/    │
    │    read findings, raw      │
    │  Artifacts (3): write      │
    │    artifact, report/get    │
    │    progress                │
    │  Governance (4): audit     │
    │    log, violations,        │
    │    hygiene, db_stats       │
    │  Debrief (1): force        │
    ├────────────────────────────┤
    │  Nudge: tmux send-keys     │
    │  Notify: Telegram Bot API  │
    │  Memory: per-agent +       │
    │    shared, importance       │
    │    decay, consolidation     │
    │  Decisions: multi-agent    │
    │    adversarial framework   │
    │  Debrief: post-task        │
    │    learning extraction     │
    └────────────────────────────┘
```

## Tools (40)

### Tasks (7)
| Tool | Description |
|------|-------------|
| `create_task` | Create a task and assign to an agent |
| `delegate_task` | Assign work with supervisor, heartbeat, and progress monitoring |
| `claim_task` | Claim a task before working on it |
| `complete_task` | Mark a task done with a result summary |
| `list_tasks` | List tasks (filterable by status, agent) |
| `send_note` | Add a progress note to a task |
| `nudge_agent` | Send a quick message to another agent via tmux |

### Delegation and Sub-Agents (4)
| Tool | Description |
|------|-------------|
| `spawn_subagent` | Register a durable sub-agent record before spawning |
| `close_subagent` | Close a sub-agent record after it returns |
| `get_children` | List child tasks and sub-agents for a parent task |
| `interrupt_agent` | Send Ctrl+C to a stuck agent's tmux session |

### Memory (9)
| Tool | Description |
|------|-------------|
| `save_memory` | Store a learning with category and importance |
| `recall_memories` | Search agent knowledge via embedding similarity |
| `get_boot_briefing` | Load role, top memories, and recent task history on startup |
| `promote_memory` | Share a memory with all agents |
| `pin_memory` | Pin critical knowledge so it never decays |
| `challenge_memory` | Flag a memory as potentially outdated or wrong |
| `supersede_memory` | Replace an old memory with an updated version |
| `consolidate_memories` | Merge related memories into a single refined entry |
| `get_memory_health_report` | Audit memory quality: duplicates, stale, low-importance |

### Status (3)
| Tool | Description |
|------|-------------|
| `write_status` | Sub-agents report progress (supports progress/blocked/eta) |
| `read_status` | Monitor loops check sub-agent progress |
| `clear_status` | Cleanup status after task completion |

### Decisions (6)
| Tool | Description |
|------|-------------|
| `open_decision` | Open a structured decision for multi-agent input |
| `submit_position` | Submit a position with reasoning on an open decision |
| `critique_position` | Critique another agent's position |
| `list_decisions` | List decisions (filterable by status) |
| `get_decision_brief` | Get full context for a decision including positions and critiques |
| `finalize_decision` | Boss-only: finalize a decision with outcome and rationale |

### Blackboard (3)
| Tool | Description |
|------|-------------|
| `write_finding` | Post a finding to the shared blackboard |
| `read_findings` | Read findings for a task or topic |
| `read_finding_raw` | Read the raw content of a specific finding |

### Artifacts and Progress (3)
| Tool | Description |
|------|-------------|
| `write_artifact` | Write a disk-persisted artifact linked to a task |
| `report_progress` | Record a durable progress event for a task |
| `get_progress` | Retrieve progress events for a task |

### Governance and Observability (4 + 1)
| Tool | Description |
|------|-------------|
| `query_audit_log` | Search the audit trail by agent, action, or task |
| `get_violations` | List governance violations |
| `run_hygiene` | Run hygiene checks across the system |
| `get_db_stats` | Database size, table counts, and health metrics |
| `force_debrief` | Trigger a post-task debrief for learning extraction |

## Components

| Component | File | Docs |
|-----------|------|------|
| MCP server (tool definitions + dispatch) | `server.ts` | [task-board.md](docs/task-board.md) |
| Database layer (SQLite WAL, all tables) | `db.ts` | [task-board.md](docs/task-board.md) |
| Memory system (save, recall, decay) | `memory.ts` | [memory-system.md](docs/memory-system.md) |
| Memory consolidator engine | `consolidator.ts` | [memory-system.md](docs/memory-system.md) |
| Nightly consolidation runner | `consolidate.ts` | [memory-system.md](docs/memory-system.md#nightly-consolidation) |
| Decision framework (adversarial) | `decision.ts` | [decision-framework.md](docs/decision-framework.md) |
| Agent debrief system | `debrief.ts` | [debrief-system.md](docs/debrief-system.md) |
| Supervision and delegation | `server.ts` (delegate_task) | [supervision-system.md](docs/supervision-system.md) |
| Bot pool management | `managed-bots.ts` | [telegram-pool.md](docs/telegram-pool.md) |
| Audit log | `audit.ts` | [task-board.md](docs/task-board.md#audit-log) |
| Configuration (paths, labels, sessions) | `config.ts` | -- |
| Telegram notifications | `notify.ts` | -- |
| Tmux nudge | `nudge.ts` | -- |
| Watchdog (process health) | `watchdog.ts` | [architecture.md](docs/architecture.md#5-watchdog-layer) |
| Snoopy bot (Telegram relay) | `snoopy-bot.ts` | -- |
| Role seeder | `seed-roles.ts` | [memory-system.md](docs/memory-system.md#seeded-role-memories) |
| Change application script | `apply_changes.sh` | -- |
| Boot orchestrator | `scripts/launch-all.sh` | [boot-sequence.md](docs/boot-sequence.md) |
| Bot pool allocator | `scripts/telegram-pool.sh` | [telegram-pool.md](docs/telegram-pool.md) |
| Telegram typing indicator | `scripts/telegram-typing-*.sh` | -- |
| Agent configs | `bots/*.conf` | [telegram-pool.md](docs/telegram-pool.md#per-agent-config) |
| LaunchAgent templates | `templates/com.threadwork.*.plist` | [boot-sequence.md](docs/boot-sequence.md#launchagent) |
| Agent briefings | `briefings/*.json` | [boot-sequence.md](docs/boot-sequence.md) |
| Agent operating manual | `CLAUDE.md` (deployed to `~/.claude/`) | [architecture.md](docs/architecture.md#6-onboarding-layer) |

## Prerequisites

- macOS (LaunchAgent-based boot)
- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) CLI
- [tmux](https://github.com/tmux/tmux)
- 1-4 Telegram bots (via [@BotFather](https://t.me/BotFather))

## Quick Start

```bash
git clone git@github.com:0xaddict/threadwork.git ~/threadwork
cd ~/threadwork

# Install dependencies
bun install

# Seed agent role memories (one-time)
bun run seed-roles.ts

# Configure your Telegram bot tokens
cp templates/.env.example .env
$EDITOR .env

# Edit telegram-pool.sh with your bot tokens
$EDITOR scripts/telegram-pool.sh

# Run the install script (creates symlinks into ~/.claude/)
./scripts/install.sh

# Load the LaunchAgents
launchctl load ~/Library/LaunchAgents/com.threadwork.agents.plist
launchctl load ~/Library/LaunchAgents/com.threadwork.consolidate.plist
launchctl load ~/Library/LaunchAgents/com.threadwork.watchdog.plist
```

## Tests

```bash
bun test
```

91 tests across 10 files.

## Docs

| Document | Description |
|----------|-------------|
| [architecture.md](docs/architecture.md) | System architecture and layers |
| [task-board.md](docs/task-board.md) | Task board MCP server reference |
| [memory-system.md](docs/memory-system.md) | Memory, decay, consolidation |
| [decision-framework.md](docs/decision-framework.md) | Multi-agent adversarial decision process |
| [debrief-system.md](docs/debrief-system.md) | Post-task debrief and learning extraction |
| [supervision-system.md](docs/supervision-system.md) | Delegation, heartbeats, progress monitoring |
| [boot-sequence.md](docs/boot-sequence.md) | LaunchAgent boot and session setup |
| [telegram-pool.md](docs/telegram-pool.md) | Telegram bot pool allocation |

## License

MIT
