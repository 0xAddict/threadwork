# Durable Supervision System -- Implementation Plan

**Date:** 2026-04-07
**Status:** Draft
**PRD:** `./prd.md`
**Codebase:** `/Users/coachstokes/.claude/mcp-servers/task-board/`

---

## Sprint Overview

| Sprint | Name | Focus | Files Touched |
|--------|------|-------|---------------|
| 1 | Foundation | Schema migration + DB constraint | `db.ts`, `config.ts` |
| 2 | Core API | delegate_task, enhanced write_status/complete_task/claim_task | `server.ts`, `db.ts` |
| 3 | Watchdog Upgrade | Durable controller loop with session-aware escalation | `watchdog.ts`, `db.ts` |
| 4 | Sub-agent Integration | Agent tool hooks for child task rows | `hooks/`, `server.ts` |
| 5 | Testing + Docs | End-to-end tests, documentation, migration of existing workflows | `tests/`, `CLAUDE.md` |

---

## Sprint 1: Foundation

**Goal:** Add the supervision schema to the database and enforce the supervision constraint at the DB level. After this sprint, the database is ready for all subsequent supervision features.

### Tasks

1. **Add supervision columns to `tasks` table** (`db.ts` -- `migrate()` method)
   - Add columns via safe `ALTER TABLE ... ADD COLUMN` pattern (matching existing migration style):
     - `parent_task_id INTEGER REFERENCES tasks(id)`
     - `supervisor_agent TEXT`
     - `kind TEXT DEFAULT 'task'`
     - `last_heartbeat_at TEXT`
     - `last_progress_at TEXT`
     - `next_check_at TEXT`
     - `heartbeat_timeout_sec INTEGER DEFAULT 120`
     - `progress_timeout_sec INTEGER DEFAULT 600`
     - `blocked_at TEXT`
     - `blocked_reason TEXT`
     - `escalation_level INTEGER DEFAULT 0`
     - `worker_session_id TEXT`
     - `version INTEGER DEFAULT 0`
   - Add index: `CREATE INDEX IF NOT EXISTS idx_tasks_next_check ON tasks(next_check_at) WHERE next_check_at IS NOT NULL AND status NOT IN ('completed', 'cancelled')`
   - Add index: `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)`
   - Add index: `CREATE INDEX IF NOT EXISTS idx_tasks_supervisor ON tasks(supervisor_agent)`

2. **Create `agent_sessions` table** (`db.ts` -- `migrate()` method)
   ```sql
   CREATE TABLE IF NOT EXISTS agent_sessions (
     agent TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
     state TEXT NOT NULL DEFAULT 'alive',
     pid INTEGER
   );
   ```

3. **Create `watchdog_lease` table** (`db.ts` -- `migrate()` method)
   ```sql
   CREATE TABLE IF NOT EXISTS watchdog_lease (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     holder TEXT NOT NULL,
     acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
     renewed_at TEXT NOT NULL DEFAULT (datetime('now')),
     pid INTEGER
   );
   ```

4. **Add DB constraint for supervision requirement**
   - Since SQLite does not support `ALTER TABLE ADD CONSTRAINT`, enforce via a trigger:
   ```sql
   CREATE TRIGGER IF NOT EXISTS trg_require_supervision
   BEFORE INSERT ON tasks
   WHEN NEW.from_agent != NEW.to_agent AND NEW.supervisor_agent IS NULL
   BEGIN
     SELECT RAISE(ABORT, 'Delegation requires supervisor_agent when from_agent != to_agent');
   END;
   ```
   - Also add an UPDATE trigger to prevent removing `supervisor_agent` from delegated tasks.

5. **Update `Task` TypeScript interface** (`db.ts`)
   - Add all new fields to the `Task` interface as optional properties (for backward compatibility with existing rows that have NULL values).

6. **Add supervision defaults to `config.ts`**
   ```typescript
   export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 120
   export const DEFAULT_PROGRESS_TIMEOUT_SEC = 600
   export const WATCHDOG_CADENCE_SEC = 30
   export const UNCLAIMED_CHECK_SEC = 60
   export const SESSION_TIMEOUT_SEC = 180
   ```

