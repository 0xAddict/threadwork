# PRD: DTC Gaps -- Memory Classification, Decision Records, and Config Hardening

**Location:** `mcp-servers/task-board/`
**Specs:**
- `TASK-CH-p4a-memory-classification.md` (Phase 4a)
- `TASK-CH-p5a-decision-records.md` (Phase 5a)
- `codex-dtc-rebase-prompt.md` (DTC rebase -- role specialization + config)

## Problem Statement

The task-board MCP server has partial implementations of Phase 4a (memory classification) and is missing Phase 5a (decision records) entirely. Several gaps exist between the current codebase and the spec requirements. Additionally, the DTC config/helper layer (team constants, agent validation, role specialization) is absent.

## Current State Analysis

### Phase 4a -- Memory Classification (PARTIAL)

**Already implemented:**
- DB migration: 9 DTC columns on `memories` and `memory_archive` (ALTER TABLE, try/catch pattern) in `db.ts`
- Indexes: `idx_memories_classification`, `idx_memories_state`, `idx_memories_classification_state`, `idx_memories_last_accessed`, `idx_memories_supersedes`
- `memory.ts`: MemoryDB class with `normalizeContent()`, `inferClassification()`, `inferSourceType()`, dedup on save, `challengeMemory()`, `supersedeMemory()`, quality-aware recall, `getDecayCandidate()` (excludes foundational and superseded), `archiveMemory()` (copies all 18 columns), `getSupersededOlderThan()`
- `consolidate.ts`: `getDecayWindowDays()` with tiered windows, disputed/low-quality halving, `runDecay()`, `runArchive()`
- `server.ts`: `challenge_memory` and `supersede_memory` MCP tools

