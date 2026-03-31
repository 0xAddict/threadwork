# Memory System

## Current State

Each agent uses Claude Code's built-in auto-memory system, stored per-project at `~/.claude/projects/{path-hash}/memory/`. Memories are markdown files with YAML frontmatter (name, description, type) indexed in `MEMORY.md`.

Memory types: `user`, `feedback`, `project`, `reference`.

This is conversation-scoped — memories persist across conversations for the same project/working directory but are not agent-specific.

## Planned: Per-Agent Memory

Status: **Not yet implemented.** Design documented here for future reference.

### Design

New SQLite table in the task-board database:

```sql
CREATE TABLE agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,              -- agent label
  content TEXT NOT NULL,            -- the memory itself
  category TEXT NOT NULL,           -- 'learning', 'preference', 'context', 'skill'
  importance INTEGER NOT NULL DEFAULT 3,  -- 1-5 scale
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0,
  archived_at TEXT                  -- non-null = soft-deleted
);

CREATE INDEX idx_agent_memory_agent ON agent_memory(agent);
CREATE INDEX idx_agent_memory_importance ON agent_memory(importance);
```

### Importance Scoring

| Score | Meaning | Decay Rate | Example |
|-------|---------|------------|---------|
| 5 | Critical | Never decays | "Never push to main without PR" |
| 4 | Important | -1 per 14 days | "Boss prefers bundled PRs for refactors" |
| 3 | Normal | -1 per 7 days | "Used Veeqo API for inventory sync" |
| 2 | Low | -1 per 3 days | "Debugging session used port 3001" |
| 1 | Ephemeral | -1 per day | "Currently working on task #47" |

When importance reaches 0, the memory is archived (`archived_at` set). Archived memories are excluded from boot summaries but retained for potential RAG retrieval later.

### Memory Extraction

Triggered on `complete_task`. The completing agent evaluates:
- What worked? (0-2 learnings)
- What didn't work? (0-2 learnings)
- Any reusable context? (tools, APIs, patterns)

Stored as memories with category `learning` and initial importance 3.

### Boot Summary

On session start, the agent reads a condensed summary of its top memories:
1. Query `agent_memory WHERE agent = ? AND archived_at IS NULL ORDER BY importance DESC, last_accessed DESC LIMIT 20`
2. Format as a bulleted list grouped by category
3. Inject into the agent's system prompt via `append_system_prompt` in the `.conf` file

This keeps context usage minimal while giving the agent its most relevant memories.

### Nightly Consolidation (Future)

A cron job that runs overnight:
1. Decay importance scores based on time since last access
2. Archive memories that hit importance 0
3. Merge related memories (same category, similar content)
4. Generate a daily summary of completed tasks → store as a single `context` memory

### Cross-Agent Shared Memory (Future)

A separate table for memories all agents should know:
```sql
CREATE TABLE shared_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Loaded into every agent's boot summary.