### Acceptance Criteria

- [ ] All new columns exist on the `tasks` table after migration (verified via `.schema tasks`)
- [ ] `agent_sessions` table exists
- [ ] `watchdog_lease` table exists
- [ ] Inserting a task with `from_agent != to_agent` and `supervisor_agent IS NULL` fails with trigger error
- [ ] Inserting a task with `from_agent = to_agent` and `supervisor_agent IS NULL` succeeds
- [ ] Inserting a task with `from_agent != to_agent` and `supervisor_agent` set succeeds
- [ ] Existing tasks (with NULL supervision columns) remain queryable
- [ ] `Task` TypeScript interface includes all new fields
- [ ] All existing MCP tools continue to function (backward compatibility)

### Proposed Contract

```typescript
// Updated Task interface
export interface Task {
  id: number
  from_agent: string
  to_agent: string
  description: string
  priority: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  result: string | null
  created_at: string
  claimed_at: string | null
  completed_at: string | null
  nudge_count: number
  // Supervision fields (Sprint 1)
  parent_task_id: number | null
  supervisor_agent: string | null
  kind: string
  last_heartbeat_at: string | null
  last_progress_at: string | null
  next_check_at: string | null
  heartbeat_timeout_sec: number
  progress_timeout_sec: number
  blocked_at: string | null
  blocked_reason: string | null
  escalation_level: number
  worker_session_id: string | null
  version: number
}
```

---

## Sprint 2: Core API

**Goal:** Implement the `delegate_task` MCP tool, enhance `write_status` with progress/blocked semantics, enhance `complete_task` with finalizer logic, and bind `claim_task` to sessions.

### Dependencies
- Sprint 1 (schema must be in place)

### Tasks

1. **Implement `delegate_task` MCP tool** (`server.ts`)
   - Register new tool with input schema:
     - `to` (string, required)
     - `description` (string, required)
     - `priority` (string, optional, default: 'normal')
     - `parent_task_id` (number, optional)
     - `heartbeat_timeout_sec` (number, optional)
     - `progress_timeout_sec` (number, optional)
   - Handler logic:
     1. Validate `to` is a known agent
     2. Insert task row with `supervisor_agent = SELF_LABEL`, `kind = 'task'`, computed `next_check_at = datetime('now', '+' || unclaimed_check_sec || ' seconds')`
     3. If `parent_task_id` provided, validate parent exists and is in_progress
     4. Nudge target agent
     5. Post to Telegram group
     6. Audit log

2. **Add `delegateTask` method to `TaskDB`** (`db.ts`)
   - New method that wraps the INSERT with all supervision fields
   - Returns the created Task with all supervision columns populated

3. **Enhance `write_status` handler** (`server.ts`)
   - Add optional parameters: `progress` (boolean), `blocked` (boolean), `blocked_reason` (string), `eta_minutes` (number)
   - Update handler to:
     1. Always set `last_heartbeat_at = datetime('now')` on the task row
     2. If `progress` is true (default), also set `last_progress_at = datetime('now')`
     3. Recompute `next_check_at` based on `heartbeat_timeout_sec` (or `eta_minutes * 60` if provided)
     4. If `blocked` is true: set `blocked_at`, `blocked_reason`, `next_check_at = datetime('now')`, send immediate notification to `supervisor_agent`
     5. If `blocked` is false and task was previously blocked: clear `blocked_at` and `blocked_reason`
     6. Increment `version`
     7. Continue writing to `task_status_events` as before

4. **Add `updateSupervisionState` method to `TaskDB`** (`db.ts`)
   - Atomic update of heartbeat/progress/blocked/next_check fields with version increment
   - Use optimistic concurrency: `WHERE id = ? AND version = ?`

5. **Enhance `complete_task` with finalizer semantics** (`server.ts`)
   - Before completing, query: `SELECT id FROM tasks WHERE parent_task_id = ? AND status NOT IN ('completed', 'cancelled')`
   - If any open children exist, return error: `Cannot complete task #N: open child tasks [#X, #Y, ...]. Complete or cancel them first.`
   - On successful completion: set `next_check_at = NULL`, clear supervision timing fields

