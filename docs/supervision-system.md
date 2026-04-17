# Supervision System

## Overview

The Supervision System closes the accountability gap in multi-agent delegation. Before this system, agents could delegate work via `create_task` and the Agent tool without any hard gate ensuring supervision. Monitor loops were optional and ephemeral — agents would skip them, and when a worker stalled, detection lag could reach 30+ minutes before anyone noticed.

This system makes supervision **durable and automatic**:

- Every cross-agent delegation must have a supervisor (enforced by a DB trigger).
- A persistent watchdog loop reconciles all supervised tasks every 30 seconds.
- Sub-agent invocations (via the Agent tool) are recorded as durable task rows so the watchdog can monitor them too.
- Finalizer semantics prevent a parent from completing while children are still open.

## Architecture

### Task-Row Supervision

All supervision state lives on the `tasks` table as additional columns -- not in a separate table. This keeps queries simple and atomic: a single `SELECT * FROM tasks` row contains both the task data and its full supervision state (heartbeat times, escalation level, blocked status, etc.).

### Watchdog as Sole Durable Reconciler

The watchdog (`watchdog.ts`) runs as a persistent process with a 30-second reconciliation cadence. It is the single source of truth for detecting problems. Agent-side monitor loops are now defense-in-depth, not the primary mechanism. The watchdog:

1. Acquires a singleton lease (preventing duplicate instances)
2. Queries tasks whose `next_check_at <= now`
3. Takes action based on task state (nudge, escalate, relay blocked reason)
4. Checks agent session liveness via tmux
5. Sleeps and repeats

### Atomic Delegation

`delegate_task` creates a task row with all supervision fields populated atomically. The supervisor is set automatically to the calling agent, `next_check_at` is computed, and heartbeat/progress timeouts are initialized. There is no separate "register for supervision" step.

### Sub-Agent Tracking

`spawn_subagent` creates a synthetic child task row (`kind = 'subagent'`, `is_synthetic = 1`) before the Agent tool runs. `close_subagent` marks it complete afterward. These rows are monitored by the watchdog identically to delegated tasks.

**Close-in-finally is mandatory.** Every `spawn_subagent` MUST be paired with a `close_subagent` invocation in a finally-equivalent block — call `close_subagent` immediately after the Agent tool returns whether the call succeeded, threw an error, or was interrupted. Sub-agents share the parent's session_id and PPID, so the parent is the only context that knows the actual outcome and can record it accurately. The server-side auto-close (see Finalizer Semantics, below) is a backstop for crash/abort scenarios where the parent never reaches `complete_task`; it should not be relied on for normal cleanup. The audit history at `subagent_spawned` vs `subagent_closed` is the canonical evidence of whether agents are honoring the pairing.

### Finalizer Semantics

`complete_task` queries for open child tasks before allowing completion. Behavior splits by child kind:

- **Non-synthetic children** (delegated tasks): completion is refused with an error listing the open child IDs. The parent must wait for the child to finish or cancel.
- **Synthetic children** (sub-agent task rows): are auto-closed as a backstop with `result = 'Auto-closed: parent task completed'`. The auto-close is logged in the audit row under `auto_closed_children` so the gap (parent forgot to close-in-finally) is visible. This catches the crash/abort case but is NOT the primary path — explicit `close_subagent` after Agent returns is required and gives a richer result string.

## New MCP Tools

### `delegate_task`

Delegate a task to another agent with durable supervision. Automatically sets the caller as supervisor, computes watchdog check times, and enables heartbeat/progress monitoring.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | yes | Target agent (boss, steve, sadie, kiera) |
| `description` | string | yes | What needs to be done |
| `priority` | string | no | low, normal (default), high, urgent |
| `parent_task_id` | number | no | Parent task ID to create a child task |
| `heartbeat_timeout_sec` | number | no | Seconds before heartbeat is overdue (default: 120) |
| `progress_timeout_sec` | number | no | Seconds before progress is stale (default: 600) |

### `spawn_subagent`

Create a durable child task row BEFORE spawning a sub-agent via the Agent tool. Does not actually spawn the agent -- you do that with the Agent tool afterward.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | yes | What the sub-agent will work on |
| `parent_task_id` | number | yes | The task ID this sub-agent is working under |
| `model` | string | no | Model hint (e.g., "haiku", "sonnet") stored in description |

Returns the child task ID. Pass this ID to the sub-agent so it can send `write_status` updates.

### `close_subagent`

Mark a synthetic sub-agent child task as completed. **Call this in a finally block** — immediately after the Agent tool returns on SUCCESS, AND after Agent throws / errors / is interrupted. Pass the original error message as `result` if the Agent failed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | number | yes | The child task ID returned by `spawn_subagent` |
| `result` | string | yes | Summary of what the sub-agent accomplished (or error message if it failed) |

The pseudo-pattern every caller must follow:

```
const child = spawn_subagent({...})
let outcome
try {
  outcome = Agent({...})  // may throw
  close_subagent({ task_id: child.id, result: summarize(outcome) })
} catch (err) {
  close_subagent({ task_id: child.id, result: `Failed: ${err.message}` })
  throw err  // propagate after cleanup
}
```

Server-side auto-close on parent `complete_task` exists as a backstop for crash/abort cases where the parent never gets a chance to clean up — but it cannot record the actual sub-agent outcome and runs strictly after the parent finishes. The explicit close after Agent returns is the primary path.

### `get_children`

Get all child tasks (delegated tasks and sub-agent invocations) of a parent task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | number | yes | The parent task ID |
| `include_completed` | boolean | no | Include completed/cancelled children (default: true) |

## Enhanced Existing Tools

### `write_status`

Now accepts additional parameters for durable supervision. Every call updates `last_heartbeat_at` on the task row. The existing JSONL status event is still written for backward compatibility.

| New Parameter | Type | Default | Description |
|---------------|------|---------|-------------|
| `progress` | boolean | true | Whether real progress was made. If false, only heartbeat is updated. |
| `blocked` | boolean | false | Whether the task is blocked. Triggers immediate supervisor notification. |
| `blocked_reason` | string | -- | Reason the task is blocked (used when `blocked=true`). |
| `eta_sec` | number | -- | Estimated seconds until next meaningful update. Extends `next_check_at`. |

### `complete_task`

Now includes a finalizer check: refuses completion if open child tasks exist. Returns an error listing the open child IDs. Boss can still force-complete, but the finalizer check applies to boss too.

### `claim_task`

Now binds the worker's session ID (`worker_session_id`) and initializes heartbeat timing (`last_heartbeat_at`, `last_progress_at`, `next_check_at`). Also upserts the agent's session record.

## Supervision Columns (on tasks table)

All 14 columns added by Sprint 1, with their types and defaults:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `parent_task_id` | INTEGER | NULL | Foreign key to parent task (for child tasks and sub-agents) |
| `kind` | TEXT | 'task' | Task kind: 'task' (normal) or 'subagent' (synthetic sub-agent record) |
| `supervisor_agent` | TEXT | NULL | The agent responsible for supervising this task |
| `last_heartbeat_at` | TEXT | NULL | Timestamp of last heartbeat (any `write_status` call) |
| `last_progress_at` | TEXT | NULL | Timestamp of last meaningful progress (`write_status` with `progress=true`) |
| `next_check_at` | TEXT | NULL | When the watchdog should next check this task |
| `heartbeat_timeout_sec` | INTEGER | 120 | Seconds before heartbeat is considered overdue |
| `progress_timeout_sec` | INTEGER | 600 | Seconds before progress is considered stale |
| `blocked_at` | TEXT | NULL | Timestamp when task was marked blocked |
| `blocked_reason` | TEXT | NULL | Reason the task is blocked |
| `escalation_level` | INTEGER | 0 | Current escalation level (0 = none, increments with each nudge/escalation) |
| `worker_session_id` | TEXT | NULL | Tmux session ID of the worker (set on claim) |
| `version` | INTEGER | 1 | Optimistic concurrency version (incremented on each heartbeat update) |
| `is_synthetic` | INTEGER | 0 | Whether this is a synthetic sub-agent task row (1 = yes) |

## New Tables

### `agent_sessions`

Tracks liveness of each agent's tmux session.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-increment ID |
| `agent` | TEXT UNIQUE | Agent name (boss, steve, sadie, kiera) |
| `session_id` | TEXT | Tmux session name |
| `last_seen_at` | TEXT | Timestamp of last heartbeat (default: now) |
| `state` | TEXT | Session state: 'alive', 'dead', or 'unknown' (default: 'unknown') |
| `started_at` | TEXT | When the session was first registered (default: now) |

### `watchdog_lease`

Singleton lease table ensuring only one watchdog instance runs at a time.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY CHECK (id = 1) | Always 1 (singleton) |
| `holder` | TEXT | Identifier of the current lease holder |
| `acquired_at` | TEXT | When the lease was first acquired |
| `expires_at` | TEXT | When the lease expires (renewed each cycle) |
| `pid` | INTEGER | Process ID of the holder |

## Watchdog Behavior

### 30-Second Reconciliation Loop

The watchdog runs as a persistent `while(true)` loop, sleeping 30 seconds between cycles. Each cycle:

1. **Acquire or renew lease** -- atomic INSERT/ON CONFLICT that only succeeds if the lease is expired or already held by this instance.
2. **Reconcile due tasks** -- queries `next_check_at <= datetime('now')` and acts on each.
3. **Check agent sessions** -- verifies tmux sessions for stale agents.
4. **Sleep** -- waits `WATCHDOG_CADENCE_SEC` (30s) before next cycle.

### Due-Time-Driven

The watchdog does NOT scan all tasks. It only queries tasks where `next_check_at <= now AND status NOT IN ('completed', 'cancelled')`. This is O(due tasks), not O(all tasks).

### Singleton Lease

