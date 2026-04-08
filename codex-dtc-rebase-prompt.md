# Codex Task: Clean rebase of DTC decision-team features onto main

## Context

The `codex/dtc-decision-team` branch (3 commits: `0f622ae`, `fbd574a`, `cf395e2`) was built on top of an unmerged copy of main, which caused massive file duplication between root and `mcp-servers/task-board/`. The canonical source location is `mcp-servers/task-board/` — that's where the MCP server runs from (see `mcp.json`). Root-level copies (server.ts, memory.ts, db.ts, config.ts, consolidate.ts, decision.ts) are duplicates that should not exist.

The goal is to land the branch's NEW functionality cleanly onto current main (`97312f4`) without carrying the duplication. Main already has some infrastructure the branch was built on (status tools, interrupt, audit, MarkdownV2 from the `feat/delegation-infrastructure` merge).

## What to port from the branch (the actual new work)

### 1. Decision system (entirely new)
- New file: `mcp-servers/task-board/decision.ts` — DecisionDB class with full lifecycle (create, submit position, critique, finalize, get brief)
- New DB tables in `mcp-servers/task-board/db.ts`: `decisions`, `decision_positions`, `decision_critiques` with indexes
- New MCP tools in `mcp-servers/task-board/server.ts`: `open_decision`, `submit_position`, `critique_position`, `list_decisions`, `get_decision_brief`, `finalize_decision`
- `finalize_decision` is Boss-only (checked via SELF_LABEL)
- On finalization: creates shared decision memory + per-agent calibration memories
- New test: `mcp-servers/task-board/tests/decision.test.ts`

### 2. Memory system overhaul
- New columns on `memories` and `memory_archive` tables: `classification`, `quality`, `state`, `source_type`, `evidence`, `support_count`, `challenge_count`, `supersedes_memory_id`, `last_validated`
- Safe ALTER TABLE migration for existing DBs (try/catch pattern already on main for nudge_count)
- `mcp-servers/task-board/memory.ts` changes:
  - Content deduplication on save (normalizeContent, check existing, bump support_count)
  - `challengeMemory()` method — downgrades quality, flips to 'disputed' state
  - `supersedeMemory()` method — marks old as superseded, creates replacement
  - `inferClassification()` and `inferSourceType()` helpers
  - `mergeEvidence()` helper
  - Updated `recallMemories()` — excludes superseded, sorts by state/quality
  - Updated `getBootBriefing()` — filters by state='active', sorts by quality
  - Updated `getDecayCandidate()` — excludes foundational and superseded
  - Updated `archiveMemory()` — copies new columns to archive
- New MCP tools: `challenge_memory`, `supersede_memory`
- Updated `save_memory` tool — accepts classification, quality, evidence params
- Updated `recall_memories` display — shows classification/state/quality
- New memory test cases in `mcp-servers/task-board/tests/memory.test.ts`: dedup, challenge, supersede

### 3. Classification-aware decay (`mcp-servers/task-board/consolidate.ts`)
- New `getDecayWindowDays()` function with tiered windows: foundational=infinity, strategic=14d, operational=7d, observational=3d, ephemeral=1d
- Modifiers: disputed halves window, low quality halves window
- Accelerated decay when challenge_count > support_count
- `runArchive()` now also sweeps superseded memories

### 4. Role specialization and Snoopy
- `mcp-servers/task-board/config.ts`: Add `TEAM_AGENTS`, `WORKER_AGENTS`, `BOSS_AGENT`, `AGENT_OWNERSHIP`, `AGENT_REPORTS_TO` constants. Add Snoopy to `AGENT_SESSIONS`.
- MCP server instructions updated with sector ownership, delegation model, counter-narrative policy
- `bots/boss.conf`, `bots/steve.conf`, `bots/sadie.conf`, `bots/kiera.conf` — rewrite with focused system_prompt + append_system_prompt for DTC sector roles
- New `bots/snoopy.conf` — lifecycle CRM and customer intelligence owner
- `seed-roles.ts` — updated with DTC sector owner role descriptions, supersession logic for outdated roles, refresh logic for existing roles, Snoopy added
- `scripts/launch-all.sh` — add claude-snoopy session
- `scripts/telegram-pool.sh` — add Snoopy bot entry, fix `local` variable declarations (real bug fix)

### 5. Server.ts tool additions and updates
- `normalizeScore()` utility — coerces 0-1, 1-10, or percentage inputs
- `parseAgentList()` utility — validates agent names
- `formatDecisionBrief()` — text formatter for decision briefs
- `isKnownAgent()` validation on create_task, nudge_agent
- Audit logging on all existing actions (task_created, task_claimed, task_completed, note_added, agent_nudged, memory_saved, memory_recalled, boot_briefing, memory_promoted, memory_pinned)
- Updated integration test for Snoopy
- Updated nudge test for Snoopy

## Known issues to fix during the port (from adversarial review)

1. **TOCTOU in decision lifecycle** — Wrap `finalizeDecision()`, `submitPosition()`, and `critiquePosition()` in SQLite transactions (BEGIN IMMEDIATE...COMMIT) to prevent race conditions with concurrent agents.

2. **Dedup normalization mismatch** — The JS `normalizeContent()` collapses whitespace but the SQL `LOWER(TRIM(content))` does not. Fix: use `REPLACE(LOWER(TRIM(content)), '  ', ' ')` in SQL, or normalize before insert and compare against normalized stored value.

3. **Unconditional startup UPDATE** — The `UPDATE memories SET last_validated = COALESCE(...)` runs on every boot even when all rows are already migrated. Add `WHERE last_validated IS NULL` (and similar for other columns).

4. **MarkdownV2 in decision notifications** — The `open_decision` and `finalize_decision` group posts use raw strings with unescaped `#` and user content. Use the `esc()` function from notify.ts.

5. **JSONL parsing** — Wrap `JSON.parse(l)` in `read_status` and `clear_status` in try/catch per line to handle malformed entries gracefully.

6. **pinMemory classification zombie** — When unpinning, revert classification from 'foundational' back to the inferred classification (use `inferClassification` or store original).

## What NOT to port

- Root-level duplicates: `server.ts`, `memory.ts`, `db.ts`, `config.ts`, `consolidate.ts`, `decision.ts`, `tests/decision.test.ts`, `tests/memory.test.ts`, `tests/integration.test.ts`, `tests/nudge.test.ts` — these are copies of the mcp-servers files and should not exist at root.
- Any changes that main already has from the `feat/delegation-infrastructure` merge (status tools, interrupt, audit logging, MarkdownV2 basics).

## Validation

After porting, run: `cd mcp-servers/task-board && bun test` — all tests should pass including the new decision and memory tests.