6. **Enhance `claim_task` with session binding** (`server.ts`)
   - On claim, set:
     - `worker_session_id = AGENT_SESSIONS[SELF_LABEL]`
     - `last_heartbeat_at = datetime('now')`
     - `next_check_at = datetime('now', '+' || heartbeat_timeout_sec || ' seconds')`
   - Update the `agent_sessions` row for `SELF_LABEL` with `last_seen_at = datetime('now')`

7. **Update tool listing** (`server.ts`)
   - Add `delegate_task` to the tools list
   - Update `write_status` input schema with new optional parameters
   - Update tool descriptions to reflect new behavior

### Acceptance Criteria

- [ ] `delegate_task` creates a task with `supervisor_agent` automatically set
- [ ] `delegate_task` with `parent_task_id` creates a child task linked to the parent
- [ ] `delegate_task` computes `next_check_at` for watchdog pickup
- [ ] `write_status(progress=true)` updates both `last_heartbeat_at` and `last_progress_at`
- [ ] `write_status(progress=false)` updates only `last_heartbeat_at`
- [ ] `write_status(blocked=true)` sets `blocked_at`, `blocked_reason`, and `next_check_at = now`
- [ ] `write_status(blocked=true)` sends immediate notification to `supervisor_agent`
- [ ] `write_status(eta_minutes=30)` extends `next_check_at` by 30 minutes
- [ ] `complete_task` refuses if open child tasks exist (returns error with child IDs)
- [ ] `complete_task` succeeds when all children are completed/cancelled
- [ ] `claim_task` sets `worker_session_id` and initializes heartbeat timing
- [ ] Existing `create_task` still works for self-assigned tasks
- [ ] Backward compatibility: old-style `write_status` calls (without new params) still work

### Proposed Contract

```typescript
// delegate_task input
interface DelegateTaskInput {
  to: string
  description: string
  priority?: string
  parent_task_id?: number
  heartbeat_timeout_sec?: number
  progress_timeout_sec?: number
}

// Enhanced write_status input
interface WriteStatusInput {
  agent: string
  task_id: number
  status: 'working' | 'blocked' | 'complete' | 'idle'
  detail: string
  progress?: boolean      // default: true
  blocked?: boolean       // default: false
  blocked_reason?: string
  eta_minutes?: number
}

// TaskDB new methods
class TaskDB {
  delegateTask(input: DelegateTaskInput & { from: string }): Task
  updateSupervisionState(taskId: number, updates: Partial<SupervisionFields>, expectedVersion: number): Task | null
  getOpenChildren(taskId: number): Task[]
}
```

---

## Sprint 3: Watchdog Upgrade

**Goal:** Rewrite `watchdog.ts` from a cron-invoked script into a durable controller loop running every 30 seconds, with due-time-driven queries, singleton lease, session-aware escalation, blocked question relay, and idempotent escalation.

### Dependencies
- Sprint 2 (supervision fields must be populated by API)

### Tasks

1. **Rewrite watchdog as a persistent loop** (`watchdog.ts`)
   - Replace the current one-shot cron script with a `while(true)` loop:
     ```typescript
     while (true) {
       await acquireOrRenewLease()
       await reconcileDueTasks()
       await checkAgentSessions()
       await sleep(WATCHDOG_CADENCE_SEC * 1000)
     }
     ```
   - Run under launchd or as a persistent process (not cron)

2. **Implement singleton lease mechanism** (`watchdog.ts`)
   - On each cycle, attempt to acquire/renew the `watchdog_lease` row:
     ```sql
     INSERT INTO watchdog_lease (id, holder, pid, acquired_at, renewed_at)
     VALUES (1, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE
     SET holder = excluded.holder, pid = excluded.pid, renewed_at = datetime('now')
     WHERE renewed_at < datetime('now', '-120 seconds') OR holder = excluded.holder
     ```
   - If lease acquisition fails (another active holder), log and skip cycle
   - This prevents duplicate watchdog instances from causing notification storms

