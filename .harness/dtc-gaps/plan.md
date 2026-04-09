# Implementation Plan: DTC Gaps

**PRD:** `.harness/dtc-gaps/prd.md`
**Codebase:** `mcp-servers/task-board/`

---

## Sprint 1 -- Phase 4a Memory Classification Gaps

**Goal:** Close 6 gaps between current implementation and the Phase 4a spec.

### Step 1.1: Add `'proposed'` to MemoryState type

**File:** `memory.ts` line 4

```typescript
// BEFORE
export type MemoryState = 'active' | 'disputed' | 'superseded' | 'archived'

// AFTER
export type MemoryState = 'proposed' | 'active' | 'disputed' | 'superseded' | 'archived'
```

### Step 1.2: Extend SaveMemoryInput interface

**File:** `memory.ts` lines 29-36

```typescript
// BEFORE
export interface SaveMemoryInput {
  agent: string
  content: string
  category: string
  importance?: number
  pinned?: boolean
  source_task_id?: number
}

// AFTER
export interface SaveMemoryInput {
  agent: string
  content: string
  category: string
  importance?: number
  pinned?: boolean
  source_task_id?: number
  classification?: Classification
  quality?: number
  source_type?: SourceType
  evidence?: string
  supersedes_memory_id?: number
}
```

### Step 1.3: Update saveMemory() to use new fields + enforce proposed state

**File:** `memory.ts` in `saveMemory()` method (lines 78-115)

After dedup check passes (no existing match found), before INSERT:

```typescript
const classification = input.classification ?? this.inferClassification(input.content, input.category)
const sourceType = input.source_type ?? this.inferSourceType(input.agent)
const quality = input.quality ?? 0.5
const evidence = input.evidence ?? null
const supersedes = input.supersedes_memory_id ?? null

// Spec AC #5: agent + foundational -> proposed state
let state: MemoryState = 'active'
if (sourceType === 'agent' && classification === 'foundational') {
  state = 'proposed'
}
```

Update the INSERT to include all new columns:

```sql
INSERT INTO memories (agent, content, category, importance, pinned, source_task_id,
  classification, quality, state, source_type, evidence, supersedes_memory_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

Pass through: `quality`, `state`, `evidence`, `supersedes`.

### Step 1.4: Update save_memory MCP tool schema

**File:** `server.ts` in the `save_memory` tool definition (~line 143-154)

Add optional properties to inputSchema:

```typescript
classification: {
  type: 'string',
  enum: ['foundational', 'strategic', 'operational', 'observational', 'ephemeral'],
  description: 'Memory classification tier. Defaults based on category. Agent+foundational -> proposed state.'
},
quality: {
  type: 'number',
  description: 'Quality score 0.0-1.0 (default: 0.5). Memories below 0.3 excluded from boot briefing.'
},
source_type: {
  type: 'string',
  enum: ['human', 'agent', 'system', 'consolidation'],
  description: 'Source type (default: agent). Human source can create active foundational directly.'
},
evidence: {
  type: 'string',
  description: 'JSON string of supporting evidence/references.'
},
supersedes_memory_id: {
  type: 'number',
  description: 'ID of memory this supersedes. Creates lineage chain.'
},
```

Update the handler (~line 546-561) to extract and pass these:

```typescript
case 'save_memory': {
  const content = args.content as string
  const category = args.category as string
  const importance = (args.importance as number) ?? 3
  const pinned = (args.pinned as boolean) ?? false
  const classification = args.classification as string | undefined
  const quality = args.quality as number | undefined
  const source_type = args.source_type as string | undefined
  const evidence = args.evidence as string | undefined
  const supersedes_memory_id = args.supersedes_memory_id as number | undefined

  const memory = mem.saveMemory({
    agent: SELF_LABEL,
    content,
    category,
    importance,
    pinned,
    classification: classification as Classification | undefined,
    quality,
    source_type: source_type as SourceType | undefined,
    evidence,
    supersedes_memory_id,
  })
  // ... rest unchanged
}
```

### Step 1.5: Add quality filter to getBootBriefing()

**File:** `memory.ts` in `getBootBriefing()` (lines 220-240)

Add `AND quality >= 0.3` to the topMemories and sharedMemories queries:

```typescript
// BEFORE (topMemories)
`SELECT * FROM memories WHERE agent = ? AND category != 'role' AND state = 'active'
 ORDER BY quality DESC, importance DESC LIMIT 5`

