# AutoDream Memory Consolidation Daemon — Design Spec

**Date:** 2026-04-05
**Author:** Boss (CEO/Orchestrator)
**Sources:** codex-dtc-rebase-prompt.md, 2026-04-05-llm-council-report.md (Grok 4.20 #1 unanimous)
**Status:** Approved for implementation

---

## 1. Problem

The threadwork memory system accumulates memories across 5 agents (Boss, Steve, Sadie, Kiera, Snoopy) in a shared SQLite database. The DTC rebase adds classification, quality, challenge/supersede primitives — but no automated process to USE them. Memories grow without consolidation, stale facts persist, duplicates accumulate, and temporal references rot. The existing `consolidate.ts` only does simple 7-day importance decay, zero-importance archival, and 90-day archive pruning.

## 2. Solution

An AutoDream-style memory consolidation daemon — a 5-phase automated process that periodically reviews, challenges, supersedes, deduplicates, and prunes memories. Owned by Snoopy (lifecycle CRM agent), running as a background worker in Snoopy's persistent tmux session. Based on the Letta dual-agent pattern: Snoopy is the "sleep-time agent" that performs offline memory transformation.

## 3. Architecture

### 3.1 Schema Migration (db.ts)

Safe ALTER TABLE additions to `memories` and `memory_archive` tables (try/catch pattern for idempotency):

```sql
-- New columns on memories
ALTER TABLE memories ADD COLUMN classification TEXT DEFAULT 'operational';
ALTER TABLE memories ADD COLUMN quality REAL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN state TEXT DEFAULT 'active';
ALTER TABLE memories ADD COLUMN source_type TEXT DEFAULT 'agent';
ALTER TABLE memories ADD COLUMN evidence TEXT;
ALTER TABLE memories ADD COLUMN support_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN challenge_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN supersedes_memory_id INTEGER REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN last_validated TEXT DEFAULT (datetime('now'));

-- Same columns on memory_archive
ALTER TABLE memory_archive ADD COLUMN classification TEXT;
ALTER TABLE memory_archive ADD COLUMN quality REAL;
ALTER TABLE memory_archive ADD COLUMN state TEXT;
ALTER TABLE memory_archive ADD COLUMN source_type TEXT;
ALTER TABLE memory_archive ADD COLUMN evidence TEXT;
ALTER TABLE memory_archive ADD COLUMN support_count INTEGER DEFAULT 0;
ALTER TABLE memory_archive ADD COLUMN challenge_count INTEGER DEFAULT 0;
ALTER TABLE memory_archive ADD COLUMN supersedes_memory_id INTEGER;
ALTER TABLE memory_archive ADD COLUMN last_validated TEXT;
```

New tables:

```sql
CREATE TABLE IF NOT EXISTS consolidation_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  pid INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consolidation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_reason TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  phases_completed TEXT,  -- JSON array of completed phase names
  mutations INTEGER DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  error TEXT
);
```

New indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_memories_classification ON memories(classification);
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
CREATE INDEX IF NOT EXISTS idx_memories_classification_state ON memories(classification, state);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);
CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_memory_id);
```

### 3.2 Memory Primitives (memory.ts)

New methods on `MemoryDB`:

**`normalizeContent(text: string): string`**
Collapse whitespace, trim, lowercase. Used for dedup comparison.

**`inferClassification(content: string, category: string): Classification`**
Heuristic mapping:
- `role` category → `foundational`
- `preference` category → `strategic`
- `fact` category → `operational`
- `task_summary` category → `observational`
- `learning` category → `operational`
- Content containing temporal markers (dates, "today", "yesterday") → `ephemeral`

**`inferSourceType(agent: string): SourceType`**
- `shared` agent → `system`
- `consolidation` tag → `consolidation`
- everything else → `agent`

**`challengeMemory(id: number, reason: string): Memory | null`**
1. Increment `challenge_count`
2. If `challenge_count > support_count`: set `state = 'disputed'`, reduce `quality` by 0.2 (floor 0.0)
3. Log to `audit_log` with action `memory_challenged`
4. Return updated memory

**`supersedeMemory(oldId: number, newContent: string, reason: string): { old: Memory, new: Memory }`**
1. Set old memory `state = 'superseded'`
2. Create new memory with `supersedes_memory_id = oldId`, inheriting agent/category/classification
3. Log to `audit_log` with action `memory_superseded`
4. Return both

**Updated `saveMemory()`**
Before insert: normalize content, check for existing active memory with same normalized content + same agent. If found: bump `support_count` and return existing. Otherwise: infer classification and source_type, then insert.

**Updated `recallMemories()`**
Add `WHERE state != 'superseded'` to base query. Sort by `quality DESC, importance DESC, last_accessed DESC`.

**Updated `getBootBriefing()`**
Filter `state = 'active'` on all queries. Sort topMemories by `quality DESC, importance DESC`.

**Updated `getDecayCandidate()`**
Exclude `classification = 'foundational'` and `state = 'superseded'`.

**Updated `archiveMemory()`**
Copy all new columns (classification, quality, state, etc.) to memory_archive.

### 3.3 Classification-Aware Decay (consolidate.ts)

Replace `runDecay()` with classification-aware version:

```typescript
function getDecayWindowDays(memory: Memory): number {
  const BASE_WINDOWS: Record<string, number> = {
    foundational: Infinity,
    strategic: 14,
    operational: 7,
    observational: 3,
    ephemeral: 1,
  }
  let window = BASE_WINDOWS[memory.classification] ?? 7
  if (memory.state === 'disputed') window = Math.ceil(window / 2)
  if (memory.quality < 0.3) window = Math.ceil(window / 2)
  if (memory.challenge_count > memory.support_count) window = Math.ceil(window / 2)
  return window
}
```

Decay logic: if `daysSinceAccess > decayWindow`, reduce importance by `Math.floor(daysSinceAccess / decayWindow)`.

`runArchive()` updated: also sweep `state = 'superseded'` memories older than 7 days.

### 3.4 Consolidator Daemon (consolidator.ts — NEW FILE)

```typescript
export interface ConsolidationResult {
  runId: number
  triggerReason: string
  phasesCompleted: string[]
  mutations: number
  dryRun: boolean
  summary: string
  durationMs: number
}