3. **Implement due-time-driven task reconciliation** (`watchdog.ts`)
   - Core query:
     ```sql
     SELECT * FROM tasks
     WHERE next_check_at <= datetime('now')
     AND status NOT IN ('completed', 'cancelled')
     ORDER BY next_check_at ASC
     ```
   - For each due task, determine action based on state:
     - **Unclaimed (status='pending'):** Nudge assignee, increment escalation_level, recompute next_check_at
     - **Heartbeat overdue (last_heartbeat_at + heartbeat_timeout_sec < now):** Check session state, nudge or escalate
     - **Progress overdue (last_progress_at + progress_timeout_sec < now):** Escalate to supervisor_agent
     - **Blocked (blocked_at IS NOT NULL):** Relay blocked_reason to supervisor_agent
     - **Session dead (worker_session_id session is dead):** Immediate escalation / reassignment

4. **Implement session-aware escalation logic** (`watchdog.ts`)
   - For each due task, check `agent_sessions` for the worker:
     - If session `state = 'dead'` or `last_seen_at` is older than `SESSION_TIMEOUT_SEC`: treat as dead worker
       - Create urgent escalation task for Boss (or supervisor_agent)
       - Mark worker session as dead
       - Do NOT nudge (session is dead, nudge will fail)
     - If session is alive but heartbeat overdue: standard nudge escalation
     - If session is alive but progress overdue: escalate to supervisor

5. **Implement blocked question immediate relay** (`watchdog.ts`)
   - When a task has `blocked_at IS NOT NULL`:
     - Send `blocked_reason` to `supervisor_agent` via tmux nudge
     - Also post to Telegram for visibility
     - Keep relaying every cycle until `blocked_at` is cleared
   - This is the **level-triggered reconciliation** backstop

6. **Implement idempotent escalation** (`watchdog.ts`)
   - Guard all escalation actions with `escalation_level`:
     ```typescript
     if (task.escalation_level >= targetLevel) return // already escalated to this level
     ```
   - When creating an escalation task for Boss, use a deterministic description pattern:
     `ESCALATION L${level}: Task #${taskId} (${worker}) ...`
   - Before creating, check if such an escalation task already exists (prevent duplicates)
   - Update `escalation_level` and `next_check_at` atomically

7. **Implement agent session heartbeat check** (`watchdog.ts`)
   - Each cycle, iterate `agent_sessions`:
     ```sql
     SELECT * FROM agent_sessions
     WHERE last_seen_at < datetime('now', '-' || ? || ' seconds')
     AND state = 'alive'
     ```
   - For each stale session, verify via `tmux has-session -t ${session_id}`
   - If tmux confirms dead: update `state = 'dead'`, post to Telegram
   - If tmux says alive: update `last_seen_at = now` (reconcile)

8. **Preserve existing exports** (`watchdog.ts`)
   - Keep `findStaleTasks`, `findUnclaimedTasks`, `determineAction` as exported functions for testing
   - The main loop replaces the `isMainScript` block

9. **Add heartbeat renewal to MCP server startup** (`server.ts`)
   - On server startup, upsert into `agent_sessions`:
     ```sql
     INSERT INTO agent_sessions (agent, session_id, last_seen_at, state)
     VALUES (?, ?, datetime('now'), 'alive')
     ON CONFLICT(agent) DO UPDATE
     SET session_id = excluded.session_id, last_seen_at = datetime('now'), state = 'alive'
     ```
   - Periodically (every 60 seconds) renew `last_seen_at` via a setInterval

### Acceptance Criteria

- [ ] Watchdog runs as a persistent loop (not cron), sleeping 30 seconds between cycles
- [ ] Only one watchdog instance can run at a time (singleton lease)
- [ ] Watchdog queries only tasks with `next_check_at <= now` (not scanning all tasks)
- [ ] Tasks with overdue heartbeats are nudged (escalation_level incremented)
- [ ] Tasks with overdue progress are escalated to supervisor_agent
- [ ] Blocked tasks have their `blocked_reason` relayed to supervisor every cycle
- [ ] Dead worker sessions trigger immediate escalation (not nudge)
- [ ] Escalation is idempotent: same escalation level is not re-triggered
- [ ] No duplicate Boss escalation tasks are created for the same issue
- [ ] Watchdog renews its own lease every cycle
- [ ] MCP server registers and renews its agent session heartbeat
- [ ] Existing `findStaleTasks` / `findUnclaimedTasks` remain exported for tests

