# Threadwork Upgrade Spec: ClawHarness Integration

## Executive Summary

Integrate ClawHarness's proven patterns into Threadwork's existing task board to solve three critical gaps: context pollution from sub-agent results, ephemeral supervision state, and unstructured inter-agent communication. This is an incremental upgrade — no rewrite required.

## Current State: Threadwork

- **server.ts** (1,190 lines): 35+ MCP tools for tasks, memory, decisions, sub-agent tracking
- **db.ts** (855 lines): SQLite with tasks, notes, memories, audit_log, decision tables, supervision columns
- **memory.ts** (320 lines): Classification tiers, decay, challenge/supersede, dedup
- **watchdog.ts** (742 lines): Kubernetes-style reconciliation loop, heartbeat monitoring, escalation ladder
- **Transport**: tmux sessions with nudge_agent (tmux send-keys)

## Current State: ClawHarness

- **Blackboard** (blackboard.js, 472 lines): Structured findings store — typed results with summary-first reads
- **Three-Gate Architecture**: Outbound delegation gating, inbound completion tokens (100-char max), progress event throttling
- **Transport**: OpenClaw sessions_spawn / sessions_send
- **6-Phase Health Upgrade**: Heartbeats, circuit breakers, session recovery, memory classification, decision lifecycle, DB hygiene

## Gap Analysis

| Capability | Threadwork | ClawHarness | Gap Severity |
|---|---|---|---|
| Sub-agent result storage | Free-form text in parent context | Structured findings table with summary-first reads | **CRITICAL** |
| Completion signaling | Polling via read_status in monitor loop | Push-based 100-char TASK_DONE token | HIGH |
| Progress tracking | write_status (ephemeral snapshots) | progress_events table (durable, queryable history) | HIGH |
| Result deduplication | None | content_hash + partial unique index | MEDIUM |
| Communication discipline | Free-form send_note | Gated with audit + violation sanctions | MEDIUM |
| Context protection | None — raw output enters parent | Blackboard read pattern + artifact compression | **CRITICAL** |
| Circuit breakers | None — just escalation ladder | fault classification + closed/open/half_open states | MEDIUM |
| Session recovery | tmux session check only | Exponential backoff + kill switch | LOW |

---

## Upgrade Plan: 5 Phases

### Phase 1: Blackboard Findings Store
**Priority: CRITICAL | Effort: Medium | Files: db.ts, server.ts**

Add `findings` table to task-board.db:

```sql
CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  parent_agent_id TEXT,
  finding_type TEXT CHECK(finding_type IN ('summary','metric','reference','artifact','error','raw')),
  summary TEXT NOT NULL CHECK(length(summary) <= 500),
  metrics_json TEXT,
  refs_json TEXT,
  metadata_json TEXT,
  raw_path TEXT,
  content_hash TEXT,
  priority INTEGER DEFAULT 0,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_findings_task ON findings(task_id);
CREATE INDEX idx_findings_agent ON findings(agent_id);
CREATE UNIQUE INDEX idx_findings_dedup ON findings(task_id, content_hash) WHERE content_hash IS NOT NULL;
```

New MCP tools:
- `write_finding(task_id, finding_type, summary, metrics_json?, refs_json?, raw_path?)` — sub-agents publish structured results
- `read_findings(task_id, finding_type?)` — parent reads summaries (compact)
- `read_finding_raw(finding_id)` — parent fetches full artifact on demand
- `write_artifact(task_id, content)` — stores large content to disk, returns path

Artifact storage: `~/.claude/workspaces/artifacts/{task_id}/`

**Success criteria:** Sub-agent results queryable without entering parent context. Content deduplication prevents duplicate findings on retry.

### Phase 2: Completion Token Protocol
**Priority: HIGH | Effort: Low | Files: server.ts**

Modify `complete_task` to emit a structured completion token instead of the full result text:

```
TASK_DONE #<task_id> STATUS:<ok|failed|blocked> REF:<first_finding_id>
```

Max 100 characters. The monitor loop or parent agent parses this token and reads findings from the blackboard instead of ingesting raw result text.

