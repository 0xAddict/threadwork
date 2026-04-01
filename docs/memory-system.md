# Memory System

## Overview

Each agent has persistent per-agent memory stored in SQLite (same database as the task board). Memories have importance scores that increase on access and decay over time. This layers on top of Claude Code's built-in auto-memory — the MCP handles agent-specific operational knowledge while native memory handles project-level context.

## MCP Tools

### save_memory

Save a memory for the current agent.

```typescript
{
  content: string      // The memory content
  category: string     // "learning" | "preference" | "fact" | "role"
  importance?: number  // 1-5 (default: 3). Higher = persists longer.
  pinned?: boolean     // Pin to prevent decay (default: false). Use for role definitions.
}
```

**Output:** `Memory #N saved (importance: N)`

### recall_memories

Search your memories and shared team knowledge.

```typescript
{
  query?: string       // Search term (LIKE match on content)
  category?: string    // Filter by category
  limit?: number       // Max results (default: 10)
}
```

**Side effects:** Each returned memory gets:
- `last_accessed` updated to now
- `access_count` incremented
- `importance` boosted by 1 (capped at 5)

### get_boot_briefing

Load your boot briefing on startup. Returns a tiered summary:
1. **Role** — pinned memories with category `role`
2. **Top memories** — 5 highest-importance personal memories
3. **Shared knowledge** — 5 highest-importance shared memories
4. **Recent tasks** — last 5 completed tasks

**Important:** Does NOT update access tracking. This prevents a feedback loop where boot-loaded memories always stay at max importance.

### promote_memory

Promote a personal memory to shared — all agents see it.

```typescript
{
  memory_id: number
}
```

Sets `agent = 'shared'` on the memory.

### pin_memory

Toggle pin on a memory. Pinned memories never decay.

```typescript
{
  memory_id: number
}
```

## Auto-Extraction

When `complete_task` is called, the MCP automatically creates a `task_summary` memory:

```
content: "Task #N: {description} → Result: {result}"
category: "task_summary"
importance: mapped from priority (low=1, normal=2, high=3, urgent=4)
```

No agent action required — happens inside the `complete_task` handler.

## Database Schema

```sql
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

Indexes: `agent`, `agent + importance DESC`, `category`, `archive.archived_at`

## Importance Scoring

Initial importance is set by the agent (1-5, default 3). It adjusts over time:

| Event | Effect |
|-------|--------|
| `recall_memories` returns it | +1 importance (capped at 5) |
| 7 days without access | -1 importance (non-pinned only) |
| Importance reaches 0 | Moved to `memory_archive` |
| Pinned | Never decays, regardless of access |

## Memory Lifecycle

```
Created (importance 3)
  ├─ Accessed regularly → importance rises to 5
  │    └─ Stays active indefinitely
  ├─ Pinned → never decays
  └─ Not accessed for 21 days → decays to 0
       └─ Archived
            ├─ Retained for 90 days (future RAG access)
            └─ Pruned after 90 days
```

## Nightly Consolidation

**Script:** `mcp-servers/task-board/consolidate.ts`
**Template:** `templates/com.threadwork.consolidate.plist`
**Schedule:** 3:00 AM daily via LaunchAgent

Steps:
1. **Decay** — for non-pinned memories where `last_accessed > 7 days`, reduce importance by 1 per 7-day period elapsed
2. **Archive** — move memories with `importance <= 0` to `memory_archive`
3. **Prune** — delete archived memories older than 90 days
4. **Briefings** — generate `briefings/{agent}.json` for each agent

No AI involved — pure math. Logs to `mcp-servers/task-board/consolidate.log`.

### Manual run

```bash
cd mcp-servers/task-board
bun run consolidate.ts
```

## Boot Integration

Two mechanisms ensure agents load their briefing on startup:

1. **MCP instructions** mention `get_boot_briefing` tool
2. **launch-all.sh** sends a tmux nudge 12 seconds after trust prompt:
   ```
   "Call get_boot_briefing to load your memory and context."
   ```

## Shared Memory

Shared memories use `agent = 'shared'` in the same table. All agents load shared memories in their boot briefing alongside personal ones. Use `promote_memory` to share a personal learning with all agents.

## Seeded Role Memories

On first install, run `seed-roles.ts` to create pinned role memories for all agents:

```bash
cd mcp-servers/task-board
bun run seed-roles.ts
```

This creates 2 pinned role memories per agent (8 total):
- **Boss:** CEO identity + team capabilities overview
- **Steve/Sadie/Kiera:** Worker identity + teammate awareness

These are pinned (never decay) and loaded first in every boot briefing. Re-running the script is safe — it skips existing memories.

To update a role, edit `seed-roles.ts` and re-run, or have the agent use `save_memory` with `category="role"` and `pinned=true`.

## Phase 2 (Future): Weekly Intelligent Review

Not yet implemented. Planned:
- Scheduled Claude Code session (Sunday 3am, `--print` mode)
- Reads week's task_summary memories across all agents
- Extracts patterns, creates cross-agent learnings
- Promotes shared insights automatically
- Posts weekly digest to Telegram group
