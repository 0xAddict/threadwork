# Decision Framework

## Overview

The Decision Framework provides structured async deliberation for consequential choices. Instead of an agent making a unilateral call, decisions flow through a four-status lifecycle: positions are submitted by any agent, critiques are layered on top, and Boss finalizes with an outcome. Finalization atomically creates a shared memory so the decision persists into team knowledge.

Decisions are also the output format of the Debrief System — every session debrief creates and finalizes a decision record.

**Source:** `mcp-servers/task-board/decision.ts`

## Status Lifecycle

```
open
  └─ (first position submitted) -> positions
       └─ (first critique submitted) -> critique
            ├─ (Boss calls finalize_decision) -> finalized
            └─ (expires_at passes, watchdog expires) -> expired
```

Any agent can move a decision forward by submitting a position or critique. Only Boss can finalize. Any agent can cancel (sets status to `cancelled`).

| Status | Meaning |
|--------|---------|
| `open` | Just created, no positions yet |
| `positions` | At least one position submitted |
| `critique` | At least one critique submitted |
| `finalized` | Outcome recorded, memory created |
| `expired` | `expires_at` passed without finalization |
| `cancelled` | Explicitly cancelled by an agent |

Transitions are automatic on write. Submitting a position on an `open` decision moves it to `positions`. Submitting a critique on a `positions` decision moves it to `critique`. No explicit status update tool is needed.

## MCP Tools

### `open_decision`

Open a new decision record. Any agent can open.

```typescript
{
  title: string          // Required. Short label for the decision.
  context?: string       // Why this decision is needed, background info.
  expires_in_hours?: number  // Hours until auto-expiry. Omit for no expiry.
  task_id?: number       // Optional link to the originating task.
}
```

**Side effects:** Posts to the Telegram group.

**Returns:** Decision ID. Pass this to other agents so they can submit positions.

### `submit_position`

Submit a named stance with rationale. Any agent can submit. Multiple agents can each submit their own position.

```typescript
{
  decision_id: number    // Required.
  position: string       // Required. Your recommendation or stance.
  rationale?: string     // Why you hold this position.
  evidence?: string      // Supporting data or references.
}
```

**Auto-transition:** If decision is `open`, moves it to `positions`.

**Constraint:** Can only be called when decision status is `open` or `positions`. Critique or finalized decisions no longer accept positions.

### `critique_position`

Critique a position or the decision as a whole. Any agent can critique.

```typescript
{
  decision_id: number    // Required.
  critique: string       // Required. Your critique text.
  position_id?: number   // Optional. Target a specific position.
  severity?: string      // "observation" | "concern" | "blocker" (default: observation)
}
```

**Severity levels:**
- `observation` — minor note, informational
- `concern` — raises a question that should be addressed
- `blocker` — critical issue, should block finalization

**Auto-transition:** If decision is `open` or `positions`, moves it to `critique`.

### `list_decisions`

List decisions. Defaults to all open-family statuses (`open`, `positions`, `critique`).

```typescript
{
  status?: string   // Filter by status. "open" returns all open-family statuses.
  limit?: number    // Max results (default: 50)
}
```

### `get_decision_brief`

Get a formatted brief with all positions and critiques for a decision.

```typescript
{
  decision_id: number
}
```

**Returns:** Decision record including all positions and critiques in submission order.

### `finalize_decision`

Finalize a decision with an outcome. **Boss only.** Non-Boss agents will receive an error.

```typescript
{
  decision_id: number    // Required.
  outcome: string        // Required. The final decision.
  rationale: string      // Required. Why this outcome was chosen.
}
```

**Side effects (atomic transaction):**
1. Sets decision `status = 'finalized'`, records `finalized_by`, `outcome`, `outcome_rationale`, `finalized_at`
2. Creates a shared memory: category `decision`, classification `strategic`, importance 4, quality 0.8
3. Links `memory_id` back to the decision row
4. Posts to the Telegram group

If any step fails, the whole transaction rolls back and the decision stays in its previous state.

## Auto-Expiry

The watchdog calls `expireStaleDecisions` each cycle. Any open decision with `expires_at < now` is expired automatically. Expiry also creates a shared memory (same atomic pattern as finalization) noting that the decision expired without resolution. The memory content includes any positions that were submitted.

To set a deadline when opening:

```
open_decision(title="...", expires_in_hours=24)
```

## Memory on Finalization

When a decision is finalized (or expired), a shared memory is created with these attributes:

| Field | Value |
|-------|-------|
| `agent` | `shared` |
| `category` | `decision` |
| `classification` | `strategic` |
| `importance` | 4 |
| `quality` | 0.8 |
| `state` | `active` |
| `source_type` | `system` |

The memory content format:

```
Decision #{id}: {title}
Outcome: {outcome}
Rationale: {rationale}
Positions: {agent}: {position}; {agent}: {position}; ...
```

This means important decisions automatically survive into every agent's `get_boot_briefing` (shared memories, quality >= 0.3).

## Integration with the Debrief System

Every session debrief uses the decision framework as its output layer:

1. Debrief Phase 2 (Solicit) opens a decision and submits positions for each active agent
2. Debrief Phase 3 (Synthesize) finalizes the decision with the synthesis text as the outcome
3. `finalize_decision` is called by `debrief-daemon` (the only non-Boss finalizer, which is an internal bypass)

This means every debrief creates an auditable record in both `debrief_runs` and `decisions`, cross-linked via `decision_id`.

## Database Schema

```sql
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  context TEXT,
  opened_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open, positions, critique, finalized, expired, cancelled
  finalized_by TEXT,
  outcome TEXT,
  outcome_rationale TEXT,
  expires_at TEXT,
  memory_id INTEGER REFERENCES memories(id),
  task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT
);

CREATE TABLE decision_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  agent TEXT NOT NULL,
  position TEXT NOT NULL,
  rationale TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE decision_critiques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  position_id INTEGER REFERENCES decision_positions(id),
  agent TEXT NOT NULL,
  critique TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'observation',  -- observation, concern, blocker
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Example: Multi-Agent Architecture Decision

```
1. Boss opens the decision:
   open_decision(title="Choose caching strategy for product feed",
     context="Current approach is too slow. Options: Redis, in-memory, CDN.",
     expires_in_hours=4)
   -> decision #12

2. Steve submits a technical position:
   submit_position(decision_id=12,
     position="Use Redis with 5-minute TTL",
     rationale="Shared cache across instances, easy to invalidate")

3. Sadie submits an operational position:
   submit_position(decision_id=12,
     position="Use CDN edge caching",
     rationale="No infrastructure to manage, cheaper at scale")

4. Kiera critiques:
   critique_position(decision_id=12,
     critique="CDN invalidation latency is 30-60s — problematic for inventory accuracy",
     severity="concern")

5. Boss finalizes:
   finalize_decision(decision_id=12,
     outcome="Use Redis with 5-minute TTL",
     rationale="Real-time accuracy requirement rules out CDN. Redis cost acceptable.")
   -> creates shared memory #47
```