Changes:
- `complete_task` returns the token string, not the full result
- `close_subagent` also returns a token
- Monitor loop updated to parse tokens and fetch findings
- Result summary still stored in tasks table for audit, but NOT pushed to parent context

**Success criteria:** Parent context receives <100 chars per completed sub-task regardless of output size.

### Phase 3: Durable Progress Events
**Priority: HIGH | Effort: Medium | Files: db.ts, server.ts**

Replace ephemeral `write_status` with durable `progress_events` table:

```sql
CREATE TABLE progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  percent INTEGER CHECK(percent BETWEEN 0 AND 100),
  activity TEXT NOT NULL,
  metrics_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_progress_task ON progress_events(task_id, created_at);
```

Throttle: Max 1 event per 60 seconds per task (configurable). Duplicate activity strings within the window are silently dropped.

New/modified tools:
- `report_progress(task_id, percent, activity, metrics_json?)` — replaces write_status for progress
- `get_progress(task_id, last_n?)` — replaces read_status with queryable history
- Keep `write_status` as deprecated alias for backward compatibility

**Success criteria:** Full progress history preserved and queryable. Throttling prevents DB bloat. Monitor loop reads progress_events instead of ephemeral status.

### Phase 4: Communication Gates
**Priority: MEDIUM | Effort: Medium | Files: server.ts, new: gates.ts**

Add gated communication discipline:

**Gate 1 (Outbound):** Wrap `delegate_task` and `create_task` in a gatekeeper that:
- Validates target agent exists and is not quarantined
- Logs delegation to audit_log with full context
- Returns delegation receipt

**Gate 2 (Inbound):** Enforce that sub-agents must call `write_finding` before `complete_task`:
- `complete_task` checks that at least one finding exists for the task
- If no findings: reject completion with "Must write at least one finding before completing"
- Exception: tasks marked `kind: 'synthetic'` (sub-agent tracker rows) exempt

**Gate 3 (Monitoring):** Add violation tracking:

```sql
CREATE TABLE gate_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  task_id INTEGER,
  violation_type TEXT NOT NULL,
  detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- Oversized messages (>500 char summaries) logged as violations
- 3 violations on a task = non-compliant flag
- 5 violations per agent in 24h = quarantine flag (blocks new delegations)

**Success criteria:** All agent communication auditable. Bad actors automatically flagged. Findings-first completion enforced.

### Phase 5: Circuit Breakers + DB Hygiene
**Priority: LOW | Effort: Medium | Files: watchdog.ts, db.ts**

**Circuit breakers** on the escalation ladder:

```sql
ALTER TABLE agent_sessions ADD COLUMN circuit_state TEXT DEFAULT 'closed' CHECK(circuit_state IN ('closed','open','half_open'));
ALTER TABLE agent_sessions ADD COLUMN fault_count INTEGER DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN last_fault_at DATETIME;
```

- closed: normal operation
- open: agent has 3+ consecutive faults -> skip delegation, alert boss
- half_open: after cooldown, allow one probe task -> success resets to closed, failure reopens

**DB hygiene** (cron or watchdog-driven):
- Archive completed tasks older than 7 days to `tasks_archive`
- Compress findings older than 3 days (move raw to disk, keep summary)
- Prune progress_events older than 7 days
- Vacuum DB monthly

**Success criteria:** Failing agents automatically circuit-broken. DB size stays bounded.

---

## Migration Strategy

Phases are independent and can ship sequentially. Each phase:
1. Add new tables/columns (backward compatible)
2. Add new MCP tools (old tools still work)
3. Update agent briefings to use new tools
4. Deprecate old tools after team-wide adoption

No breaking changes. Old tools (write_status, read_status, send_note) remain functional throughout migration.

## Metrics

- **Context savings**: Measure parent context token usage before/after blackboard adoption
- **Completion latency**: Time from sub-agent done to parent awareness (polling vs. token)
- **Progress queryability**: Number of historical progress queries served
- **Violation rate**: Gate violations per agent per day (should trend to zero)
- **DB growth**: Findings table size vs. equivalent raw text storage