// AFTER
`SELECT * FROM memories WHERE agent = ? AND category != 'role' AND state = 'active'
 AND quality >= 0.3
 ORDER BY quality DESC, importance DESC LIMIT 5`

// BEFORE (sharedMemories)
`SELECT * FROM memories WHERE agent = 'shared' AND state = 'active'
 ORDER BY quality DESC, importance DESC LIMIT 5`

// AFTER
`SELECT * FROM memories WHERE agent = 'shared' AND state = 'active'
 AND quality >= 0.3
 ORDER BY quality DESC, importance DESC LIMIT 5`
```

### Step 1.6: Fix superseded sweep window

**File:** `consolidate.ts` line 67

```typescript
// BEFORE
const superseded = mem.getSupersededOlderThan(7)

// AFTER
const superseded = mem.getSupersededOlderThan(3)
```

### Sprint 1 Verification

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
bunx tsc --noEmit
bun test
```

**Acceptance checklist:**
- [ ] `SaveMemoryInput` has 5 new optional fields
- [ ] `MemoryState` includes `'proposed'`
- [ ] `saveMemory()`: agent+foundational -> state='proposed'
- [ ] `saveMemory()`: passes classification, quality, evidence, supersedes_memory_id to INSERT
- [ ] `save_memory` MCP tool accepts classification, quality, source_type, evidence, supersedes_memory_id
- [ ] `getBootBriefing()` filters `quality >= 0.3`
- [ ] Superseded sweep is 3 days
- [ ] TypeScript compiles
- [ ] Existing callers work with defaults

---

## Sprint 2 -- Phase 5a Decision Records

**Goal:** Add the complete decision record system from scratch.

### Step 2.1: Add decision tables to db.ts migration

**File:** `db.ts` -- add after the existing migration blocks (after the consolidation tables block, around line 333)

```typescript
// Decision record tables (Phase 5a)
this.db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    context TEXT,
    opened_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK(status IN ('open','positions','critique','finalized','expired','cancelled')),
    finalized_by TEXT,
    outcome TEXT,
    outcome_rationale TEXT,
    expires_at TEXT,
    memory_id INTEGER,
    task_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    finalized_at TEXT
  );

  CREATE TABLE IF NOT EXISTS decision_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL REFERENCES decisions(id),
    agent TEXT NOT NULL,
    position TEXT NOT NULL,
    rationale TEXT,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decision_critiques (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL REFERENCES decisions(id),
    position_id INTEGER REFERENCES decision_positions(id),
    agent TEXT NOT NULL,
    critique TEXT NOT NULL,
    severity TEXT DEFAULT 'observation'
      CHECK(severity IN ('observation','concern','blocker')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
  CREATE INDEX IF NOT EXISTS idx_decision_positions_decision ON decision_positions(decision_id);
  CREATE INDEX IF NOT EXISTS idx_decision_critiques_decision ON decision_critiques(decision_id);
`)
```

### Step 2.2: Create decision.ts module

**File:** `decision.ts` (new file)

```typescript
import type { TaskDB } from './db'
import type { MemoryDB } from './memory'

export interface Decision {
  id: number
  title: string
  context: string | null
  opened_by: string
  status: 'open' | 'positions' | 'critique' | 'finalized' | 'expired' | 'cancelled'
  finalized_by: string | null
  outcome: string | null
  outcome_rationale: string | null
  expires_at: string | null
  memory_id: number | null
  task_id: number | null
  created_at: string
  updated_at: string
  finalized_at: string | null
}

export interface DecisionPosition {
  id: number
  decision_id: number
  agent: string
  position: string
  rationale: string | null
  evidence: string | null
  created_at: string
}

export interface DecisionCritique {
  id: number
  decision_id: number
  position_id: number | null
  agent: string
  critique: string
  severity: 'observation' | 'concern' | 'blocker'
  created_at: string
}

export interface DecisionWithDetail extends Decision {
  positions: DecisionPosition[]
  critiques: DecisionCritique[]
}

export class DecisionDB {
  constructor(
    private taskDb: TaskDB,
    private mem: MemoryDB,
  ) {}

