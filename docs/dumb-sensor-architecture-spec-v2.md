# Dumb Sensor + Smart Wakeup Architecture — Spec v2

**Author:** Boss
**Date:** 2026-04-09
**Status:** DRAFT v2 — incorporates Codex review findings from v1
**Supersedes:** v1 (`dumb-sensor-architecture-spec.md`), Task #217 (Agent Comms A+ Upgrade)

## Changes from v1

Codex found 7 issues in v1 (2 critical, 3 high, 2 medium). v2 addresses all of them:

| v1 Finding | v2 Fix |
|---|---|
| Not exactly-once delivery; no lease, no claim | Per-agent **mailbox** table with lease columns; dispatcher uses `UPDATE ... WHERE lease_owner IS NULL RETURNING` pattern |
| "Transactional outbox" claim was wrong — separate `emit_event()` can't atomically wrap state changes in other tools | Events written **inside every mutator** on the same `Database` handle in the same transaction. No separate tool. Enforced by code review + tests. |
| `decision_ready` partial unique index lets duplicates through after consume; raises INSERT errors | Unconditional unique key `(dedup_key)` + `INSERT ... ON CONFLICT DO NOTHING`. Dedup key is a hash, not consumed state. |
| Stall scanner uses `last_progress_at` which moves on unrelated calls | Replaced with explicit **worker lease heartbeat** — agents hold a lease on their claimed task and renew it explicitly. No lease renewal for 30 min → stall event. |
| Migration runs dumb-sensor alongside old watchdog → double delivery. Also agents can't read events. | Phased migration with a **hard cutover flag** (`TIER1_DISPATCH_ENABLED`). Dumb-sensor only dispatches when flag is on; old watchdog stops dispatching when flag is on. Agents get new MCP tools (`read_events`, `ack_event`, `heartbeat_lease`) in phase 0, before any cutover. |
| Ordering by `created_at` text — no stable order; and 5 events = 5 wakeups kills savings | Order by `id` (INTEGER PK, monotonic). Dispatcher **coalesces**: one wake per agent per cycle, batched. |
| No singleton protection | Dumb-sensor acquires the same `watchdog_lease` row the old watchdog uses. Single writer enforced. |

## Architecture

### Tier 0 — Atomic Event Emission (in every mutator)

Any code path that mutates `tw_tasks`, `tw_decisions`, `tw_status_log`, or the circuit breaker MUST emit its event inside the same transaction. This is a coding standard enforced by tests, not by a middleware.

Example (pseudocode, real sites listed in §Migration):

```ts
// db.ts — claimTaskWithSession
db.transaction(() => {
  db.prepare('UPDATE tw_tasks SET to_agent=?, status=? WHERE id=?').run(...)
  emitEvent(db, {
    target_agent: to_agent,
    event_type: 'task_assigned',
    task_id: id,
    dedup_key: `task_assigned:${id}:${to_agent}`,
    payload_json: JSON.stringify({ ... }),
    urgency: priority,
  })
})()
```

`emitEvent(db, ...)` is a pure function taking an already-open DB handle. It does NOT open its own transaction. It does NOT go through an MCP tool. It's a single `INSERT ... ON CONFLICT(dedup_key) DO NOTHING`.

**No separate `emit_event` MCP tool exists.** That was the v1 mistake.

### Tier 1 — Dumb Sensor (no LLM, single process)

A single long-lived bun script. Run via launchd with a 30s poll cycle. Holds the existing `watchdog_lease` (same DB row the old watchdog uses) for mutual exclusion.

Cycle loop (pseudocode):

```ts
acquireWatchdogLease() || exit(0)   // singleton guarantee

runSessionLiveness()                 // tmux has-session, mark dead
runStallScanner()                    // see §Stall
dispatchMailboxes()                  // see §Dispatch
```

No Claude calls. No Gemini Flash. Pure SQL + shell.

### Tier 2 — Agent Protocol

Each agent has new MCP tools:

- `read_mailbox()` — returns all unconsumed events in the agent's mailbox, ordered by `id`. One call per wakeup.
- `ack_event(event_id)` — marks a single event consumed.
- `ack_batch(event_ids[])` — marks a batch consumed atomically.
- `heartbeat_lease(task_id)` — agent explicitly renews its lease on a claimed task. Required every 5 minutes while actively working. Renewal is cheap (one UPDATE).
- `release_lease(task_id, reason)` — explicit pause / drop / complete.

Wakeup string sent via tmux is always identical and minimal:

```
[mailbox] wake: you have N events. Call read_mailbox() then ack each.
```

Where `N` is the agent's unconsumed event count. That's the entire nudge payload. ~80 bytes.

### Tier 1 Dispatch Algorithm

Per cycle, for each agent with at least one unconsumed mailbox row:

