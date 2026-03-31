# Task Board MCP Server

## Overview

An MCP server that gives Claude Code agents a shared task board backed by SQLite. Agents create, claim, complete, and comment on tasks. Status updates are broadcast to a Telegram group and target agents are nudged via tmux.

## Tools

### create_task

Creates a task and assigns it to another agent.

```typescript
{
  to: string          // Target agent label
  description: string // What needs to be done
  priority?: string   // "low" | "normal" | "high" | "urgent" (default: "normal")
}
```

**Side effects:** Nudges target agent via tmux. Posts to Telegram group.

### claim_task

Atomically claims a pending task. Only succeeds if:
- Task exists
- Task status is `pending`
- Task is assigned to the calling agent

```typescript
{
  task_id: number
}
```

**Atomicity:** Uses `UPDATE ... WHERE status = 'pending' AND to_agent = ? RETURNING *`. No double-claims.

### complete_task

Marks a task as completed with a result summary.

```typescript
{
  task_id: number
  result: string    // Summary of what was done
}
```

**Side effects:** Nudges the task creator. Posts to Telegram group.

### list_tasks

Query tasks by filter.

```typescript
{
  filter?: string   // "mine" | "pending" | "in_progress" | "completed" | "all" (default: "mine")
}
```

`"mine"` filters by `to_agent = SELF_LABEL`. Others filter by status.

### send_note

Adds a comment to a task.

```typescript
{
  task_id: number
  message: string
}
```

**Side effects:** Posts to Telegram group.

### nudge_agent

Sends a message to another agent's tmux session without creating a task.

```typescript
{
  agent: string     // Target agent label
  message: string
}
```

**Mechanism:** `tmux send-keys -t claude-{agent} {message} Enter`

## Memory Tools

### save_memory

Save a persistent memory for the current agent.

```typescript
{
  content: string      // The memory content
  category: string     // "learning" | "preference" | "fact" | "role"
  importance?: number  // 1-5 (default: 3)
  pinned?: boolean     // Prevent decay (default: false)
}
```

### recall_memories

Search personal + shared memories. Boosts importance of accessed memories.

```typescript
{
  query?: string       // LIKE search on content
  category?: string    // Filter by category
  limit?: number       // Default: 10
}
```

### get_boot_briefing

Returns tiered boot summary: role, top 5 memories, shared knowledge, recent tasks. Does not update access tracking.

```typescript
{}  // No parameters
```

### promote_memory

Promote a personal memory to shared (all agents see it).

```typescript
{
  memory_id: number
}
```

### pin_memory

Toggle pin status. Pinned memories never decay.

```typescript
{
  memory_id: number
}
```

## Database Schema

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | in_progress | completed | cancelled
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT
);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  from_agent TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,                              -- owner or 'shared'
  content TEXT NOT NULL,
  category TEXT NOT NULL,                           -- learning, preference, fact, task_summary, role
  importance INTEGER NOT NULL DEFAULT 3,            -- 1-5
  pinned INTEGER NOT NULL DEFAULT 0,                -- 1 = never decays
  source_task_id INTEGER REFERENCES tasks(id),      -- if auto-extracted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memory_archive (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  importance INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  source_task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  last_accessed TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**SQLite pragmas:**
- `journal_mode=WAL` — concurrent reads across agents
- `busy_timeout=5000` — wait up to 5s for write lock

**Location:** `~/.claude/mcp-servers/task-board/tasks.db`

## Configuration

`config.ts` reads from environment:

| Env Var | Purpose | Set By |
|---------|---------|--------|
| `AGENT_LABEL` | Identifies the calling agent | `telegram-pool.sh` |
| `TELEGRAM_BOT_TOKEN` | Used for group notifications | `telegram-pool.sh` |
| `TELEGRAM_GROUP_ID` | Target group for status posts | `config.ts` default or env |

## Agent Session Map

```typescript
{
  boss:  'claude-boss',
  steve: 'claude-steve',
  sadie: 'claude-sadie',
  kiera: 'claude-kiera',
}
```

Used by `nudge_agent` to resolve labels to tmux session names.

## MCP Config

`mcp.json` — loaded by each agent via `--mcp-config`:

```json
{
  "mcpServers": {
    "task-board": {
      "command": "bun",
      "args": ["run", "/path/to/task-board/server.ts"]
    }
  }
}
```

## Tests

```bash
cd mcp-servers/task-board
bun test
```

29 tests across 6 files:
- `db.test.ts` — task CRUD operations, atomic claims, filters
- `nudge.test.ts` — session resolution, command building
- `notify.test.ts` — message formatting
- `integration.test.ts` — full task lifecycle, concurrent multi-agent scenarios
- `memory.test.ts` — memory CRUD, search, access tracking, boot briefing
- `consolidate.test.ts` — decay, archive, prune, briefing generation