### Proposed Contract

```typescript
// watchdog.ts exports
export class TaskReconciler {
  constructor(taskDb: TaskDB, audit: AuditLog, config: WatchdogConfig)

  /** Acquire or renew the singleton watchdog lease. Returns true if held. */
  acquireOrRenewLease(): boolean

  /** Reconcile all tasks with next_check_at <= now. */
  async reconcileDueTasks(): Promise<ReconcileResult>

  /** Check all agent sessions for liveness. */
  async checkAgentSessions(): Promise<void>

  /** Main loop entry point. */
  async run(): Promise<never>
}

interface ReconcileResult {
  checked: number
  nudged: number
  escalated: number
  blocked_relayed: number
  dead_sessions: number
}

interface WatchdogConfig {
  cadenceSec: number
  sessionTimeoutSec: number
  leaseTimeoutSec: number
}
```

---

## Sprint 4: Sub-agent Integration

**Goal:** Ensure that Agent tool spawns (sub-agents) create durable child task rows, closing the last invisible delegation path.

### Dependencies
- Sprint 2 (delegate_task and supervision fields)

### Tasks

1. **Create `spawn_subagent` wrapper function** (`db.ts` or new `subagent.ts`)
   - Function that creates a child task row before sub-agent spawn:
     ```typescript
     function spawnSubagent(params: {
       parentTaskId: number
       description: string
       supervisorAgent: string
     }): Task
     ```
   - Creates a task with:
     - `parent_task_id = parentTaskId`
     - `kind = 'subagent'`
     - `supervisor_agent = supervisorAgent`
     - `from_agent = supervisorAgent`
     - `to_agent = supervisorAgent` (sub-agent acts on behalf of parent)
     - `status = 'in_progress'` (immediately active)
     - `claimed_at = now`
     - `last_heartbeat_at = now`
     - `next_check_at = now + heartbeat_timeout_sec`

2. **Implement PreToolUse hook for Agent tool** (`hooks/pre-tool-use.sh` or settings.json hook)
   - Before the Agent tool runs, intercept to:
     - Determine the current task context (from environment or task board state)
     - Call `spawn_subagent` to create a child task row
     - Pass the child task ID into the sub-agent's context (via environment variable or message prefix)
   - If no current task context exists, log a warning but allow the spawn (defense-in-depth, not a hard block on Agent tool)

3. **Implement PostToolUse hook for Agent tool** (`hooks/post-tool-use.sh` or settings.json hook)
   - After the Agent tool returns:
     - Complete the child task row with the sub-agent's result
     - If the sub-agent errored/was interrupted: mark child task as cancelled with error detail
   - Use try/finally semantics to ensure cleanup even on failure

4. **Implement `parent_task_id` lineage tracking**
   - Add a `getTaskLineage` method to `TaskDB`:
     ```typescript
     getTaskLineage(taskId: number): Task[]
     ```
   - Returns the chain from the given task up to the root (following `parent_task_id`)
   - Useful for debugging and escalation context

5. **Add `getChildren` method to `TaskDB`** (`db.ts`)
   ```typescript
   getChildren(taskId: number, includeCompleted?: boolean): Task[]
   ```
   - Returns all tasks with `parent_task_id = taskId`
   - Default: exclude completed/cancelled unless `includeCompleted = true`

6. **Update `list_tasks` to show lineage** (`server.ts`)
   - When listing tasks, optionally show `parent_task_id` and `kind` in the output
   - Add a `show_children` parameter to list_tasks that includes child tasks for each result

### Acceptance Criteria