```sql
-- Atomic claim: pick up to K events, set lease
UPDATE tw_mailbox
SET lease_owner = :dispatcher_id,
    lease_expires_at = datetime('now', '+60 seconds'),
    delivered_at = datetime('now')
WHERE id IN (
  SELECT id FROM tw_mailbox
  WHERE target_agent = :agent
    AND consumed_at IS NULL
    AND (lease_owner IS NULL OR lease_expires_at < datetime('now'))
  ORDER BY id
  LIMIT 50
)
RETURNING id;
```

If any rows returned → send ONE tmux wakeup to the agent with the count.

**Coalesced:** 5 events = 1 wake. Batch size 50 caps the worst case.

Leases expire in 60s. If the agent doesn't ACK within 60s, the next cycle re-leases and re-wakes (once). If still no ACK after 3 re-wakes, emit `escalate_to_boss` event for THAT mailbox and give up delivery.

**Singleton-safe:** the `WHERE lease_owner IS NULL OR lease_expires_at < now()` predicate plus `RETURNING` gives us an atomic claim. Two sensor instances cannot both grab the same row. (SQLite serializes writes; the `UPDATE...WHERE` condition is evaluated under the write lock.)

### Worker Lease Heartbeat (replaces stall scanner)

The real fix for "awake but silent" is making the agent renew a lease on its claimed task. Two new columns on `tw_tasks`:

```sql
ALTER TABLE tw_tasks ADD COLUMN worker_lease_at TEXT;
ALTER TABLE tw_tasks ADD COLUMN worker_lease_timeout_sec INTEGER DEFAULT 300;
```

Agent contract:
- On claim: `worker_lease_at = now()`.
- Every tool call the agent makes that touches the task (write_status, send_note, add subtask, etc.) automatically refreshes `worker_lease_at`. This happens server-side, the agent doesn't remember anything.
- If the agent goes quiet for > `worker_lease_timeout_sec` without any tool call that touches the task, the stall scanner emits ONE `stall_warning` mailbox event for that task.
- After 2 consecutive stall warnings with no lease renewal → `escalate_to_boss` event.

The stall scanner is:

```sql
SELECT t.id, t.to_agent
FROM tw_tasks t
WHERE t.status = 'in_progress'
  AND t.worker_lease_at < datetime('now', '-' || t.worker_lease_timeout_sec || ' seconds')
  AND NOT EXISTS (
    SELECT 1 FROM tw_mailbox m
    WHERE m.target_agent = t.to_agent
      AND m.dedup_key = 'stall_warning:' || t.id
      AND m.consumed_at IS NULL
  );
```

Dedup is handled by the unique constraint on `dedup_key`. The stall scanner does `INSERT ... ON CONFLICT DO NOTHING` — if there's already an unconsumed stall warning, nothing happens.

**Why this fixes v1 finding #4:** `worker_lease_at` is bumped server-side on every tool call that references the task. It's not a progress signal — it's an activity signal. An agent that is genuinely stuck and not making tool calls will stop renewing. An agent doing long-think work on a research task can increase `worker_lease_timeout_sec` when it claims the task.

### Dedup Key Convention

Every event row has a `dedup_key` text column with a **UNIQUE INDEX**. Format:

```
<event_type>:<primary_id>[:<extra>]
```

Examples:
- `task_assigned:1234:steve`
- `decision_ready:42`
- `stall_warning:1234`
- `circuit_open:boss`
- `session_dead:kiera:1775724251`  (session dead uses a timestamp to allow re-emission for a new death)

When an emitter wants to send an event, it uses `INSERT ... ON CONFLICT(dedup_key) DO NOTHING`. Duplicate emission is not an error — it's silently absorbed.

**IMPORTANT:** Once a row is consumed, the dedup key remains. To re-emit `decision_ready` for the same decision after a consume, the emitter must include a distinguishing suffix (e.g., the position count). This is intentional: a `decision_ready` event means "Boss should look at this decision NOW". If Boss already looked and acknowledged, and then a 4th position comes in, that's a new logical event that deserves its own key: `decision_ready:42:4positions`.

### Mailbox Schema

```sql
CREATE TABLE tw_mailbox (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent     TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  task_id          INTEGER,
  decision_id      INTEGER,
  payload_json     TEXT,
  urgency          TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','urgent')),
  dedup_key        TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at     TEXT,
  consumed_at      TEXT,
  consumed_by      TEXT,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  wake_attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_mailbox_target_unconsumed
  ON tw_mailbox(target_agent, id)
  WHERE consumed_at IS NULL;

CREATE INDEX idx_mailbox_dispatch
  ON tw_mailbox(target_agent, lease_expires_at)
  WHERE consumed_at IS NULL;
```

### Migration Plan (hard cutover, not parallel)

**Phase 0 — Schema + agent tools (no dispatch change yet)**
1. Add `tw_mailbox` table with all constraints.
2. Add `worker_lease_at`, `worker_lease_timeout_sec` columns to `tw_tasks` with sensible defaults.
3. Add new MCP tools: `read_mailbox`, `ack_event`, `ack_batch`, `heartbeat_lease`, `release_lease`. Old tools keep working.
4. Add server-side hook: every task-touching MCP tool bumps `worker_lease_at` before returning.
5. Update agent operating manual to describe the protocol.
6. Ship. No behavior change yet — mailbox is empty.

