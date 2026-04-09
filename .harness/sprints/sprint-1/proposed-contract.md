# Sprint 1 Contract — Phase 0 Foundation

## Goal
Establish WAL mode, provenance IDs, feature flags, and kill switches.

## Acceptance Criteria
1. WAL mode enabled (already existed in db.ts lines 91-92)
2. busy_timeout=5000 set (already existed)
3. attempt_id INTEGER column on tasks table
4. result_finding_id INTEGER column on tasks table
5. feature_flags table with flag_name, enabled, created_at
6. Three kill switch flags seeded (blackboard_enabled, progress_events_enabled, gates_enabled)
7. isFeatureEnabled() and setFeatureFlag() helper methods on TaskDB
8. claimTaskWithSession increments attempt_id on re-claim
9. npx tsc --noEmit passes
10. All existing MCP tools backward compatible

## Status: APPROVED