# Observability, Watchdog & Agent Onboarding — Design Spec

**Date:** 2026-04-01
**Status:** Draft — awaiting approval

## Overview

Three interconnected additions to the threadwork system:
1. **Audit log** — every agent action logged with reasoning
2. **Watchdog** — detects stuck agents, escalates with backoff
3. **Agent onboarding** — CLAUDE.md universal manual + seeded role memories with boot self-check

## 1. Audit Log (Observability/Tracing)

### Purpose

Log every significant agent decision so you can trace what happened, when, why, and by whom. Queryable history of all agent activity.

### Data Model

New table in existing tasks.db:

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,                  -- JSON with context/reasoning
  task_id INTEGER,              -- FK if action relates to a task
  memory_id INTEGER,            -- FK if action relates to a memory
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_agent ON audit_log(agent);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_task ON audit_log(task_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
```

### Logged Actions

| Action | When | Detail contains |
|--------|------|-----------------|
| `task_created` | create_task called | `{ to, description, priority, task_id }` |
| `task_claimed` | claim_task called | `{ task_id }` |
| `task_completed` | complete_task called | `{ task_id, result }` |
| `task_failed` | task couldn't be claimed/completed | `{ task_id, reason }` |
| `note_added` | send_note called | `{ task_id, message }` |
| `agent_nudged` | nudge_agent called | `{ target, message }` |
| `memory_saved` | save_memory called | `{ memory_id, category, importance }` |
| `memory_recalled` | recall_memories called | `{ query, results_count }` |
| `memory_promoted` | promote_memory called | `{ memory_id }` |
| `memory_pinned` | pin_memory called | `{ memory_id, new_state }` |
| `boot_briefing` | get_boot_briefing called | `{ role_count, memory_count, task_count }` |
| `watchdog_nudge` | watchdog nudged a stuck agent | `{ task_id, minutes_stuck }` |
| `watchdog_escalation` | watchdog escalated to Boss | `{ task_id, reason }` |
| `escalation_received` | Boss received escalation | `{ from_agent, task_id }` |

### Implementation

New module: `audit.ts`

```typescript
export class AuditLog {
  constructor(db: Database) { ... }

  log(agent: string, action: string, detail?: object, taskId?: number, memoryId?: number): void

  query(filter: { agent?: string, action?: string, taskId?: number, since?: string, limit?: number }): AuditEntry[]

  getAgentActivity(agent: string, minutes: number): AuditEntry[]
}
```

Every tool handler in server.ts calls `audit.log()` after executing. The detail field captures reasoning — e.g., when a task is created, it logs the full delegation context.

### New MCP Tool

```
query_audit_log:
  Input: { agent?, action?, task_id?, since?, limit? }
  Output: formatted audit entries
```

This lets agents (especially Boss) review what other agents have been doing.

## 2. Watchdog (Stuck Detection & Escalation)

### Purpose

Detect agents that are stuck on tasks and escalate. Runs every 5 minutes via LaunchAgent.

### Logic

```
watchdog.ts — runs every 5 minutes:

1. STALE IN-PROGRESS TASKS
   SELECT * FROM tasks
   WHERE status = 'in_progress'
   AND claimed_at < datetime('now', '-10 minutes')

   For each:
   a. Check audit_log for activity by to_agent in last 10 minutes
   b. If active (has recent log entries): skip — agent is working, just slow
   c. If no activity:
      - Check nudge_count on task (new column)
      - nudge_count = 0: First nudge via tmux
        "Task #N has been in progress for X minutes with no activity. Status update? If blocked, use send_note to explain or escalate."
        Set nudge_count = 1
      - nudge_count = 1 (20 min): Second nudge
        "Task #N still stuck after 20 minutes. Escalating to Boss if no response in 10 minutes."
        Set nudge_count = 2
      - nudge_count >= 2 (30 min): Auto-escalate
        Create new task: from=watchdog, to=boss, description="ESCALATION: Task #N assigned to {agent} stuck for 30+ minutes. Original: {description}"
        Cancel original task
        Log escalation to audit_log

2. UNCLAIMED PENDING TASKS
   SELECT * FROM tasks
   WHERE status = 'pending'
   AND created_at < datetime('now', '-15 minutes')

   For each: re-nudge the assigned agent via tmux

3. DEAD AGENT DETECTION
   For each agent in AGENT_SESSIONS:
   - Check if tmux session exists: tmux has-session -t {session}
   - If dead: log to audit, post to Telegram group "{agent} session is dead"
```

### Task Schema Addition

Add to tasks table:

```sql
ALTER TABLE tasks ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0;
```

### LaunchAgent

`templates/com.threadwork.watchdog.plist` — StartInterval: 300 (5 minutes)

### Escalation Backoff Timeline

```
 0 min  — Task created, agent nudged (by create_task)
10 min  — Watchdog: first nudge (no activity detected)
20 min  — Watchdog: second nudge (warning)
30 min  — Watchdog: auto-escalate to Boss, cancel original
```

## 3. Agent Onboarding

### 3a. CLAUDE.md — Universal Operating Manual

Location: `~/.claude/CLAUDE.md` (auto-loaded by Claude Code)

Contents:

```markdown
# Threadwork Agent Operating Manual

You are a threadwork agent — one of a team of persistent Claude Code instances
coordinated through a shared task board and Telegram.

## Your Team

| Agent | Session | Role |
|-------|---------|------|
| Boss  | claude-boss  | CEO/Orchestrator — delegates work, makes tiebreaker decisions |
| Steve | claude-steve | General worker (role TBD) |
| Sadie | claude-sadie | General worker (role TBD) |
| Kiera | claude-kiera | General worker (role TBD) |

Boss assigns top-level tasks. Workers execute. Workers can signal each other
for data handoff or status updates but do NOT reassign Boss's priorities or
create new top-level tasks for each other.

## On Startup

1. Call `get_boot_briefing` to load your role, memories, and recent task history
2. Call `list_tasks` with filter="mine" to check for pending work
3. Confirm your identity: state your name, role, and current tasks

## Task Board Workflow

- `list_tasks(filter="mine")` — check your inbox
- `claim_task(task_id)` — claim before starting work
- `complete_task(task_id, result)` — always include a meaningful result summary
- `send_note(task_id, message)` — add progress updates, especially if work will take a while
- `create_task(to, description)` — only Boss creates top-level tasks. Workers can create subtasks for each other for bounded operations (data handoff, format check) but NOT new initiatives

## Memory

- `save_memory(content, category)` — save learnings after completing tasks
- `recall_memories(query)` — search your knowledge before starting new work
- `promote_memory(memory_id)` — share a learning with all agents
- `pin_memory(memory_id)` — pin critical knowledge so it never decays

## Communication

- **Agent → Agent:** Use `nudge_agent` for quick messages or `create_task` for work requests
- **Agent → Human:** Reply via Telegram (the plugin handles this)
- **Agent → Group:** Task board auto-posts to the team Telegram group on create/complete
- **Status updates:** Use `send_note` on your current task so the watchdog knows you're active

## Subagent Delegation

Spawn subagents (Agent tool) for complex work to keep your context clean.

**DO delegate:** Research, multi-file edits, analysis, code generation
**DO NOT delegate:** Simple lookups, formatting, 2-message tasks (just do them inline)

When spawning a subagent, specify the expected output format clearly.

## Escalation

If you're stuck:
1. Add a note to the task explaining what's blocking you
2. If you can't resolve it within 10 minutes, use `nudge_agent` to ask Boss for guidance
3. The watchdog monitors in-progress tasks — if you go silent for 10+ minutes it will nudge you

## DO NOT

- Do not create top-level tasks for other agents (only Boss does this)
- Do not ignore your task inbox — check `list_tasks(filter="mine")` regularly
- Do not work on tasks you haven't claimed
- Do not complete a task without a meaningful result summary
- Do not hold a task in_progress while idle — add a note or release it
- Do not spawn subagents for trivial tasks
- Do not override or reassign another agent's tasks
```

### 3b. Seeded Role Memories (Pinned)

Seed these on first boot via a setup script. Each agent gets:

**Boss:**
```
category: role, importance: 5, pinned: true
content: "You are Boss, the CEO and primary orchestrator of the threadwork agent team. You receive requests from the human (Stokes) and delegate work to Steve, Sadie, and Kiera. You make tiebreaker decisions when agents disagree or are blocked. You monitor team progress via list_tasks(filter='all') and query_audit_log. You keep your context clean by delegating all execution work — you plan, assign, and review."
```

```
category: role, importance: 5, pinned: true
content: "Team capabilities — Steve: general-purpose worker, full MCP access (Shopify, Gmail, Supabase, browser automation). Sadie: general-purpose worker, full MCP access. Kiera: general-purpose worker, full MCP access. All workers can spawn subagents for complex tasks. Roles will be specialized (CMO, CFO, CTO) in the future."
```

**Steve / Sadie / Kiera (each gets):**
```
category: role, importance: 5, pinned: true
content: "You are {name}, a worker agent on the threadwork team. You report to Boss, who assigns your tasks. You execute work by claiming tasks from the task board, spawning subagents for complex work, and completing tasks with clear result summaries. Save important learnings to memory after completing tasks. If stuck, add a note to your task and escalate to Boss."
```

```
category: role, importance: 5, pinned: true
content: "Your teammates — Boss (CEO, orchestrator, delegates work), {other1} (general worker), {other2} (general worker). You can nudge teammates for data handoff or status checks. Only Boss creates top-level task assignments."
```

### 3c. Boot Self-Check

Update the boot briefing nudge in launch-all.sh from:

```
"Call get_boot_briefing to load your memory and context."
```

To:

```
"Call get_boot_briefing to load your memory and context. Then call list_tasks with filter='mine' to check for pending work. State your name, role, and current task status."
```

This forces each agent to verify its identity and check its inbox on every boot.

## File Structure

```
~/.claude/mcp-servers/task-board/
  audit.ts                — NEW: AuditLog class
  watchdog.ts             — NEW: standalone watchdog script
  server.ts               — MODIFY: add audit logging to all tools, add query_audit_log tool
  db.ts                   — MODIFY: add audit_log table, nudge_count column
  tests/
    audit.test.ts         — NEW
    watchdog.test.ts      — NEW

~/.claude/
  CLAUDE.md               — NEW: universal operating manual

~/Library/LaunchAgents/
  com.threadwork.watchdog.plist — NEW: 5-minute watchdog

scripts/
  seed-roles.ts           — NEW: one-time script to seed role memories
```

## Spec Gate

- [ ] SG-1: audit_log table created with correct schema
- [ ] SG-2: Every tool call in server.ts logs to audit_log
- [ ] SG-3: query_audit_log tool returns filtered audit entries
- [ ] SG-4: Watchdog detects stale in-progress tasks (>10 min, no activity)
- [ ] SG-5: Watchdog nudges stuck agents via tmux with escalation backoff (10/20/30 min)
- [ ] SG-6: Watchdog auto-escalates to Boss after 30 minutes
- [ ] SG-7: Watchdog detects unclaimed pending tasks (>15 min) and re-nudges
- [ ] SG-8: Watchdog detects dead tmux sessions
- [ ] SG-9: Watchdog LaunchAgent runs every 5 minutes
- [ ] SG-10: CLAUDE.md written and deployed at ~/.claude/CLAUDE.md
- [ ] SG-11: Role memories seeded for all 4 agents (pinned, category=role)
- [ ] SG-12: Boot self-check: agents state name, role, and current tasks on startup
- [ ] SG-13: All tests pass
- [ ] SG-14: Live test: create task for agent, wait 10 min, watchdog nudges, agent responds