export interface HealthReport {
  totalActive: number
  byClassification: Record<string, number>
  byState: Record<string, number>
  disputeRate: number
  avgQuality: number
  lastRunAt: string | null
  lastRunMutations: number | null
}

export class MemoryConsolidator {
  constructor(
    private mem: MemoryDB,
    private taskDb: TaskDB,
    private dryRun: boolean = true,
    private maxMutationsPerRun: number = 50,
  ) {}

  async run(triggerReason: string): Promise<ConsolidationResult>
  async orient(): Promise<HealthReport>
  async gather(health: HealthReport): Promise<Signal[]>
  async validate(signals: Signal[]): Promise<ValidatedAction[]>
  async consolidate(actions: ValidatedAction[]): Promise<Mutation[]>
  async pruneAndIndex(mutations: Mutation[]): Promise<void>
  getHealthReport(): HealthReport
}
```

#### Phase 1: Orient
```sql
SELECT classification, state, COUNT(*) as cnt, AVG(quality) as avg_q,
       SUM(support_count) as total_support, SUM(challenge_count) as total_challenge
FROM memories GROUP BY classification, state
```
Query last 5 consolidation_runs. Generate health report.

#### Phase 2: Gather Signal
- Query `audit_log` for recent memory access patterns (last 24-48h)
- Find memories with same `source_task_id` (cluster candidates)
- Find memories with similar normalized content (dedup candidates)
- Find memories with `last_accessed` older than their decay window (stale candidates)
- Find disputed memories with `challenge_count > support_count + 2`
- Target operational/observational first (fastest decay)

#### Phase 3: Validate
For each candidate action, score:
- Confidence: based on evidence, access_count, support_count
- Risk: based on classification (foundational=blocked, strategic=blocked, operational=medium, observational/ephemeral=low)
- Cross-agent check: if multiple agents reference the same memory, require higher confidence
- Block any action on foundational/strategic memories (log to audit, skip)
- Only proceed if confidence > 0.6
- Confidence formula: `confidence = (access_count / 10 * 0.3) + (support_count / max(support_count + challenge_count, 1) * 0.4) + (quality * 0.3)` — clamped to 0.0-1.0

#### Phase 4: Consolidate
Execute validated actions through DTC primitives:
- `challengeMemory()` for stale/contradicted memories
- `supersedeMemory()` for outdated memories with fresher replacements
- Merge duplicates: keep higher-quality, bump support_count on survivor
- Normalize temporal references: parse relative dates against `created_at`, replace with absolute (use date-fns + heuristic, no LLM)
- Rate limit: stop after `maxMutationsPerRun` (default 50, hard cap 15% of eligible)
- Tag all daemon-created memories with `source_type = 'consolidation'`

#### Phase 5: Prune/Index
- Apply classification-aware decay
- Archive zero-importance memories
- Prune 90-day archive entries
- Log run to `consolidation_runs` table
- If mutations > 5: post summary to Telegram group

### 3.5 Trigger System

Checked every 15 minutes via `setInterval` in Snoopy's session:

```typescript
interface TriggerGates {
  time: boolean      // 6h since last successful run
  volume: boolean    // >25 new/modified or >15% disputed
  idle: boolean      // no task_status_events writes in 45min
  lock: boolean      // consolidation_locks available (no unexpired lock)
}
```

Any gate that passes triggers a run. Lock acquisition uses `BEGIN IMMEDIATE`:

```sql
-- Acquire: delete expired, insert new
BEGIN IMMEDIATE;
DELETE FROM consolidation_locks WHERE expires_at < datetime('now');
INSERT INTO consolidation_locks (agent, expires_at, pid) VALUES ('snoopy', datetime('now', '+10 minutes'), ?);
COMMIT;
```

Release on completion or error (finally block).

### 3.6 MCP Tools (server.ts)

**`consolidate_memories`**
- Params: `scope` (all|operational|agent:NAME), `dryRun` (boolean, default true), `maxChanges` (number, default 50)
- Returns: ConsolidationResult summary
- Access: any agent. Runs consolidation inline (MemoryConsolidator is instantiated per-call). The daemon's setInterval is the automatic trigger; this MCP tool is the manual trigger.

**`get_memory_health_report`**
- Params: none
- Returns: HealthReport with counts by classification/state, dispute rate, avg quality, last run info

**`challenge_memory`**
- Params: `memory_id` (number), `reason` (string)
- Returns: updated Memory
- Access: any agent

**`supersede_memory`**
- Params: `old_memory_id` (number), `new_content` (string), `reason` (string)
- Returns: { old: Memory, new: Memory }
- Access: any agent

### 3.7 Safeguards

1. **Classification protection**: Never auto-mutate foundational or strategic memories. Log the candidate and skip. (Phase 2: route to Boss via `open_decision` when decision system lands.)
2. **Confidence threshold**: Only auto-challenge if quality < 0.6 AND (challenge_count > support_count OR access_count = 0 in decay window)
3. **Rate limit**: Max 15% of eligible memories per run, hard cap at `maxMutationsPerRun`
4. **Source tagging**: All daemon-created/mutated memories tagged `source_type = 'consolidation'`
5. **Full audit**: Every mutation logs before/after state + consolidation_run_id to audit_log
6. **Dry-run mode**: First 2 weeks — logs proposed changes, executes no mutations
7. **Telegram alerts**: Post to group when >5 mutations or any strategic-adjacent action
8. **Hard time limit**: 15-minute max per run, abort remaining phases if exceeded
9. **Reversibility**: Superseded and archived memories remain queryable for 90 days

### 3.8 Integration Points

- **snoopy-bot.ts**: Add `setInterval` that checks trigger gates every 15min, calls `consolidator.run()` when triggered
- **consolidate.ts**: Replace `runDecay()` with classification-aware version. Nightly script still works as standalone fallback.
- **server.ts**: Register 4 new MCP tools
- **config.ts**: Add `CONSOLIDATION_DRY_RUN = true` (flip to false after 2-week validation)

## 4. Completion Promise

The build is DONE when ALL of these pass:

1. `bun test` passes — all existing tests + new tests for:
   - Schema migration (columns exist, defaults correct)
   - challengeMemory (increments count, flips state, reduces quality)
   - supersedeMemory (marks old, creates new with link)
   - Content dedup (same content returns existing, bumps support_count)
   - Classification-aware decay (correct windows per classification)
   - Consolidator 5-phase cycle (dry-run mode, full phase execution)
   - Trigger gate evaluation (time/volume/idle/lock)
   - Lock acquire/release
   - Health report generation
2. `consolidate_memories(dryRun=true)` MCP tool completes a full 5-phase cycle
3. `get_memory_health_report` returns valid stats from live DB
4. Daemon starts from Snoopy's session via snoopy-bot.ts
5. Dry-run summary posts to Telegram group after first triggered run
6. No regressions: existing save_memory, recall_memories, get_boot_briefing still work

## 5. Implementation Units

| # | Unit | File(s) | Depends On | Est LOC |
|---|------|---------|------------|---------|
| 1 | Schema migration | db.ts | — | 60 |
| 2 | Memory primitives | memory.ts | 1 | 120 |
| 3 | Classification-aware decay | consolidate.ts | 1 | 50 |
| 4 | Consolidator daemon | consolidator.ts (NEW) | 1, 2, 3 | 250 |
| 5 | MCP tools | server.ts | 1, 2, 4 | 80 |
| 6 | Snoopy integration | snoopy-bot.ts | 4 | 30 |
| 7 | Tests | tests/*.test.ts | 1-6 | 200 |

**Total: ~790 LOC across 7 units.**

## 6. Rollout Plan

1. **Week 0**: Ship all code with `CONSOLIDATION_DRY_RUN = true`
2. **Week 0-2**: Daemon runs in dry-run mode. Review audit_log for proposed mutations. Validate classification inference accuracy. Tune confidence thresholds.
3. **Week 2**: If dry-run results look clean, flip `CONSOLIDATION_DRY_RUN = false`
4. **Week 2-4**: Live mode with Telegram alerts on every run. Monitor health report daily.
5. **Week 4+**: Reduce alert threshold, tune trigger intervals based on observed volume.

## 7. Out of Scope (deferred)

- Decision system integration (route foundational/strategic mutations to Boss via `open_decision`) — depends on DTC decision system being ported first
- Embedding-based semantic clustering — defer to Phase 2 when memory count exceeds 5k
- Per-agent transactive memory (owner_agent column) — evaluate after 4 weeks of production data
- LLM-based temporal normalization — start with deterministic date-fns parsing only
