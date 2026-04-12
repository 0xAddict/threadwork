# Sprint 3 Proposed Contract — Unified Execution Events

## Acceptance Criteria

### Functionality (weight 40%, threshold >= 9/10)
1. progress_events table exists with all specified columns and constraints
2. event_type CHECK constraint enforces valid types
3. report_progress creates event and returns event_id
4. report_progress throttles at 30s per task
5. Lifecycle events (started, completed, failed, abandoned) bypass throttle
6. get_progress returns events filtered by task_id with optional event_type
7. complete_task accepts optional result_finding_id and sets it on task row
8. complete_task emits completion event to progress_events
9. write_status also emits to progress_events when flag enabled
10. All new functionality gated by progress_events_enabled flag

### Design Quality (weight 30%, threshold >= 7/10)
- Throttle uses efficient in-memory cache (no DB round-trip for throttle check)
- Fire-and-forget for completion events (never blocks task completion)
- write_status alias preserves backward compatibility
- Event type mapping in alias is reasonable

### Craft (weight 30%, threshold >= 6/10)
- Zero new test failures
- Clean build
- Consistent code style with existing handlers
