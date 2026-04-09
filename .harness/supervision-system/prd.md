# Durable Supervision System -- Product Requirements Document

**Date:** 2026-04-07
**Status:** Draft
**Author:** Boss (via LLM Council consensus)
**Source:** LLM Council Report 2026-04-07 (Grok 4.20, GPT 5.4 Pro, Gemini 2.5 Pro, Llama 4 Maverick, Qwen3 235B)

---

## 1. Problem Statement

The threadwork multi-agent system (4 persistent Claude Code agents coordinated via a shared SQLite task board MCP server, Telegram, and tmux sessions) has a critical reliability gap: **supervision of delegated work is not durable**.

### Current Failure Modes

1. **Forgotten monitor loops.** When agents delegate work to sub-agents, they are instructed to start a CronCreate monitor loop. In practice, agents frequently skip this step. The monitor loop is session-local and ephemeral -- if the agent restarts, the loop vanishes with no trace.

2. **30-minute detection lag.** The watchdog (`watchdog.ts`) runs on a cron every 10 minutes and only detects tasks that have been in_progress for 10+ minutes with no audit activity. This means a stuck task can go undetected for up to 30 minutes before escalation reaches Boss.

3. **Blocking questions fall into the void.** When a sub-agent hits a blocker and calls `write_status(blocked, ...)`, the status event is written to the database but nothing acts on it. The supervisor only sees it if they happen to run `read_status` -- which requires a monitor loop that may not exist.

4. **No accountability chain on delegation.** There is no hard gate ensuring that every delegation creates a supervision record. An agent can call `create_task` or spawn a sub-agent via the Agent tool without any durable supervision being established. The delegation-enforcement hook (`enforce-delegation.sh`) is a client-side defense-in-depth measure but is bypassable and session-local.

5. **Dead sessions look like stale tasks.** When a tmux session crashes, the assigned task simply appears "stale" to the watchdog. There is no mechanism to distinguish a dead worker from a slow worker, leading to inappropriate escalation behavior.

6. **Parent tasks can complete while children are still running.** A supervisor can mark their task as complete while delegated child tasks remain in_progress, silently dropping supervision of the children.

### Root Cause

The current architecture treats supervision as an **optional, ephemeral, session-local behavior** (CronCreate loops inside each agent). The task board has no schema-level representation of supervision relationships, no durable timers, and no mechanism for the watchdog to enforce supervision contracts.

---

## 2. Solution Overview

Build **durable supervision directly into the task board** so that:

- Every delegation automatically creates a supervision contract in the database
- The watchdog is the **single durable controller** that enforces all supervision
- CronCreate monitor loops become **convenience/defense-in-depth**, not correctness mechanisms
- Blocked questions trigger immediate notification with durable reconciliation as backstop
- Dead workers are distinguished from slow workers via session leases
- Parent tasks cannot complete while children are still open

This follows the **Kubernetes controller/reconciliation loop** pattern: the database holds desired + observed state, and the watchdog repeatedly reconciles reality against expectations.

---

## 3. Requirements

### 3.1 Schema: Tasks Table Supervision Columns

Add the following columns to the existing `tasks` table:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `parent_task_id` | INTEGER REFERENCES tasks(id) | NULL | Parent task for delegation trees. NULL for top-level tasks. |
| `supervisor_agent` | TEXT | NULL | Agent responsible for supervising this task. |
| `kind` | TEXT | 'task' | Task kind: `task` (normal), `subagent` (spawned via Agent tool). |
| `last_heartbeat_at` | TEXT | NULL | Last time the worker signaled "I am alive" (any write_status call). |
| `last_progress_at` | TEXT | NULL | Last time the worker reported meaningful progress (write_status with progress=true). |
| `next_check_at` | TEXT | NULL | Durable timer: watchdog acts when `next_check_at <= now`. |
| `heartbeat_timeout_sec` | INTEGER | 120 | Seconds before a missed heartbeat triggers a nudge. |
| `progress_timeout_sec` | INTEGER | 600 | Seconds before lack of progress triggers escalation to supervisor. |
| `blocked_at` | TEXT | NULL | Timestamp when worker reported blocked status. |
| `blocked_reason` | TEXT | NULL | Why the worker is blocked (forwarded to supervisor). |
| `escalation_level` | INTEGER | 0 | Current escalation level (0=none, 1=nudged, 2=warned, 3=escalated to boss). |
| `worker_session_id` | TEXT | NULL | tmux session identifier of the worker, for session-aware escalation. |
| `version` | INTEGER | 0 | Optimistic concurrency token. Incremented on every supervision-relevant update. |

**Rationale (council consensus):** Supervision is fundamentally part of the task lifecycle. With 4 agents on a single Mac using SQLite, a separate supervision table adds unnecessary complexity. History is already captured in `task_status_events` and `audit_log`.

### 3.2 Schema: Agent Sessions Table