**Gaps (to spec):**
1. `SaveMemoryInput` interface is missing: `classification`, `quality`, `source_type`, `evidence`, `supersedes_memory_id`
2. `save_memory` MCP tool does not accept or pass through: `classification`, `quality`, `source_type`, `evidence`, `supersedes_memory_id`
3. `saveMemory()` does not enforce agent+foundational -> proposed state (spec AC #5). Currently infers classification but never sets `state = 'proposed'`
4. `MemoryState` type is missing `'proposed'` (spec requires `proposed | active | disputed | superseded | archived`)
5. `getBootBriefing()` does not filter by quality (spec AC #8: `quality IN ('high','medium')` -- since quality is REAL 0-1, this means `quality >= 0.3`)
6. `runArchive()` sweeps superseded at 7 days, spec requires 3 days (spec AC #11)

### Phase 5a -- Decision Records (NOT IMPLEMENTED)

**Nothing exists.** Required:
1. Three new DB tables: `decisions`, `decision_positions`, `decision_critiques` with indexes
2. New `decision.ts` module with `DecisionDB` class and full lifecycle methods
3. Six new MCP tools: `open_decision`, `submit_position`, `critique_position`, `list_decisions`, `get_decision_brief`, `finalize_decision`
4. `finalize_decision` must be Boss-only (check `SELF_LABEL`)
5. `finalizeDecision()` must be ATOMIC -- single transaction for status update + memory creation (Amendment #5)
6. Decision notify events in `notify.ts`
7. Decision expiry check (stale decisions auto-expired)

### DTC Config + Helpers (NOT IMPLEMENTED)

**Nothing exists.** Required:
1. `config.ts`: `TEAM_AGENTS`, `WORKER_AGENTS`, `BOSS_AGENT`, `AGENT_OWNERSHIP`, `AGENT_REPORTS_TO` constants
2. `server.ts`: `normalizeScore()`, `parseAgentList()`, `isKnownAgent()` utilities
3. `isKnownAgent()` validation on `create_task` and `nudge_agent` handlers (currently uses `AGENT_SESSIONS` lookup)
4. Bot `.conf` files with sector role definitions
5. `seed-roles.ts` with sector owner descriptions

## Acceptance Criteria

### Sprint 1 -- Phase 4a Memory Classification Gaps

1. `SaveMemoryInput` interface accepts `classification?`, `quality?`, `source_type?`, `evidence?`, `supersedes_memory_id?`
2. `save_memory` MCP tool schema includes these optional params and passes them through to `saveMemory()`
3. `saveMemory()` enforces: if `source_type === 'agent'` AND `classification === 'foundational'`, set `state = 'proposed'`
4. `MemoryState` type includes `'proposed'`
5. `getBootBriefing()` adds `AND quality >= 0.3` to all memory queries (topMemories and sharedMemories)
6. `runArchive()` superseded sweep changes from 7 days to 3 days
7. TypeScript compiles without errors (`bun build --compile` or `bunx tsc --noEmit`)
8. All existing callers continue to work with defaults (backward compatible)

### Sprint 2 -- Phase 5a Decision Records

1. DB migration adds `decisions`, `decision_positions`, `decision_critiques` tables with correct schemas and indexes
2. `decision.ts` module exports `DecisionDB` class with methods:
   - `openDecision(title, context, openedBy, opts)` returns decision with id
   - `addPosition(decisionId, agent, position, rationale, evidence)` returns position row
   - `addCritique(decisionId, agent, critique, opts)` links to decision, optionally to position, stores severity
   - `finalizeDecision(decisionId, finalizedBy, outcome, rationale)` is ATOMIC: single transaction updates status + creates shared memory (category='decision', classification='strategic', importance=4) + sets memory_id on decision row
   - `cancelDecision(decisionId, cancelledBy, reason)` sets status to 'cancelled', does NOT create memory
   - `expireDecision(decisionId)` auto-finalizes with outcome="Expired without finalization", creates memory
   - `getDecision(id)` returns decision with all positions and critiques
   - `getOpenDecisions(opts)` filters by agent and/or taskId
   - `getDecisionsByStatus(status, limit)` returns decisions matching status
3. Status transitions validated: cannot finalize cancelled/expired decision, cannot add position to finalized decision, etc.
4. Six MCP tools registered in `server.ts`:
   - `open_decision`: any agent can open
   - `submit_position`: validates decision is in open/positions status
   - `critique_position`: validates decision is in open/positions/critique status
   - `list_decisions`: filter by status, default=open
   - `get_decision_brief`: returns formatted decision with positions and critiques
   - `finalize_decision`: Boss-only (check `SELF_LABEL === 'boss'`), calls atomic `finalizeDecision()`
5. Notify events added to `notify.ts`: `formatDecisionOpened()`, `formatDecisionFinalized()`, `formatDecisionExpired()`
6. Decision expiry function: `expireStaleDecisions()` queries decisions where `expires_at < datetime('now')` and status in ('open','positions','critique'), calls `expireDecision()` for each
7. TypeScript compiles without errors
8. All decision operations are async/non-blocking

### Sprint 3 -- DTC Config + Helpers

1. `config.ts` exports:
   - `TEAM_AGENTS = ['boss', 'steve', 'sadie', 'kiera', 'snoopy']`
   - `WORKER_AGENTS = ['steve', 'sadie', 'kiera', 'snoopy']`
   - `BOSS_AGENT = 'boss'`
   - `AGENT_OWNERSHIP: Record<string, string>` mapping agent -> sector (boss=CEO/orchestrator, steve=engineering, sadie=operations, kiera=intelligence, snoopy=CRM)
   - `AGENT_REPORTS_TO: Record<string, string>` mapping agent -> supervisor (workers report to boss)
2. `server.ts` exports or uses:
   - `normalizeScore(input: number): number` -- coerces 0-1, 1-10, or percentage inputs to 0-1 range
   - `parseAgentList(input: string): string[]` -- splits comma/space-separated agent names, validates each
   - `isKnownAgent(name: string): boolean` -- checks against `TEAM_AGENTS`
3. `create_task` handler validates target with `isKnownAgent()` (in addition to or replacing `AGENT_SESSIONS` check)
4. `nudge_agent` handler validates target with `isKnownAgent()`
5. Bot `.conf` files updated with sector role definitions in `system_prompt` or `append_system_prompt`:
   - `boss.conf`: CEO/orchestrator sector
   - `steve.conf`: engineering sector owner
   - `sadie.conf`: operations sector owner
   - `kiera.conf`: intelligence sector owner
   - `snoopy.conf`: lifecycle CRM and customer intelligence owner
6. `seed-roles.ts` updated with DTC sector owner role descriptions per agent
7. TypeScript compiles without errors

## Non-Goals

- Full adversarial review fixes (TOCTOU, normalization mismatch, JSONL parsing) -- separate ticket
- Pin/unpin classification zombie fix -- separate ticket
- Unconditional startup UPDATE optimization -- separate ticket
- CLI commands for decisions (task-board-cli.js does not exist in this codebase -- the MCP tools ARE the interface)
- Taxonomy module (not present in this codebase; CHECK constraints live in DB migration)

## Dependencies

- Sprint 2 depends on Sprint 1 (decision finalization creates a memory with classification fields)
- Sprint 3 is independent of Sprints 1-2 (config/helper layer)

## Files Modified

| Sprint | File | Change |
|--------|------|--------|
| 1 | `memory.ts` | Update `SaveMemoryInput`, `MemoryState`, `saveMemory()`, `getBootBriefing()` |
| 1 | `server.ts` | Update `save_memory` tool schema and handler |
| 1 | `consolidate.ts` | Change superseded sweep from 7 -> 3 days |
| 2 | `db.ts` | Add decision tables migration |
| 2 | `decision.ts` | New file: `DecisionDB` class |
| 2 | `server.ts` | Add 6 decision MCP tools |
| 2 | `notify.ts` | Add decision notification formatters |
| 3 | `config.ts` | Add team constants |
| 3 | `server.ts` | Add utility functions, `isKnownAgent()` validation |
| 3 | `bots/*.conf` | Add sector role definitions |
| 3 | `seed-roles.ts` | Update with DTC sector descriptions |
