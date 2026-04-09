# Threadwork Upgrade Roadmap — 6 Sprints

## Sprint 1: Phase 0 — Foundation
**Goal:** Establish provenance IDs, WAL mode, feature flags, and kill switches before any structural changes.

**Deliverables:**
1. Enable WAL mode + busy_timeout in db.ts (verify with PRAGMA check)
2. Add attempt_id column to tasks table
3. Add result_finding_id column to tasks table  
4. Create feature_flags table with flag_name, enabled, rollout_percent
5. Add feature flag helper functions: isEnabled(flag), setFlag(flag, enabled)
6. Create kill switch flags: blackboard_enabled, progress_events_enabled, gates_enabled
7. Update claimTaskWithSession to increment attempt_id on re-claim
8. All changes backward compatible — existing tools unchanged

## Sprint 2: Phase 1 — Blackboard Findings Store
**Goal:** Add structured findings + artifacts tables and 4 new MCP tools for sub-agent result storage.

**Deliverables:**
1. Create findings table (finding_id, task_id, attempt_id, agent_id, parent_agent_id, finding_type, summary max 1000 chars, status draft/published/superseded, is_final, metrics_json, refs_json, metadata_json, content_hash, priority, expires_at, created_at)
2. Create artifacts table (artifact_id, task_id, attempt_id, agent_id, uri, mime_type, size_bytes, content_hash, created_at, expires_at)
3. Add dedup index on (task_id, attempt_id, content_hash)
4. New MCP tool: write_finding(task_id, finding_type, summary, ...) — returns finding_id
5. New MCP tool: read_findings(task_id, finding_type?, is_final?, limit?) — returns summaries only
6. New MCP tool: read_finding_raw(finding_id) — returns full finding with artifact
7. New MCP tool: write_artifact(task_id, content, mime_type?) — stores to disk, returns artifact_id
8. Gated by blackboard_enabled feature flag
9. Degraded mode: if blackboard unavailable, log warning and continue (never block task completion)

## Sprint 3: Phase 2 — Unified Execution Events
**Goal:** Replace ephemeral write_status with durable progress_events table and structured completion tokens.

**Deliverables:**
1. Create progress_events table (event_id, task_id, attempt_id, agent_id, event_type, percent, activity, metrics_json, detail_ref, created_at)
2. Event types: started, heartbeat, progress, finding_written, completed, failed, abandoned
3. New MCP tool: report_progress(task_id, percent, activity, metrics_json?) with 30s throttle
4. New MCP tool: get_progress(task_id, last_n?, event_type?) — returns durable history
5. Modify complete_task to emit structured completion token and optionally set result_finding_id
6. Keep write_status/read_status as deprecated aliases mapping to progress_events
7. Gated by progress_events_enabled feature flag
8. Throttle: max 1 progress event per 30s per task (configurable)

## Sprint 4: Phase 3 — Resilience (Circuit Breakers + Session Recovery)
**Goal:** Add circuit breaker state machine and improved session recovery to the watchdog.

**Deliverables:**
1. Add circuit_state (closed/open/half_open), fault_count, last_fault_at to agent_sessions
2. Define fault types: timeout, crash, wrong_result, protocol_violation
3. Circuit breaker logic in watchdog: 3 consecutive faults -> open, cooldown -> half_open, probe success -> closed
4. Modify delegate_task to check circuit_state before delegating
5. Add recovery logic: detect dead tmux sessions, log recovery attempt, clear stale state
6. Escalation: open circuit -> alert Boss via send_note
7. Half-open probe: allow one task, monitor result, close or reopen
8. All thresholds configurable via feature flags or config

## Sprint 5: Phase 4 — Communication Gates (Soft Enforcement)
**Goal:** Add gated communication discipline with audit logging and soft violation tracking.

**Deliverables:**
1. Create gate_violations table (id, agent_id, task_id, violation_type, detail, created_at)
2. Gate 1 (Outbound): Wrap delegate_task — validate target exists, log delegation to audit
3. Gate 2 (Inbound): Soft check on complete_task — warn if no findings exist (don't block)
4. Gate 3 (Monitoring): Log oversized summaries (>500 chars) as violations
5. New MCP tool: get_violations(agent_id?, last_n?) — query violation history
6. Soft quarantine: 5 violations in 24h -> reduced delegation priority (not full block)
7. Auto-recovery: quarantine lifts after 4 hours with no new violations
8. Gated by gates_enabled feature flag
9. Calibration framing in all violation messages (not punishment)

## Sprint 6: Phase 5 — DB Hygiene + Hardening
**Goal:** Add retention policies, cleanup routines, and operational dashboards.

**Deliverables:**
1. Archive completed tasks older than 14 days to tasks_archive table
2. Compress findings older than 7 days (move raw artifacts to disk, keep summaries)
3. Prune progress_events older than 14 days
4. Clean up expired artifacts (check expires_at)
5. Add cleanup function callable via MCP tool: run_hygiene(dry_run?)
6. Add DB stats MCP tool: get_db_stats() — table sizes, row counts, age distribution
7. Vacuum scheduling (monthly or on-demand)
8. Remove deprecated feature flags for fully-adopted features
9. Final verification: all 6 phases working together end-to-end
