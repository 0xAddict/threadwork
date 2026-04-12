# Sprint 6 Implementation Log — DB Hygiene + Hardening

## Date: 2026-04-08

## Deliverables

### 1. run_hygiene MCP tool + DB method
Callable via `run_hygiene(dry_run?)`. Default: dry_run=true (preview only).

Operations:
- **Archive old tasks**: Completed/cancelled tasks >14 days old moved to tasks_archive table
- **Prune progress_events**: Events >14 days old deleted
- **Clean expired artifacts**: Artifacts past expires_at deleted from DB and disk
- **Compress findings**: Findings >7 days old have metrics_json, refs_json, metadata_json NULLed (summaries preserved)
- **Vacuum**: Runs SQLite VACUUM on live execution

### 2. get_db_stats MCP tool + DB method
Returns row counts, oldest/newest timestamps for all major tables:
tasks, notes, memories, findings, artifacts, progress_events, gate_violations, audit_log, task_status_events, agent_sessions

Also reports DB file size in KB.

### 3. tasks_archive table
Created on-demand during hygiene runs. Stores archived task data with archived_at timestamp.

### 4. Audit logging
All hygiene runs are logged to audit trail with dry_run flag and counts.

## Notes
- Feature flags NOT removed for deprecated features (Sprint 6.8) — keeping them as kill switches for now since all features are new and may need rollback
- End-to-end verification (Sprint 6.9) deferred to manual testing after all agents restart with new server

## Test Results
- 116 pass, 16 fail (all pre-existing)
- Build: 0.64 MB, clean
- Zero new failures across all 6 sprints
