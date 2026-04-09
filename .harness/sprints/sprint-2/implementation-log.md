# Sprint 2 Implementation Log — Blackboard Findings Store

## Date: 2026-04-08

## Sprint 1 Defect Fixes

### Defect 1: Phase0 migration nested inside supervision loop
**File:** db.ts lines 250-281
**Problem:** The phase0 columns block and feature_flags CREATE TABLE were incorrectly nested inside the `for (const sql of supervisionColumns)` loop due to missing closing braces. This caused the code to execute 14 times (once per supervision column) instead of once. A duplicate phase0Columns block existed outside the loop.
**Fix:** Added proper closing brace `}` for the supervision loop, removed the duplicate phase0 block, and placed the feature_flags table creation outside both loops. Code now executes once as intended.

### Defect 2: Stale attempt_id in returned Task from claimTaskWithSession
**File:** db.ts, claimTaskWithSession method
**Problem:** `attempt_id = COALESCE(attempt_id, 0) + 1` ran as a separate UPDATE after `RETURNING *`, so the returned Task object had `attempt_id=0` (pre-increment value).
**Fix:** Merged `attempt_id = COALESCE(attempt_id, 0) + 1` directly into the main UPDATE statement before the RETURNING clause. The returned Task now reflects the incremented attempt_id.

## Sprint 2 Deliverables

### 1. Findings table (db.ts migrate())
Created `findings` table with all specified columns:
- finding_id (INTEGER PK AUTOINCREMENT)
- task_id, attempt_id, agent_id, parent_agent_id
- finding_type TEXT NOT NULL
- summary TEXT NOT NULL (enforced max 1000 chars in writeFinding)
- status TEXT DEFAULT 'draft' CHECK(status IN ('draft','published','superseded'))
- is_final INTEGER DEFAULT 0
- metrics_json, refs_json, metadata_json TEXT
- content_hash TEXT (SHA-256 first 16 hex chars)
- priority TEXT DEFAULT 'normal'
- expires_at TEXT, created_at TEXT DEFAULT datetime('now')

### 2. Artifacts table (db.ts migrate())
Created `artifacts` table:
- artifact_id (INTEGER PK AUTOINCREMENT)
- task_id, finding_id (FK to findings), attempt_id, agent_id
- uri TEXT NOT NULL (path to file on disk)
- mime_type TEXT DEFAULT 'text/plain'
- size_bytes INTEGER, content_hash TEXT
- created_at, expires_at TEXT

### 3. Dedup index
Created UNIQUE index `idx_findings_dedup` on `(task_id, attempt_id, content_hash)` WHERE content_hash IS NOT NULL.
Additional indexes: idx_findings_task, idx_findings_type, idx_artifacts_task, idx_artifacts_finding.

### 4. write_finding MCP tool
- Computes SHA-256 content hash for dedup
- Checks for existing finding with same task_id + attempt_id + content_hash
- Returns existing finding_id if duplicate (idempotent)
- Validates summary <= 1000 chars
- Gated by blackboard_enabled feature flag

### 5. read_findings MCP tool
- Returns summary-level data only (no metrics/refs/metadata JSON)
- Filters by task_id (required), finding_type, is_final
- Default limit: 50
- Returns empty array if blackboard disabled

### 6. read_finding_raw MCP tool
- Returns full finding with all fields + linked artifacts array
- Returns null if blackboard disabled

### 7. write_artifact MCP tool
- Stores content to disk at artifacts/{task_id}/{artifact_id}.{ext}
- Creates directories as needed
- Determines file extension from mime_type (json/html/txt)
- Computes content hash
- Stores URI in DB pointing to file path
- Gated by blackboard_enabled feature flag

### 8. Feature flag gating
All 4 tools check `isFeatureEnabled('blackboard_enabled')`. When disabled:
- write_finding/write_artifact return error message (not exception)
- read_findings returns empty array
- read_finding_raw returns null
This ensures degraded mode never blocks task completion.

## Test Results
- 116 pass, 16 fail (all pre-existing from trg_require_supervision trigger)
- Zero new failures from Sprint 2 changes