Create a new `agent_sessions` table for session lease tracking:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  agent TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  state TEXT NOT NULL DEFAULT 'alive',
  pid INTEGER
);
```

**Purpose:** Allows the watchdog to distinguish between a dead worker (session not seen recently) and a slow worker (session alive but task stale). This materially changes escalation behavior -- a dead session warrants immediate reassignment, not a nudge.

### 3.3 DB Constraint: Supervision Requirement

```sql
CHECK (from_agent = to_agent OR supervisor_agent IS NOT NULL)
```

This constraint ensures that any task delegated to a different agent (from_agent != to_agent) must have a supervisor. Self-assigned tasks (from_agent = to_agent) are exempt. This is the **database-level hard gate** -- the final defense that prevents unsupervised delegation even if MCP logic has a bug.

### 3.4 MCP Tool: `delegate_task`

A new MCP tool that atomically creates a delegated task with supervision:

**Parameters:**
- `to` (string, required): Target agent
- `description` (string, required): Task description
- `priority` (string, optional): low/normal/high/urgent (default: normal)
- `parent_task_id` (number, optional): Parent task ID for sub-delegation
- `heartbeat_timeout_sec` (number, optional): Override default heartbeat timeout
- `progress_timeout_sec` (number, optional): Override default progress timeout

**Behavior:**
1. Creates a task row with `from_agent = SELF_LABEL`, `to_agent = to`
2. Automatically sets `supervisor_agent = SELF_LABEL`
3. Computes `next_check_at = now + unclaimed_check_interval` (default 60 seconds)
4. Sets `parent_task_id` if provided
5. Nudges the target agent
6. Posts to Telegram group
7. Logs to audit

**Hard gate:** This is the only sanctioned way to delegate work to another agent. `create_task` remains available for self-assigned tasks but will fail the DB constraint if `from_agent != to_agent` without `supervisor_agent`.

### 3.5 Enhanced `write_status`

Extend the existing `write_status` MCP tool with additional parameters:

**New parameters:**
- `progress` (boolean, optional, default: true): Whether this status update represents meaningful progress (not just a heartbeat)
- `blocked` (boolean, optional, default: false): Whether the worker is blocked
- `blocked_reason` (string, optional): Why the worker is blocked
- `eta_minutes` (number, optional): Estimated time to completion (extends `next_check_at`)

**Behavior:**
1. Always updates `last_heartbeat_at = now` on the task row
2. If `progress = true`, also updates `last_progress_at = now`
3. Recomputes `next_check_at` based on `heartbeat_timeout_sec` (or `eta_minutes` if provided)
4. If `blocked = true`:
   - Sets `blocked_at = now` and `blocked_reason` on the task row
   - Sets `next_check_at = now` (immediate watchdog attention)
   - Sends **edge-triggered immediate notification** to `supervisor_agent` via tmux/Telegram (best-effort)
5. If `blocked = false` and task was previously blocked, clears `blocked_at` and `blocked_reason`
6. Writes to `task_status_events` as before
7. Increments `version`

### 3.6 Enhanced `complete_task` with Finalizer Semantics

Modify `complete_task` to enforce that parent tasks cannot complete while children are still open:

**Behavior:**
1. Before completing, check for open child tasks: `SELECT COUNT(*) FROM tasks WHERE parent_task_id = ? AND status NOT IN ('completed', 'cancelled')`
2. If open children exist, **refuse completion** with an error listing the open child task IDs
3. On successful completion, clear supervision fields and set `next_check_at = NULL`
4. Notify supervisor via nudge
5. Auto-save task summary as memory (existing behavior)

### 3.7 Enhanced `claim_task` with Session Binding

Modify `claim_task` to bind the worker's session:

**Behavior:**
1. Set `worker_session_id` from the claiming agent's known tmux session
2. Set `last_heartbeat_at = now`
3. Compute initial `next_check_at = now + heartbeat_timeout_sec`
4. Existing behavior otherwise unchanged

### 3.8 Sub-agent Spawn Wrapper

When the Agent tool spawns a sub-agent, create a durable child task row:

**PreToolUse hook (or wrapper):**
1. Before spawning, insert a child task row with:
   - `parent_task_id = current_task_id`
   - `kind = 'subagent'`
   - `supervisor_agent = SELF_LABEL`
   - `from_agent = SELF_LABEL`
   - `to_agent = SELF_LABEL` (or sub-agent identity)
   - `next_check_at = now + heartbeat_timeout_sec`
2. Record the child task ID for cleanup

**PostToolUse hook (or wrapper):**
1. When the sub-agent returns, complete the child task row with the result
2. If the sub-agent fails or is interrupted, mark the child row as cancelled with the error

**Hard rule:** If a sub-agent can be spawned without a durable row, the hard gate is broken. Every delegation path must emit a durable child record.

### 3.9 Watchdog Upgrade

Rewrite `watchdog.ts` as a **durable controller loop** (not a cron job):

**Architecture:**
- Runs continuously with a **30-second cadence** (sleep 30 seconds between cycles)
- Each cycle: `SELECT * FROM tasks WHERE next_check_at <= datetime('now') AND status NOT IN ('completed', 'cancelled')`
- Acts on each due task based on its state
- Recomputes `next_check_at` after each action

**Singleton lease:** Ensure only one watchdog instance runs at a time:
- Use a `watchdog_lease` row in a control table
- Acquire lease with `last_renewed_at` timestamp
- Renew lease every cycle
- If lease is stale (> 2 minutes), another instance can take over

**Session-aware escalation:**
1. Check `agent_sessions` for the worker's session state
2. If session is dead: immediate escalation (reassign, not nudge)
3. If session is alive but heartbeat overdue: nudge worker
4. If session is alive but no progress for too long: escalate to supervisor
5. If blocked: relay blocked_reason to supervisor immediately

**Escalation policy:**
- Level 0: No action (within timeout)
- Level 1: Nudge worker ("status update?")
- Level 2: Warn worker ("escalating to supervisor in N minutes")
- Level 3: Escalate to supervisor_agent (or Boss if supervisor is unresponsive)
- Each escalation increments `escalation_level` and updates `next_check_at`

**Idempotent escalation:** Escalation actions must be idempotent. Use `escalation_level` as a guard -- do not re-send a nudge if the task is already at that escalation level. This prevents duplicate Boss tasks and notification storms.

**Blocked question relay:** When a task has `blocked_at IS NOT NULL`, the watchdog immediately relays `blocked_reason` to the `supervisor_agent` on every cycle until the block is cleared. This is the **level-triggered reconciliation** backstop for the edge-triggered immediate notification in `write_status`.

**Agent session heartbeat monitoring:**
- Each cycle, check all sessions in `agent_sessions`
- Mark sessions as `dead` if `last_seen_at` is older than the session timeout
- Post to Telegram if a session dies

### 3.10 Edge-Triggered + Level-Triggered Pattern

For time-sensitive events (blocked questions, urgent tasks):

- **Edge-triggered (immediate, best-effort):** `write_status(blocked=true)` immediately sends a tmux nudge and/or Telegram message to the supervisor. This may fail (tmux down, network issue) -- that is acceptable.
- **Level-triggered (durable, guaranteed):** The blocked state is durably recorded in the task row. The watchdog will keep acting on it every 30 seconds until it is resolved. This is the correctness mechanism.

Both layers are required. Edge-triggered alone is fragile. Level-triggered alone is too slow for blocking questions.

### 3.11 Idempotent Escalation

All watchdog escalation actions must be idempotent:

- Nudges: guarded by `escalation_level` -- do not re-nudge at the same level
- Boss escalation tasks: use a deterministic key (e.g., `task_id + escalation_level`) to prevent duplicate escalation tasks
- Notification delivery: treat as best-effort; correctness lives in DB state

---

## 4. Non-Requirements (Deferred)

These items were discussed by the council but are not in scope for the initial implementation:

- **Multiple concurrent supervisors per task** -- only one `supervisor_agent` per task for now
- **Circuit breaker / degraded routing** -- automatically reducing delegation to repeatedly failing agents
- **Outbox table for reliable notification delivery** -- notifications remain best-effort
- **Migration to Postgres / LiteFS** -- SQLite is sufficient at current scale
- **Watchdog-of-the-watchdog** -- launchd supervision of the watchdog process (desirable but separate from the task board codebase)
- **`declare_long_running` API** -- agents can use `eta_minutes` in `write_status` instead
- **Saga pattern for complex compensation** -- premature at current scale

---

## 5. Success Criteria

1. **Zero invisible stuck tasks.** Every delegated task has a durable supervision record. The watchdog detects and acts on overdue tasks within 60 seconds.
2. **Blocked questions reach supervisors within 30 seconds.** Edge-triggered notification + level-triggered reconciliation ensures no blocking question goes unanswered.
3. **Dead sessions trigger immediate reassignment.** Session leases allow the watchdog to distinguish dead workers from slow workers.
4. **Parent tasks cannot orphan children.** Finalizer semantics prevent supervisors from completing work while delegated children are still running.
5. **No duplicate escalations.** Idempotent escalation logic prevents notification storms.
6. **Backward compatible.** Existing `create_task`, `list_tasks`, `send_note`, and memory tools continue to work unchanged. New supervision features are additive.
7. **CronCreate loops become optional.** Agents that start monitor loops get faster feedback. Agents that forget are still covered by the watchdog within 30 seconds.

---

## 6. Distributed Systems Patterns Applied

| Pattern | Application |
|---------|-------------|
| **Kubernetes controller/reconciliation loop** | Watchdog is the controller. Task rows are desired+observed state. Watchdog repeatedly reconciles reality against expectations. |
| **Erlang/OTP supervision trees** | `parent_task_id` + `supervisor_agent` creates a natural supervision tree. Boss is root supervisor. Failures bubble upward. |
| **Lease/heartbeat pattern** | `write_status` renews the lease via `last_heartbeat_at`. Watchdog revokes the lease on expiry. |
| **Edge-triggered + level-triggered** | Immediate best-effort notification for speed. Durable DB reconciliation for correctness. |
| **Finalizer semantics** | Parent tasks cannot complete while open children exist, preventing silent supervision loss. |
| **Optimistic concurrency** | `version` column prevents lost updates from concurrent watchdog/agent writes. |
