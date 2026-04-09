# Sprint 3 Implementation Log — Unified Execution Events

## Date: 2026-04-08

## Deliverables

### 1. progress_events table (db.ts migrate())
Created with columns:
- event_id (INTEGER PK AUTOINCREMENT)
- task_id (FK to tasks), attempt_id, agent_id
- event_type TEXT with CHECK constraint: started, heartbeat, progress, finding_written, completed, failed, abandoned
- percent INTEGER (0-100), activity TEXT
- metrics_json TEXT
- detail_ref (FK to findings.finding_id)
- created_at TEXT DEFAULT datetime('now')
Indexes: idx_progress_task, idx_progress_type, idx_progress_agent

### 2. report_progress MCP tool + DB helper
- `reportProgress()` in db.ts with 30s throttle per task (in-memory Map cache)
- Lifecycle events (started, completed, failed, abandoned) bypass throttle
- Returns `{ event_id }` on success, `{ throttled, next_allowed_in_sec }` if throttled
- Gated by progress_events_enabled feature flag

### 3. get_progress MCP tool + DB helper
- `getProgress()` in db.ts with task_id filter, optional event_type and limit
- Returns events in chronological order (reverse of DESC query)
- Gated by progress_events_enabled feature flag

### 4. complete_task modification
- Added `result_finding_id` optional parameter to complete_task tool schema
- Handler sets result_finding_id on task row when provided
- Calls `emitCompletionEvent()` to write a 'completed' event to progress_events
- emitCompletionEvent is fire-and-forget (try/catch, never blocks completion)

### 5. write_status deprecated alias
- write_status now also emits to progress_events when progress_events_enabled=1
- Maps status values: blocked->heartbeat, complete->completed, idle->heartbeat, working->progress
- Original task_status_events behavior preserved (always written)

### 6. Feature flag gating
- All new functionality gated behind progress_events_enabled flag
- When disabled: report_progress returns error, get_progress returns empty, no completion events
- write_status alias only emits when flag is on

### 7. Throttle implementation
- In-memory Map<taskId, lastEventTimestamp> on TaskDB instance
- 30s window checked before insert
- Lifecycle events always pass through (Set check)

## Test Results
- 116 pass, 16 fail (all pre-existing from trg_require_supervision)
- Zero new failures