The `watchdog_lease` table has a CHECK constraint `id = 1`, enforcing a single row. The INSERT/ON CONFLICT pattern only acquires the lease if:
- No lease exists, OR
- The existing lease is expired (`expires_at < now`), OR
- This instance already holds the lease

This prevents duplicate watchdog instances from causing notification storms.

### Session-Aware

For each due task, the watchdog checks `agent_sessions` for the worker:
- **Dead session** (state = 'dead' or last_seen_at too old): Immediate escalation to boss. Does NOT nudge (session is dead, nudge will fail).
- **Alive session, heartbeat overdue**: Standard nudge escalation ladder.
- **Alive session, progress overdue**: Escalate to supervisor_agent.

Session liveness is verified via `tmux has-session -t <session_name>`.

### Idempotent Escalation

All escalation actions are guarded by `escalation_level` to prevent duplicate actions. Before creating an escalation task for boss, the watchdog checks if one already exists (by matching the description pattern `ESCALATION%#<taskId>%`).

### Escalation Ladder

For heartbeat-overdue tasks:
1. **Level 1**: Nudge the worker
2. **Level 2**: Second nudge to the worker
3. **Level 3+**: Escalate to boss (create escalation task)

For unclaimed tasks, the same ladder applies with nudges to the assignee.

For blocked tasks, the `blocked_reason` is relayed to the supervisor every cycle until unblocked (level-triggered reconciliation).

## How to Use

### For Cross-Agent Delegation

Use `delegate_task` instead of `create_task` when assigning work to another agent:

```
delegate_task(to="steve", description="Build the login page", priority="high")
```

This automatically sets you as supervisor, computes watchdog check times, and enables heartbeat/progress monitoring. The worker should send `write_status` updates while working.

### For Sub-Agents

Before spawning a sub-agent via the Agent tool, create a durable record:

```
1. spawn_subagent(description="Implement CSS styles", parent_task_id=42)
   -> Returns child_task_id (e.g., 43)

2. Agent tool: "Work on task #43: Implement CSS styles..."

3. close_subagent(task_id=43, result="CSS styles implemented for all 5 pages")
```

### For Blocking Questions

When a sub-agent or worker is stuck, use `write_status` with `blocked=true`:

```
write_status(agent="steve", task_id=42, status="blocked",
  detail="Need database credentials",
  blocked=true, blocked_reason="Cannot connect to production DB without credentials")
```

This triggers an immediate notification to the supervisor and sets `next_check_at` to now for watchdog pickup.

### Self-Assigned Tasks

`create_task` still works for self-assigned tasks (where `from_agent == to_agent`). The supervision trigger only fires when delegating to a different agent.

## DB Constraints

### Trigger: `trg_require_supervision`

```sql
BEFORE INSERT ON tasks
WHEN NEW.from_agent != NEW.to_agent AND NEW.supervisor_agent IS NULL
```

Blocks any cross-agent delegation that does not have a `supervisor_agent` set. This is the hard gate that ensures every delegation has accountability.

### Trigger: `trg_prevent_supervision_removal`

```sql
BEFORE UPDATE ON tasks
WHEN OLD.supervisor_agent IS NOT NULL AND NEW.supervisor_agent IS NULL
  AND OLD.from_agent != OLD.to_agent
```

Prevents removing `supervisor_agent` from an already-delegated task. Once supervision is established, it cannot be undone.

## Distributed Systems Patterns Applied

### Kubernetes Controller / Reconciliation Loop

The watchdog is modeled after a Kubernetes controller: it runs an infinite reconciliation loop, querying for resources (tasks) that have drifted from their desired state, and taking corrective action. The `next_check_at` column serves as the "requeue after" timestamp.

### Erlang/OTP Supervision Trees

Parent-child task relationships with `parent_task_id` form a supervision tree. The finalizer semantics (parent can't complete with open children) mirror Erlang's `one_for_all` strategy. Sub-agent tasks (`kind = 'subagent'`) are supervised identically to delegated tasks.

### Lease / Heartbeat Pattern

Two lease/heartbeat patterns are in play:
1. **Watchdog lease** (`watchdog_lease` table): Ensures singleton watchdog via lease acquisition with expiry.
2. **Worker heartbeat** (`last_heartbeat_at` on tasks): Workers prove liveness by sending periodic `write_status` updates. Overdue heartbeats trigger escalation.

### Edge-Triggered + Level-Triggered

- **Edge-triggered**: `write_status(blocked=true)` sends an immediate notification to the supervisor (one-shot event).
- **Level-triggered**: The watchdog re-relays `blocked_reason` to the supervisor every cycle as long as `blocked_at IS NOT NULL`. This backstops the edge trigger -- if the immediate notification is missed, the watchdog will keep relaying.

### Finalizer Semantics

Borrowed from Kubernetes finalizers: a parent task cannot be deleted (completed) until all its children are done. The `complete_task` handler checks for open children and refuses completion until they are resolved. This prevents work from being silently abandoned.
