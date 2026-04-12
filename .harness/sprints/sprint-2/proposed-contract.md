# Sprint 2 Proposed Contract — Blackboard Findings Store

## Acceptance Criteria

### Functionality (weight 40%, threshold >= 9/10)
1. findings table exists with all specified columns and constraints
2. artifacts table exists with all specified columns and FK to findings
3. Dedup index on (task_id, attempt_id, content_hash) is UNIQUE
4. write_finding creates a finding row and returns finding_id
5. write_finding deduplicates on content_hash (returns existing ID)
6. write_finding rejects summary > 1000 chars
7. read_findings returns summary-level data filtered by task_id
8. read_findings supports finding_type and is_final filters
9. read_finding_raw returns full finding + linked artifacts
10. write_artifact stores content to disk and returns artifact_id + URI
11. All 4 tools gated by blackboard_enabled feature flag
12. Degraded mode: disabled flag returns error/empty, never throws

### Sprint 1 Defect Fixes (weight 20%, threshold >= 9/10)
1. phase0 migration block runs OUTSIDE supervision for-loop (exactly once)
2. feature_flags CREATE TABLE runs OUTSIDE supervision for-loop (exactly once)
3. No duplicate phase0Columns block
4. claimTaskWithSession returns correct (incremented) attempt_id via RETURNING *
5. No separate UPDATE for attempt_id after the main statement

### Design Quality (weight 25%, threshold >= 7/10)
- DB helper methods follow existing patterns (run() wrapper, typed returns)
- MCP tool definitions follow existing schema patterns
- Audit logging on write operations
- Artifact storage uses sensible directory structure
- Content hash provides idempotency

### Craft (weight 15%, threshold >= 6/10)
- No lint errors or type issues
- Clean separation between DB layer and MCP handler
- No unnecessary code duplication
- Zero new test failures