**Phase 1 — Mutators write to mailbox (dual write)**
1. Inside every mutator that currently calls `nudgeAgent()`, also insert a mailbox row in the same transaction.
2. `nudgeAgent()` still fires the old tmux keystroke. Mailbox accumulates but dumb-sensor doesn't dispatch yet.
3. Let it run for 24h. Check: mailbox rows match 1:1 with real nudges. No missing events, no extras.

**Phase 2 — Hard cutover**
1. Flip feature flag `TIER1_DISPATCH_ENABLED=1`.
2. At the same moment, disable direct `nudgeAgent()` calls in the mutators. They ONLY write to the mailbox.
3. Old watchdog's nudge paths (`watchdog.ts:413`, `watchdog.ts:845`, etc.) become no-ops under the flag.
4. Dumb-sensor starts dispatching via mailbox.
5. All nudges now flow through the mailbox.

**Phase 3 — Delete legacy**
1. Remove the old `nudgeAgent()` inline calls. Keep the function as a compatibility shim for one release, then delete.
2. Delete old watchdog nudge code paths.
3. Rename `watchdog.ts` to `dumb-sensor.ts`.

**Feature flag lives in `config.ts`:**
```ts
export const TIER1_DISPATCH_ENABLED =
  process.env.THREADWORK_TIER1_DISPATCH === '1'
```

Tests set `THREADWORK_NUDGE_DISABLE=1` AND `THREADWORK_TIER1_DISPATCH=0` so they never emit real wakeups.

### Callsites Affected (from Codex's audit of db.ts)

From Codex's review, these functions currently mutate state and will need to also insert mailbox rows in Phase 1:

- `claimTaskWithSession` (db.ts:799) → emit `task_assigned` (if from_agent != to_agent) OR `task_claimed` for tracking
- `updateHeartbeat` (db.ts:682) → no event, just updates `worker_lease_at` side effect
- `addPosition` (decision.ts:80) → emit `position_added` for decision owner; check if dedup fires `decision_ready`
- `finalizeDecision` (decision.ts:149) → emit `decision_finalized`
- Existing `createTask` / `delegateTask` → emit `task_assigned`
- Circuit breaker updates → emit `circuit_open` for boss
- Session death detection in dumb-sensor → emit `session_dead` for boss

### What Tier 1 does NOT do

- Does NOT write events. Mutators do.
- Does NOT invoke Claude.
- Does NOT interpret events. Just routes them.
- Does NOT de-dup at runtime. The DB unique constraint is the only dedup.

This is deliberate. Tier 1 is a dispatcher, not a controller. Bugs in Tier 1 cannot corrupt state because Tier 1 only writes to `lease_owner`, `lease_expires_at`, `delivered_at`, `wake_attempts`. It never touches the primary event data.

## Open Questions

1. **Phase 1 dual-write verification:** How do we prove mailbox matches production nudges 1:1? Proposed: add an assertion script that runs every minute during Phase 1 comparing `count(nudgeAgent calls in last 5 min)` vs `count(mailbox inserts in last 5 min)`. Off by more than 5% → alert.

2. **Tool-call auto-lease-refresh:** Should EVERY MCP tool bump `worker_lease_at` for the caller's claimed task, or only tools that reference the task explicitly? I lean toward "only task-referencing tools" to avoid polluting the lease when an agent does unrelated work like reading memories.

3. **Wake attempts cap:** 3 re-wake attempts then escalate. Too aggressive? Too loose? Proposed: make it configurable per event_type. Urgent events get 1 attempt then immediate escalate; low urgency gets 5.

4. **Mailbox retention:** How long do we keep consumed rows? Proposed: `DELETE FROM tw_mailbox WHERE consumed_at < datetime('now', '-7 days')` as a nightly cleanup.

5. **Leader election for multiple machines:** Out of scope for this spec. Single-machine assumption holds for now. Noted for future.

## Expected Cost

With coalescing + mailbox dedup:
- Real events/day: ~20 per agent (new tasks, decisions, escalations)
- With coalescing 5→1: ~4 wakeups per agent per day
- 4 agents × 4 wakeups × 200k tokens × $15/M = **$48/day** (vs $1200/day pathological)
- That's 25× reduction, well past the 10× goal.

Worst case still bounded: the dedup keys plus 3-attempt cap mean a single stuck loop cannot generate >3 wakeups per unique event. No more L117 escalation cascades.

## Out of Scope

- Context pruning (`/clear` every N events) — separate sprint
- Gemini Flash tier — not needed, shell is enough
- Telegram mirror of mailbox — optional, defer
- Multi-machine leader election
- Replacing tmux as transport — events table is the source of truth, transport can change later without schema changes