- [ ] Spawning a sub-agent via Agent tool creates a child task row with `kind = 'subagent'`
- [ ] Child task row has `parent_task_id` set to the current task
- [ ] Child task row has `supervisor_agent` set to the delegating agent
- [ ] Child task row has `next_check_at` set for watchdog pickup
- [ ] When sub-agent returns successfully, child task is completed with result
- [ ] When sub-agent fails/is interrupted, child task is cancelled with error
- [ ] `getTaskLineage` returns the full parent chain for any task
- [ ] `getChildren` returns all child tasks for a given parent
- [ ] Watchdog monitors sub-agent child tasks identically to delegated tasks
- [ ] `complete_task` on parent still refuses if sub-agent children are open (finalizer semantics from Sprint 2)

### Proposed Contract

```typescript
// subagent.ts
export interface SpawnSubagentInput {
  parentTaskId: number
  description: string
  supervisorAgent: string
  heartbeatTimeoutSec?: number
  progressTimeoutSec?: number
}

export function createSubagentTaskRow(db: TaskDB, input: SpawnSubagentInput): Task

export function completeSubagentTaskRow(db: TaskDB, taskId: number, result: string): Task | null

export function cancelSubagentTaskRow(db: TaskDB, taskId: number, reason: string): Task | null

// db.ts additions
class TaskDB {
  getTaskLineage(taskId: number): Task[]
  getChildren(taskId: number, includeCompleted?: boolean): Task[]
}
```

---

## Sprint 5: Testing + Docs

**Goal:** End-to-end tests validating the entire supervision lifecycle, documentation updates, and migration of existing workflows to use the new system.

### Dependencies
- Sprints 1-4 (all features implemented)

### Tasks

1. **Unit tests for schema migration** (`tests/migration.test.ts`)
   - Verify all new columns exist with correct types and defaults
   - Verify trigger fires on unsupervised delegation
   - Verify trigger allows self-assigned tasks
   - Verify `agent_sessions` and `watchdog_lease` tables exist

2. **Unit tests for `delegate_task`** (`tests/delegate.test.ts`)
   - Delegation creates task with supervisor_agent set
   - Delegation computes next_check_at
   - Delegation with parent_task_id creates child task
   - Delegation to invalid agent fails gracefully
   - Delegation nudges target agent

3. **Unit tests for enhanced `write_status`** (`tests/write-status.test.ts`)
   - `progress=true` updates both heartbeat and progress timestamps
   - `progress=false` updates only heartbeat timestamp
   - `blocked=true` sets blocked fields and next_check_at to now
   - `blocked=true` sends immediate notification (mock)
   - `eta_minutes` extends next_check_at appropriately
   - Version is incremented on each call

4. **Unit tests for `complete_task` finalizer** (`tests/complete-task.test.ts`)
   - Completion succeeds with no children
   - Completion succeeds with all children completed
   - Completion fails with open children (returns error with child IDs)
   - Completion succeeds after children are cancelled

5. **Integration tests for watchdog reconciler** (`tests/watchdog.test.ts`)
   - Due tasks are detected and acted on
   - Heartbeat-overdue tasks get nudged
   - Progress-overdue tasks get escalated to supervisor
   - Blocked tasks get reason relayed to supervisor
   - Dead sessions trigger immediate escalation
   - Escalation is idempotent (no duplicates)
   - Singleton lease prevents dual-watchdog
   - Lease takeover works when previous holder is stale

6. **Integration tests for sub-agent lifecycle** (`tests/subagent.test.ts`)
   - Child task row created before spawn
   - Child task completed on successful return
   - Child task cancelled on failure
   - Parent cannot complete while child is open
   - Watchdog monitors child tasks

7. **End-to-end scenario tests** (`tests/e2e-supervision.test.ts`)
   - Full lifecycle: Boss delegates to Steve, Steve claims, Steve spawns sub-agent, sub-agent completes, Steve completes, Boss sees result
   - Stuck worker scenario: Worker stops sending heartbeats, watchdog nudges, escalates, Boss receives escalation
   - Blocked question scenario: Sub-agent sends blocked status, supervisor receives immediate notification, supervisor responds, sub-agent resumes
   - Dead session scenario: Worker session dies, watchdog detects, escalates immediately