  openDecision(title, context, openedBy, opts?): Decision { ... }
  addPosition(decisionId, agent, position, rationale, evidence?): DecisionPosition { ... }
  addCritique(decisionId, agent, critique, opts?): DecisionCritique { ... }
  finalizeDecision(decisionId, finalizedBy, outcome, rationale): Decision { ... }  // ATOMIC
  cancelDecision(decisionId, cancelledBy, reason): Decision { ... }
  expireDecision(decisionId): Decision { ... }
  getDecision(id): DecisionWithDetail | null { ... }
  getOpenDecisions(opts?): Decision[] { ... }
  getDecisionsByStatus(status, limit?): Decision[] { ... }
}
```

Key implementation details:

**`openDecision()`:**
- INSERT into decisions with title, context, opened_by
- If opts.expiresAt provided, set expires_at
- If opts.taskId provided, set task_id
- Return the inserted row

**`addPosition()`:**
- Validate decision exists and status IN ('open', 'positions')
- If status is 'open', UPDATE status to 'positions'
- INSERT into decision_positions
- UPDATE decisions SET updated_at = datetime('now')

**`addCritique()`:**
- Validate decision exists and status IN ('open', 'positions', 'critique')
- If status IN ('open', 'positions'), UPDATE status to 'critique'
- opts: { positionId?: number, severity?: string }
- INSERT into decision_critiques
- UPDATE decisions SET updated_at = datetime('now')

**`finalizeDecision()` -- ATOMIC (Amendment #5):**
- Use `this.taskDb.run(db => { ... })` to get a single db handle
- Within that closure:
  1. SELECT decision, validate status NOT IN ('finalized', 'expired', 'cancelled')
  2. Gather all positions for summary text
  3. UPDATE decisions SET status='finalized', outcome=..., outcome_rationale=..., finalized_by=..., finalized_at=datetime('now'), updated_at=datetime('now')
  4. INSERT INTO memories (agent='shared', content=summary, category='decision', classification='strategic', importance=4, source_type='system', quality=0.8) RETURNING id
  5. UPDATE decisions SET memory_id = new_memory_id WHERE id = decisionId
  6. Return the updated decision
- All 3 SQL statements execute on the SAME db handle inside the `run()` callback -- this is the atomic boundary

**`cancelDecision()`:**
- Validate status NOT IN ('finalized', 'expired', 'cancelled')
- UPDATE decisions SET status='cancelled', outcome_rationale=reason, updated_at=datetime('now')
- Does NOT create memory

**`expireDecision()`:**
- Validate status IN ('open', 'positions', 'critique')
- Same atomic pattern as finalizeDecision but:
  - outcome = "Expired without finalization"
  - status = 'expired'
  - Creates memory with note about expiration

**`getDecision()`:**
- SELECT decision + all positions + all critiques
- Return as DecisionWithDetail

### Step 2.3: Add decision MCP tools to server.ts

**File:** `server.ts`

Import `DecisionDB` at top. Instantiate after MemoryDB:

```typescript
import { DecisionDB } from './decision'
const dec = new DecisionDB(db, mem)
```

Add 6 tool definitions to the tools array:

1. **`open_decision`**
   - Inputs: title (required), context, expires_in_hours, task_id
   - Calls `dec.openDecision(title, context, SELF_LABEL, { expiresAt, taskId })`
   - Posts `formatDecisionOpened()` to group

2. **`submit_position`**
   - Inputs: decision_id (required), position (required), rationale, evidence
   - Calls `dec.addPosition(decision_id, SELF_LABEL, position, rationale, evidence)`

3. **`critique_position`**
   - Inputs: decision_id (required), critique (required), position_id, severity
   - Calls `dec.addCritique(decision_id, SELF_LABEL, critique, { positionId, severity })`

4. **`list_decisions`**
   - Inputs: status (default: 'open'), limit
   - Calls `dec.getDecisionsByStatus(status, limit)` or `dec.getOpenDecisions()` for open

5. **`get_decision_brief`**
   - Inputs: decision_id (required)
   - Calls `dec.getDecision(decision_id)`, formats with `formatDecisionBrief()`

6. **`finalize_decision`**
   - Inputs: decision_id (required), outcome (required), rationale
   - **Boss-only guard:** `if (SELF_LABEL !== 'boss') return error`
   - Calls `dec.finalizeDecision(decision_id, SELF_LABEL, outcome, rationale)`
   - Posts `formatDecisionFinalized()` to group

### Step 2.4: Add decision notify events

**File:** `notify.ts`

Add three new formatter functions:

```typescript
export function formatDecisionOpened(decision: { id: number; title: string; opened_by: string }): string {
  return `🗳 *Decision \\#${decision.id} opened by ${esc(decision.opened_by)}*\n${esc(decision.title)}`
}

