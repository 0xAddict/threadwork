# Agent Memory System — Design Spec

**Date:** 2026-04-01
**Status:** Approved

## Overview

Per-agent memory system that layers on top of Claude Code's built-in auto-memory. The MCP handles agent-specific operational knowledge (learnings, task summaries, preferences). Claude's native memory stays for project-level context.

## Decisions

- **Architecture:** Extend existing task-board MCP (same DB, same server, new modules)
- **Memory creation:** Auto-extract on task completion + manual save_memory tool
- **Importance scoring:** Agent assigns initial score (1-5), access patterns adjust over time (+1 on access, capped at 5; -1 per 7 days unaccessed, floor at 0)
- **Boot loading:** Tiered — role/mandate (pinned) + top 5 memories + last 5 task summaries (~300-500 tokens)
- **Shared memory:** agent="shared" in same table, promote_memory tool to share
- **Decay lifecycle:** Active → decay if unaccessed 7 days → archive at importance 0 → prune at 90 days
- **Pinned memories:** Never decay (role definitions, critical learnings)
- **Consolidation:** Nightly cron for decay/archive/prune/briefing generation (no AI). Weekly intelligent review deferred to Phase 2.

## Data Model

New tables in existing tasks.db:

### memories

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK AUTO | |
| agent | TEXT NOT NULL | Owner: boss/steve/sadie/kiera/shared |
| content | TEXT NOT NULL | The memory text |
| category | TEXT NOT NULL | learning, preference, fact, task_summary, role |
| importance | INTEGER NOT NULL | 1-5 scale |
| pinned | INTEGER DEFAULT 0 | 1 = never decays |
| source_task_id | INTEGER NULL | FK to tasks(id) if auto-extracted |
| created_at | TEXT DEFAULT datetime('now') | |
| last_accessed | TEXT DEFAULT datetime('now') | |
| access_count | INTEGER DEFAULT 0 | |

Indexes: agent, agent+importance DESC, category

### memory_archive

Same columns as memories, plus:

| Column | Type | Description |
|--------|------|-------------|
| archived_at | TEXT DEFAULT datetime('now') | When it was archived |

## New MCP Tools

### save_memory

Save a memory for the current agent.

```
Input: {
  content: string (required),
  category: "learning" | "preference" | "fact" | "role" (required),
  importance: number 1-5 (default: 3),
  pinned: boolean (default: false)
}
Output: "Memory #{id} saved (importance: {n})"
```

### recall_memories

Search own memories + shared memories. Updates access tracking.

```
Input: {
  query: string (optional, SQLite LIKE search on content),
  category: string (optional filter),
  limit: number (default: 10)
}
Output: formatted list of matching memories
Side effect: each returned memory gets last_accessed updated, access_count +1, importance +1 (capped at 5)
```

### promote_memory

Move a memory from per-agent to shared (all agents see it).

```
Input: { memory_id: number }
Output: "Memory #{id} promoted to shared"
Side effect: sets agent="shared"
```

### pin_memory

Toggle pin status. Pinned memories never decay.

```
Input: { memory_id: number }
Output: "Memory #{id} pinned/unpinned"
```

### get_boot_briefing

Returns tiered boot summary for the current agent.

```
Input: none
Output: formatted briefing containing:
  1. Role/mandate (pinned memories with category="role")
  2. Top 5 highest-importance memories for this agent
  3. Shared memories (top 5 by importance)
  4. Last 5 completed task summaries from tasks table
```

Reads from pre-generated briefing JSON file if available (written by nightly consolidation). Falls back to live DB query if stale or missing.

**Important:** get_boot_briefing does NOT update access tracking (last_accessed, access_count, importance). Only recall_memories counts as an access. This prevents a feedback loop where boot-loaded memories always stay at max importance.

## Auto-Extraction on Task Completion

When `complete_task` is called, automatically insert a memory:

```
agent: SELF_LABEL
content: "Task #{id}: {description} -> Result: {result}"
category: "task_summary"
importance: mapped from priority (low=1, normal=2, high=3, urgent=4)
pinned: false
source_task_id: task.id
```

This happens inside the existing complete_task handler. No extra tool call needed.

## Nightly Consolidation

Standalone Bun script: `consolidate.ts`

Runs via LaunchAgent at 3am daily. No AI, pure math:

1. **Decay:** For every non-pinned memory where last_accessed > 7 days old, reduce importance by 1 per 7-day period elapsed since last access
2. **Archive:** Move memories with importance <= 0 to memory_archive
3. **Prune:** Delete archived memories with archived_at > 90 days
4. **Briefings:** Generate `briefings/{agent}.json` for each agent containing their tiered boot summary

LaunchAgent: `com.coachstokes.claude-consolidate.plist`
- StartCalendarInterval: Hour=3, Minute=0

## Boot Integration

Two mechanisms ensure agents load their briefing on startup:

1. MCP server instructions mention `get_boot_briefing` tool
2. `launch-all.sh` sends a tmux nudge after trust prompt acceptance:
   ```
   sleep $TRUST_DELAY && tmux send-keys Enter  # trust prompt
   sleep 10 && tmux send-keys "Call get_boot_briefing to load your memory." Enter
   ```

## Phase 2 (Deferred): Weekly Intelligent Review

Not built now. Future addition:
- Scheduled Claude Code session (Sunday 3am, --print mode)
- Reads week's task_summary memories across all agents
- Extracts patterns, creates "learning" memories
- Promotes cross-agent learnings to shared
- Merges duplicate memories
- Posts weekly digest to Telegram group
- Estimated cost: 5-10k tokens/week

## File Structure (new/modified files)

```
~/.claude/mcp-servers/task-board/
  memory.ts           — MemoryDB class (CRUD, search, decay logic)
  consolidate.ts      — standalone nightly script
  briefings/          — generated boot briefing JSONs per agent
  server.ts           — modified: add 5 new tools, auto-extract hook
  db.ts               — modified: add memory tables to migration
  tests/
    memory.test.ts    — memory CRUD and decay tests
    consolidate.test.ts — consolidation logic tests

~/Library/LaunchAgents/
  com.coachstokes.claude-consolidate.plist — nightly cron

~/.claude/
  launch-all.sh       — modified: add boot briefing nudge
```
