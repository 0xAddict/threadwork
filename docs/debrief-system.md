# Session Debrief System

## Overview

The Session Debrief System automatically generates end-of-session reports when agent activity winds down. It collects completed tasks, blockers, new memories, and escalations across the whole team, synthesizes them into a structured report, persists a shared memory, and posts to the Telegram group.

Debriefs are triggered automatically by the watchdog every 30 seconds. Manual triggering is available via `force_debrief` (Boss only).

**Source:** `mcp-servers/task-board/debrief.ts`

## 3-Gate Triggering

All three gates must pass before a debrief fires. They are checked in order and all three must return true.

### Gate 1 — Idle Gate

The team must be idle for at least 15 minutes.

- No `task_status_events` with `status='working'` in the last 15 minutes
- No tasks currently in `in_progress` status

If any agent is actively working, this gate blocks the debrief until things settle.

### Gate 2 — Volume Gate

Enough activity must have accumulated since the last debrief. Passes if **any** of these are true:

| Condition | Threshold |
|-----------|-----------|
| Completed tasks since last debrief | >= 3 |
| New memories saved since last debrief | >= 5 |
| Hours since last debrief AND >= 1 completed task | >= 2 hours |

The time-based condition (2 hours + at least one task) ensures debriefs happen at least every 2 hours during active sessions even if the task/memory thresholds aren't hit.

### Gate 3 — Lock Gate

No debrief is currently running. Uses the `debrief_locks` table with a 10-minute TTL. Stale locks are cleaned before checking.

## 4-Phase Pipeline

When all gates pass, the debrief daemon runs four phases in sequence. If any phase fails, the error is recorded in `debrief_runs` and the lock is released.

### Phase 1 — Gather

Collects all activity since the last completed debrief:

- **Completed tasks** — `tasks WHERE status='completed' AND completed_at > last_debrief`
- **Blockers** — `task_status_events WHERE status='blocked'` since last debrief
- **New memories** — all memories created since last debrief
- **Escalations** — audit log entries matching `action LIKE '%escalat%'`

Also identifies which agents were active (agents who completed tasks or encountered blockers).

### Phase 2 — Solicit

Opens a decision record and auto-submits a position for each active agent. The position summarizes that agent's completed tasks, blockers, and memory saves.

This creates an auditable record of each agent's session contribution in the decision system.

### Phase 3 — Synthesize

Generates a structured text report and finalizes the decision record. Sections produced:

```
== WORK SUMMARY ==
{agent}: {N} tasks completed
  #{id}: {description}

== BLOCKERS ==
{agent}:{task_id}: {detail}

== ESCALATIONS ==
{agent}: {action} (task #{id})

== KNOWLEDGE GROWTH ==
{category}: {N} new memories

== OBSERVATIONS ==
Active agents: {agent list}
{pattern warnings if applicable}
```

Pattern detection:
- Blocker-to-completion ratio > 0.5: reports "High blocker-to-completion ratio"
- More than 2 escalations: reports "Multiple escalations detected"

### Phase 4 — Persist

Three things happen at the end of a successful debrief:

1. **Shared memory** — saves an `observational` memory with the session summary (task count, agents, blocker/escalation counts). Importance 3, quality 0.7.

2. **Blocker pattern memories** — if any agent encountered 2 or more blockers, saves an `operational` shared memory describing the pattern.

3. **Telegram post** — posts the team report to the group (plain text, no Markdown):

```
Session Debrief — YYYY-MM-DD
Period: {since} to {until}

== TEAM ACTIVITY ==
{agent}: {N} tasks
  #{id}: {description truncated to 80 chars}

== STATS ==
Tasks: {N} | Blockers: {N} | Escalations: {N}
Memories: {N} new | Agents: {list}
Decision: #{id}
```

## MCP Tools

### `force_debrief`

Manually trigger a session debrief. Boss only.

```typescript
{}  // No parameters
```

Bypasses the Idle and Volume gates. The Lock gate is still respected — if a debrief is already running, this will fail with an error.

**Returns:** `DebriefResult` with `runId`, `decisionId`, `tasksReviewed`, `memoriesReviewed`, `synthesis`, and `durationMs`.

## Integration with the Watchdog

The watchdog calls `checkAndRunDebrief` at the end of every 30-second cycle (after reconciling tasks and checking sessions). It checks all 3 gates and runs the debrief if they all pass. Errors in the debrief do not crash the watchdog — they are caught and logged.

## Integration with the Decision System

Debriefs create and finalize a decision record in Phase 2 and 3. This gives every debrief an auditable record with per-agent positions. The decision is finalized by `debrief-daemon` (not Boss), which is the only case where a non-Boss agent finalizes a decision.

After finalization, the decision creates a shared `strategic` memory automatically (standard decision finalization behavior).

## Database Tables

### `debrief_runs`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-increment run ID |
| `started_at` | TEXT | When the run started |
| `completed_at` | TEXT | When the run finished (null if in progress or errored) |
| `tasks_reviewed` | INTEGER | Number of tasks in the debrief |
| `memories_reviewed` | INTEGER | Number of memories in the debrief |
| `decision_id` | INTEGER | Linked decision ID |
| `synthesis` | TEXT | The full synthesis text |
| `error` | TEXT | Error message if the run failed |

### `debrief_locks`

Singleton lock table preventing concurrent debriefs.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY CHECK (id = 1) | Always 1 |
| `holder` | TEXT | `debrief-{pid}` of the holder |
| `acquired_at` | TEXT | When the lock was acquired |
| `expires_at` | TEXT | When the lock expires (10-minute TTL) |

## Configuration

All thresholds are in `config.ts` under `DEBRIEF_DEFAULTS`:

| Setting | Value | Meaning |
|---------|-------|---------|
| `idle_threshold_min` | 15 | Minutes of idle time required |
| `min_completed_tasks` | 3 | Task count threshold for Volume gate |
| `min_new_memories` | 5 | Memory count threshold for Volume gate |
| `min_hours_since_last` | 2 | Hours fallback for Volume gate (with 1 task) |
| `lock_ttl_min` | 10 | Lock expiry in minutes |

## Debugging

To check why a debrief did not fire, review the gate conditions:

1. **Idle gate failing** — check `task_status_events` for recent `working` entries: `SELECT * FROM task_status_events WHERE status='working' ORDER BY created_at DESC LIMIT 5`
2. **Volume gate failing** — check `debrief_runs` for the last run timestamp, then count tasks and memories since then
3. **Lock gate failing** — check `debrief_locks`: `SELECT * FROM debrief_locks` (stale locks have expired `expires_at`)

Force a debrief to run immediately by calling `force_debrief` as Boss, which bypasses gates 1 and 2.