export function formatDecisionFinalized(decision: { id: number; title: string; finalized_by: string; outcome: string }): string {
  return `✅ *Decision \\#${decision.id} finalized by ${esc(decision.finalized_by ?? 'unknown')}*\n${esc(decision.title)}\nOutcome: ${esc(decision.outcome ?? '')}`
}

export function formatDecisionExpired(decision: { id: number; title: string }): string {
  return `⏰ *Decision \\#${decision.id} expired*\n${esc(decision.title)}`
}
```

### Step 2.5: Add decision expiry utility

**File:** `decision.ts` -- add as a standalone exported function at the bottom

```typescript
export function expireStaleDecisions(dec: DecisionDB, taskDb: TaskDB): number {
  return taskDb.run(db => {
    const stale = db.prepare(`
      SELECT * FROM decisions
      WHERE status IN ('open', 'positions', 'critique')
      AND expires_at IS NOT NULL
      AND expires_at < datetime('now')
    `).all() as Decision[]

    for (const d of stale) {
      dec.expireDecision(d.id)
    }

    return stale.length
  })
}
```

Optionally call this from `consolidate.ts` during the consolidation run.

### Sprint 2 Verification

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
bunx tsc --noEmit
bun test
```

**Acceptance checklist:**
- [ ] Three tables created: decisions, decision_positions, decision_critiques
- [ ] Three indexes: idx_decisions_status, idx_decision_positions_decision, idx_decision_critiques_decision
- [ ] `openDecision()` returns valid id, stores all fields
- [ ] `addPosition()` links to decision, validates status, auto-transitions to 'positions'
- [ ] `addCritique()` links to decision and optionally position, stores severity
- [ ] `finalizeDecision()` is ATOMIC -- single db handle for status + memory + memory_id update
- [ ] `finalizeDecision()` creates shared memory: category='decision', classification='strategic', importance=4
- [ ] `cancelDecision()` sets status, does NOT create memory
- [ ] `expireDecision()` creates memory with "expired" note
- [ ] `getDecision()` returns decision + positions + critiques
- [ ] Status transitions validated (no finalize on cancelled, no position on finalized, etc.)
- [ ] `finalize_decision` MCP tool is Boss-only (`SELF_LABEL === 'boss'`)
- [ ] Notify formatters use `esc()` for MarkdownV2 safety
- [ ] `expireStaleDecisions()` utility function exists
- [ ] TypeScript compiles
- [ ] All decision operations are non-blocking (no awaits on decision state)

---

## Sprint 3 -- DTC Config + Helpers

**Goal:** Add team topology constants, agent validation utilities, and role specialization.

### Step 3.1: Add team constants to config.ts

**File:** `config.ts` -- add after `SESSION_TIMEOUT_SEC`

```typescript
// DTC Team Topology
export const TEAM_AGENTS = ['boss', 'steve', 'sadie', 'kiera', 'snoopy'] as const
export const WORKER_AGENTS = ['steve', 'sadie', 'kiera', 'snoopy'] as const
export const BOSS_AGENT = 'boss'

export const AGENT_OWNERSHIP: Record<string, string> = {
  boss: 'CEO/orchestrator',
  steve: 'engineering',
  sadie: 'operations',
  kiera: 'intelligence',
  snoopy: 'CRM',
}

export const AGENT_REPORTS_TO: Record<string, string> = {
  steve: 'boss',
  sadie: 'boss',
  kiera: 'boss',
  snoopy: 'boss',
}
```

### Step 3.2: Add utility functions to server.ts

**File:** `server.ts` -- add before the MCP server instantiation or as a utilities section

```typescript
import { TEAM_AGENTS } from './config'

/** Coerce score from various ranges to 0-1 */
function normalizeScore(input: number): number {
  if (input >= 0 && input <= 1) return input
  if (input > 1 && input <= 10) return input / 10
  if (input > 10 && input <= 100) return input / 100
  return Math.max(0, Math.min(1, input))
}

/** Split comma/space-separated agent names, validate each */
function parseAgentList(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0 && isKnownAgent(s))
}

/** Check if agent name is in the known team */
function isKnownAgent(name: string): boolean {
  return (TEAM_AGENTS as readonly string[]).includes(name.toLowerCase())
}
```