8. **Update CLAUDE.md documentation**
   - Update the "Task Board Workflow" section to reference `delegate_task`
   - Update "Status Tools" to document new write_status parameters
   - Add "Supervision" section explaining the durable model
   - Note that CronCreate monitor loops are now optional defense-in-depth
   - Document the watchdog's role as the single durable controller

9. **Update tool descriptions in `server.ts`**
   - Ensure all tool descriptions in the MCP listing accurately reflect new behavior
   - Add guidance in `instructions` about using `delegate_task` over `create_task` for delegation

10. **Migration of existing workflows**
    - Review `CLAUDE.md` delegation instructions
    - Update the `task-delegation` skill to use `delegate_task`
    - Update the `watchdog-monitor` skill to reflect the new watchdog architecture
    - Backfill existing in_progress tasks with reasonable `next_check_at` values (one-time migration)

### Acceptance Criteria

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] All e2e scenario tests pass
- [ ] CLAUDE.md updated with supervision documentation
- [ ] `task-delegation` skill updated to use `delegate_task`
- [ ] Existing in_progress tasks have `next_check_at` backfilled
- [ ] Watchdog running as persistent process (not cron)
- [ ] No regressions in existing MCP tool behavior
- [ ] TypeScript compiles without errors

### Proposed Contract

```typescript
// Test helpers
export function createTestDB(): TaskDB  // in-memory SQLite for tests
export function seedTestData(db: TaskDB): { boss: Task, worker: Task, child: Task }

// Test scenarios
describe('Supervision Lifecycle', () => {
  it('delegate_task creates supervised work')
  it('write_status updates heartbeat and progress')
  it('write_status(blocked) triggers immediate notification')
  it('complete_task refuses with open children')
  it('watchdog detects overdue heartbeat')
  it('watchdog escalates overdue progress')
  it('watchdog relays blocked reason')
  it('watchdog detects dead session')
  it('escalation is idempotent')
  it('singleton lease prevents dual watchdog')
  it('sub-agent spawn creates child task')
  it('sub-agent completion closes child task')
  it('full delegation lifecycle end-to-end')
})
```

---

## Risk Register

| Risk | Mitigation | Sprint |
|------|------------|--------|
| Schema migration breaks existing queries | Use safe ALTER TABLE ADD COLUMN pattern; all new columns nullable or have defaults | 1 |
| Trigger prevents legitimate create_task calls | Trigger only fires when `from_agent != to_agent AND supervisor_agent IS NULL`; self-assigned tasks unaffected | 1 |
| write_status backward compatibility | New parameters are optional with sensible defaults; existing calls work unchanged | 2 |
| complete_task finalizer blocks legitimate completion | Clear error message lists specific open children; `force_complete` remains for Boss | 2 |
| Watchdog loop crashes and never restarts | Run under launchd with auto-restart; watchdog_lease allows takeover | 3 |
| Dual watchdog instances cause duplicate nudges | Singleton lease mechanism; idempotent escalation as fallback | 3 |
| Agent tool hooks interfere with normal sub-agent usage | Hooks are defensive (warn, not block) if no task context; only create rows when context exists | 4 |
| Test environment needs real tmux/Telegram | Mock nudge and notification functions in test helpers | 5 |

---

## Estimated Timeline

| Sprint | Duration | Can Parallelize With |
|--------|----------|---------------------|
| Sprint 1 (Foundation) | 1-2 hours | -- |
| Sprint 2 (Core API) | 2-3 hours | -- |
| Sprint 3 (Watchdog Upgrade) | 2-3 hours | Sprint 4 (partially) |
| Sprint 4 (Sub-agent Integration) | 1-2 hours | Sprint 3 (partially) |
| Sprint 5 (Testing + Docs) | 2-3 hours | -- |
| **Total** | **8-13 hours** | |

Sprints 3 and 4 can partially overlap since the sub-agent integration depends on Sprint 2's API but not on Sprint 3's watchdog rewrite. The watchdog will monitor sub-agent child tasks using the same due-time logic regardless of when the hooks are added.
