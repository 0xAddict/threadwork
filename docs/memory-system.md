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

## DTC Memory Columns

The memory schema has been extended with Distributed Trust and Classification (DTC) columns. These are stored on the `memories` table alongside the existing fields.

### Classification

Every memory is assigned a classification tier that controls decay speed and behavior.

| Classification | Decay Window | Description |
|----------------|-------------|-------------|
| `foundational` | Never decays | Core truths, agent identity, structural facts |
| `strategic` | 14 days | Patterns, architectural decisions, team knowledge |
| `operational` | 7 days | Task learnings, how-to notes, current practices |
| `observational` | 3 days | Session summaries, recent events |
| `ephemeral` | 1 day | Temporary context, short-lived notes |

Classification is inferred from category if not provided:

| Category | Default Classification |
|----------|----------------------|
| `role` | foundational |
| `preference` | strategic |
| `fact` | operational |
| `learning` | operational |
| `task_summary` | observational |

Agent-submitted memories with classification `foundational` are created in `proposed` state instead of `active` (see State below).

### Quality Score

A float (0.0–1.0) representing confidence in the memory's accuracy.

| Value | Meaning |
|-------|---------|
| 0.0–0.29 | Low quality — excluded from boot briefings |
| 0.3–0.59 | Moderate quality — included in briefings |
| 0.6–0.79 | Good quality |
| 0.8–1.0 | High quality — decisions and promoted knowledge |

Default quality at creation: 0.5 (agent), 0.7–0.8 (system/debrief).

`recall_memories` sorts by `quality DESC, importance DESC` — higher quality memories surface first.

### State

Controls whether a memory is active, under review, or retired.

| State | Meaning |
|-------|---------|
| `active` | Normal operating state. Included in recall and briefings. |
| `proposed` | Awaiting validation. Agent-submitted foundational memories start here. |
| `disputed` | More challenges than supports. Decay window halved. |
| `superseded` | Replaced by a newer memory. Excluded from recall. Archived after 3 days. |

Superseded memories are never returned by `recall_memories` — they are filtered via `state != 'superseded'`.

### Challenge and Support Counts

`challenge_count` and `support_count` track how many agents have challenged or supported a memory. These affect state transitions:

- When `challenge_count > support_count`, state changes to `disputed`
- Disputed memories have their decay window halved (decay faster)
- Disputed memories with `quality < 0.3` have decay window halved again

### DTC Memory Tools

#### `challenge_memory`

Challenge a memory — increments `challenge_count`. If challenges exceed supports, memory transitions to `disputed` and quality drops by 0.2.

```typescript
{
  memory_id: number   // Required
  reason: string      // Required. Why this memory is being challenged.
}
```

#### `supersede_memory`

Replace an outdated memory with new content. Marks the old memory as `superseded` and creates a new `active` memory with a `supersedes_memory_id` lineage link.

```typescript
{
  old_memory_id: number  // Required
  new_content: string    // Required. The replacement content.
  reason: string         // Required. Why the supersession is happening.
}
```

The new memory inherits the old memory's `agent`, `category`, and `classification`. Both changes are logged to the audit trail.

#### `consolidate_memories`

Trigger a memory consolidation run. The 5-phase daemon (Orient, Gather, Validate, Consolidate, Prune) scans for stale, duplicate, and disputed memories and takes corrective action.

```typescript
{
  scope?: string       // "all" | "operational" | "agent:NAME" (default: "all")
  dry_run?: boolean    // Log proposed changes without executing (default: true)
  max_changes?: number // Maximum mutations per run (default: 50)
}
```

**Phases:**
1. **Orient** — get health report (counts, dispute rate, avg quality)
2. **Gather** — identify signals: stale memories, duplicates, disputed memories, clusters
3. **Validate** — score candidate actions by confidence; discard below 0.6 threshold
4. **Consolidate** — execute validated mutations (challenge, supersede, merge)
5. **Prune** — run decay, archive zero-importance memories, prune archive older than 90 days

**Triggers that fire automatically** (all must pass):
- Time gate: 6+ hours since last run
- Volume gate: >25 new memories OR >15% dispute rate in last 6 hours
- Idle gate: no `task_status_events` in 45 minutes
- Lock gate: no consolidation lock held

#### `get_memory_health_report`

Get current memory system stats. No parameters.

**Returns:**

| Field | Description |
|-------|-------------|
| `totalActive` | Count of non-superseded memories |
| `byClassification` | Map of classification → count (active only) |
| `byState` | Map of state → count (all memories) |
| `disputeRate` | disputed / total (non-superseded) |
| `avgQuality` | Average quality score |
| `lastRunAt` | Timestamp of last consolidation run |
| `lastRunMutations` | Mutation count from last run |

Use this to gauge memory health before triggering consolidation. A dispute rate above 0.15 or average quality below 0.4 warrants a consolidation run.

## Updated Schema

The `memories` table now includes these additional columns:

```sql
classification TEXT NOT NULL DEFAULT 'operational',  -- foundational, strategic, operational, observational, ephemeral
quality REAL NOT NULL DEFAULT 0.5,                   -- 0.0-1.0
state TEXT NOT NULL DEFAULT 'active',                -- proposed, active, disputed, superseded
source_type TEXT NOT NULL DEFAULT 'agent',           -- human, agent, consolidation, system
evidence TEXT,                                       -- JSON string of supporting references
support_count INTEGER NOT NULL DEFAULT 0,
challenge_count INTEGER NOT NULL DEFAULT 0,
supersedes_memory_id INTEGER REFERENCES memories(id),
last_validated TEXT NOT NULL DEFAULT (datetime('now'))
```

## Phase 2 (Future): Weekly Intelligent Review

Not yet implemented. Planned:
- Scheduled Claude Code session (Sunday 3am, `--print` mode)
- Reads week's task_summary memories across all agents
- Extracts patterns, creates cross-agent learnings
- Promotes shared insights automatically
- Posts weekly digest to Telegram group