### Step 3.3: Update create_task and nudge_agent with isKnownAgent()

**File:** `server.ts`

In `create_task` handler (~line 353-373), replace the `AGENT_SESSIONS[to]` check:

```typescript
// BEFORE
if (!AGENT_SESSIONS[to]) {
  const validAgents = Object.keys(AGENT_SESSIONS).join(', ')
  return { content: [{ type: 'text', text: `Invalid agent "${to}". Valid agents: ${validAgents}`, isError: true }] }
}

// AFTER
if (!isKnownAgent(to)) {
  return { content: [{ type: 'text', text: `Invalid agent "${to}". Valid agents: ${TEAM_AGENTS.join(', ')}`, isError: true }] }
}
```

Similarly in `delegate_task` handler (~line 383-384).

In `nudge_agent` handler (~line 532-543), add validation before calling nudgeAgent:

```typescript
case 'nudge_agent': {
  const agent = (args.agent as string).toLowerCase()
  const message = args.message as string

  if (!isKnownAgent(agent)) {
    return { content: [{ type: 'text', text: `Unknown agent "${agent}". Valid agents: ${TEAM_AGENTS.join(', ')}`, isError: true }] }
  }

  const result = await nudgeAgent(agent, message)
  // ... rest unchanged
}
```

### Step 3.4: Update bot .conf files with sector roles

**File:** `bots/boss.conf`
```
system_prompt=You are Boss, the CEO and primary orchestrator of the threadwork agent team. Sector: CEO/orchestrator. You delegate work, make tiebreaker decisions, and finalize decisions. You do not execute implementation work directly.
append_system_prompt=Team: Steve (engineering), Sadie (operations), Kiera (intelligence), Snoopy (CRM). Monitor via list_tasks and query_audit_log.
```

**File:** `bots/steve.conf`
```
system_prompt=You are Steve, sector owner for engineering on the threadwork agent team. You report to Boss. You handle development, infrastructure, and technical implementation tasks.
append_system_prompt=Teammates: Boss (CEO), Sadie (operations), Kiera (intelligence), Snoopy (CRM). Only Boss creates top-level tasks.
```

**File:** `bots/sadie.conf`
```
system_prompt=You are Sadie, sector owner for operations on the threadwork agent team. You report to Boss. You handle process, logistics, and operational tasks.
append_system_prompt=Teammates: Boss (CEO), Steve (engineering), Kiera (intelligence), Snoopy (CRM). Only Boss creates top-level tasks.
```

**File:** `bots/kiera.conf`
```
system_prompt=You are Kiera, sector owner for intelligence on the threadwork agent team. You report to Boss. You handle research, analysis, and intelligence tasks.
append_system_prompt=Teammates: Boss (CEO), Steve (engineering), Sadie (operations), Snoopy (CRM). Only Boss creates top-level tasks.
```

**File:** `bots/snoopy.conf`
```
system_prompt=You are Snoopy, sector owner for lifecycle CRM and customer intelligence on the threadwork agent team. You report to Boss. You handle customer relationships, lifecycle tracking, and CRM data.
append_system_prompt=Teammates: Boss (CEO), Steve (engineering), Sadie (operations), Kiera (intelligence). Only Boss creates top-level tasks.
```

### Step 3.5: Update seed-roles.ts with sector descriptions

**File:** `seed-roles.ts`

Update ROLES array with sector-specific descriptions:

```typescript
const ROLES = [
  {
    agent: 'boss',
    memories: [
      'You are Boss, the CEO and primary orchestrator of the threadwork agent team. Sector: CEO/orchestrator. You receive requests from the human (Stokes) and delegate work to sector owners. You make tiebreaker decisions, finalize team decisions, and monitor progress. You keep your context clean by delegating all execution work.',
      'Team topology -- Steve: engineering sector owner (development, infrastructure, technical implementation). Sadie: operations sector owner (process, logistics, operational tasks). Kiera: intelligence sector owner (research, analysis, intelligence tasks). Snoopy: CRM sector owner (lifecycle, customer intelligence, relationship management). All report to Boss.',
    ],
  },
  {
    agent: 'steve',
    memories: [
      'You are Steve, engineering sector owner on the threadwork agent team. You report to Boss. You own development, infrastructure, and technical implementation tasks. Claim tasks from the board, spawn subagents for complex work, complete with clear results.',
      'Team -- Boss (CEO/orchestrator), Sadie (operations), Kiera (intelligence), Snoopy (CRM). Only Boss creates top-level task assignments. Nudge teammates for data handoff.',
    ],
  },
  {
    agent: 'sadie',
    memories: [
      'You are Sadie, operations sector owner on the threadwork agent team. You report to Boss. You own process, logistics, and operational tasks. Claim tasks from the board, spawn subagents for complex work, complete with clear results.',
      'Team -- Boss (CEO/orchestrator), Steve (engineering), Kiera (intelligence), Snoopy (CRM). Only Boss creates top-level task assignments. Nudge teammates for data handoff.',
    ],
  },
  {
    agent: 'kiera',
    memories: [
      'You are Kiera, intelligence sector owner on the threadwork agent team. You report to Boss. You own research, analysis, and intelligence tasks. Claim tasks from the board, spawn subagents for complex work, complete with clear results.',
      'Team -- Boss (CEO/orchestrator), Steve (engineering), Sadie (operations), Snoopy (CRM). Only Boss creates top-level task assignments. Nudge teammates for data handoff.',
    ],
  },
  {
    agent: 'snoopy',
    memories: [
      'You are Snoopy, CRM sector owner on the threadwork agent team. You report to Boss. You own lifecycle CRM, customer intelligence, and relationship management tasks. Claim tasks from the board, spawn subagents for complex work, complete with clear results.',
      'Team -- Boss (CEO/orchestrator), Steve (engineering), Sadie (operations), Kiera (intelligence). Only Boss creates top-level task assignments. Nudge teammates for data handoff.',
    ],
  },
]
```

Add supersession logic: check if existing role memory content is outdated and replace:

```typescript
for (const role of ROLES) {
  for (const content of role.memories) {
    const db = (taskDb as any).db
    const exists = db.prepare(
      "SELECT id FROM memories WHERE agent = ? AND category = 'role' AND content = ?"
    ).get(role.agent, content)

    if (!exists) {
      // Check for outdated role memories that should be superseded
      const outdated = db.prepare(
        "SELECT id FROM memories WHERE agent = ? AND category = 'role' AND pinned = 1 AND content != ?"
      ).all(role.agent, content) as { id: number }[]

      // Only supersede if we have new content that replaces old
      // (don't supersede if this is an additional memory, not a replacement)

      mem.saveMemory({
        agent: role.agent,
        content,
        category: 'role',
        importance: 5,
        pinned: true,
        classification: 'foundational',
        source_type: 'system',  // system source -> active state (not proposed)
      })
      seeded++
      console.log(`  Seeded role memory for ${role.agent}`)
    } else {
      console.log(`  Skipped (exists) role memory for ${role.agent}`)
    }
  }
}
```

### Sprint 3 Verification

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
bunx tsc --noEmit
bun test
```

**Acceptance checklist:**
- [ ] `TEAM_AGENTS`, `WORKER_AGENTS`, `BOSS_AGENT` exported from config.ts
- [ ] `AGENT_OWNERSHIP` maps all 5 agents to sectors
- [ ] `AGENT_REPORTS_TO` maps all 4 workers to boss
- [ ] `normalizeScore()` handles 0-1, 1-10, and percentage inputs
- [ ] `parseAgentList()` splits and validates agent names
- [ ] `isKnownAgent()` checks against TEAM_AGENTS
- [ ] `create_task` uses `isKnownAgent()` for validation
- [ ] `delegate_task` uses `isKnownAgent()` for validation
- [ ] `nudge_agent` uses `isKnownAgent()` for validation
- [ ] All 5 bot .conf files have sector role system_prompt
- [ ] `seed-roles.ts` has sector-specific descriptions for all 5 agents
- [ ] `seed-roles.ts` passes `classification: 'foundational'` and `source_type: 'system'` on role saves
- [ ] TypeScript compiles

---

## Execution Order

Sprints 1 and 3 are independent and can be executed in parallel.
Sprint 2 should follow Sprint 1 (decision finalization creates memories using the classification system).

Recommended: Sprint 1 -> Sprint 3 -> Sprint 2 (or Sprint 1 + Sprint 3 in parallel, then Sprint 2).
