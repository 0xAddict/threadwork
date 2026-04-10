# Dumb Sensor + Smart Wakeup Architecture — Spec v1

**Author:** Boss
**Date:** 2026-04-09
**Status:** DRAFT — awaiting council + Codex review
**Supersedes:** Task #217 (Agent Comms A+ Upgrade) — incorporates Option A+ plus tier-split refinements from Stokes

## Problem

Every heartbeat, progress check, escalation, and "board check" nudge currently wakes a full Claude Opus session via `tmux send-keys`. Each wake is a new conversation turn that reads the entire session history (100k–500k input tokens typical, up to 1M at the cap). Output is another 500–5000 tokens plus follow-up tool calls.

Cost per nudge scales with session length. A single "board check" on a long-lived session can run $1–5. At 2-minute watchdog cadence across 4 agents with any bug in the dedup logic, this burns dollars per minute for zero useful work.

The spam bug we just hit (test fixtures leaking into production agent sessions via real `nudgeAgent()` calls) showed the blast radius: one misbehaving test runner cost us a full session of circuit-breaker faults and dozens of worthless Opus turns.

**Goal:** 10× reduction in per-cycle LLM token spend without losing stall detection.

## Design

Split the current single-process watchdog into two layers with clear responsibilities.

### Tier 1 — Dumb Sensor (no LLM)

A small, always-on process that never invokes an LLM. Pure SQL and shell.

Responsibilities:
- Session liveness: `tmux has-session -t claude-<agent>` every cycle. No Claude call.
- Progress staleness: `SELECT` on `tw_tasks.last_progress_at` vs now.
- Dead session reconciliation: if tmux says dead, mark the task row, emit a `session_dead` event.
- Events/outbox polling: `SELECT * FROM tw_events WHERE consumed_at IS NULL ORDER BY created_at`.
- Decision monitoring: `SELECT ... WHERE status IN ('open','positions','critique')` with the terminal-status filter from Snoopy's fix. Emit `decision_ready` / `decision_expired` events.
- Routing: for each unconsumed event, determine the target agent (from `to_agent` or event metadata) and emit exactly one structured wakeup.
- Circuit breaker state: read only. Never sends an LLM nudge for circuit-related state changes; emits an event for the smart tier to act on.

Implementation: shell script or tiny bun script. **Not Gemini Flash.** See §Decisions.

Cadence: every 30 seconds (configurable). launchd `StartInterval`.

### Tier 2 — Smart Wakeup (Opus)

The existing Claude Code tmux sessions, but woken *only* by structured events.

Protocol:
1. Tier 1 writes an event row: `{id, target_agent, event_type, task_id?, decision_id?, context_summary, urgency, payload_json, created_at}`
2. Tier 1 sends ONE tmux keystroke to the target session: `[event:<id>] wake: read events table`
3. Agent wakes, runs `read_events(target_agent=self, unconsumed=true)`, receives the event batch.
4. Agent processes each event in order, acts, writes `mark_event_consumed(event_id)` (or writes a new follow-up event for another agent).
5. Agent optionally writes `write_status(status="idle")` and returns to waiting.

Nudge string is minimal — the agent's context is rebuilt from the events table, not from the nudge text. This keeps the wakeup string under 100 bytes and consistent so the conversation-length multiplier only hits real work.

### Safety Net — Stall Scanner

Every 60 minutes (configurable, task-type overridable), Tier 1 runs a single SQL query:

```sql
SELECT t.id, t.to_agent, t.last_progress_at
FROM tw_tasks t
WHERE t.status = 'in_progress'
  AND t.last_progress_at < datetime('now', '-30 minutes')
  AND NOT EXISTS (
    SELECT 1 FROM tw_events e
    WHERE e.target_agent = t.to_agent
      AND e.event_type = 'stall_warning'
      AND e.task_id = t.id
      AND e.created_at > datetime('now', '-60 minutes')
  )
```

For each match, emit one `stall_warning` event and one wakeup. No second event for 60 minutes (the anti-join in the query is the dedup).

This catches the "awake but silent" case: a live tmux session that has a claimed task but hasn't written a `write_status` update in >30 minutes. The stall scanner is the ONLY periodic liveness mechanism that produces LLM nudges.

Everything else is event-driven.

## Decisions (pre-review)

| Question | Decision | Reasoning |
|----------|----------|-----------|
| Two-tier split correct? | **Yes, with caveats.** | Work queues / actor models would require rewriting the whole system. Tier split maps cleanly onto the existing tmux + SQLite substrate. |
| Shell script or Gemini Flash for Tier 1? | **Bun script, not Flash.** | Flash adds latency, cost, and an external dependency for a job that is 100% deterministic SQL and shell. Tier 1 should never need "judgment" — if it does, that's a Tier 2 concern. |
| How to prevent awake-but-silent? | **Stall scanner (above) + Tier 1 never pings on liveness.** | Agents don't need to hear "are you alive?" — if they have nothing to do, silence is correct. The stall scanner catches real stalls using DB-only logic. |
| Transactional outbox gotchas? | **Use WAL mode + single writer for events table.** SQLite WAL handles concurrent readers fine. All event writes go through a single MCP tool (`emit_event`) that runs in an explicit transaction with the state change. | Prevents "event written but state rolled back" and "state committed but event missed." |
| Stall detection SLA? | **30 minutes default, task-type overridable.** Tasks can set `stall_timeout_sec` on create. Debug/research tasks can set 2 hours; implementation tasks default to 30 min. | One SLA doesn't fit. Research tasks often have long think phases. |
| "I'm idle" ACK rows? | **Yes, lightweight.** Agent writes `status='idle'` in `tw_status_log` when it finishes an event batch. Absence of updates is ambiguous (could be stuck or could be idle) — explicit ACK removes the ambiguity and lets the stall scanner differentiate. | One row per batch, not per tick. Cheap. |
| Nudge payload in DB vs in nudge string? | **DB (events table).** Nudge string is just `[event:<id>] wake`. Agent reads the row for details. | Keeps nudges cheap and uniform. Idempotent — agent can safely replay. |
| What about decision reminders specifically? | **Emit `decision_ready` event when positions >= threshold for the first time.** The event is written once per (decision_id, agent_id) pair using a UNIQUE index. The old bug can't re-occur because terminal-status decisions never enter the positions state. | Matches Snoopy's fix but makes dedup physical (DB constraint) not logical (in-memory set). |

## Token Cost Model

Current watchdog:
- 4 agents × 720 wake events/day (2-min cadence × 24h) = 2880 potential wakes/day
- Actual wakes with bug: ~200–400/day (heartbeat + circuit + decision spam)
- Average session size at wake: 200k input tokens
- Cost: 200k × 400 × $15/M input = **$1200/day worst case**

Post-redesign:
- 4 agents × ~20 real events/day = 80 wakes/day
- Plus safety net: at most 4 stall warnings/day
- Average session size at wake: still 200k (same agents)
- Cost: 200k × 84 × $15/M input = **$252/day** — 4.7× reduction
- Plus: no stuck conversations, so average session length drops over time → further reduction

10× is reachable if we also add context pruning (`/clear` every N events) but that's a separate sprint.

## Open Questions for Review

1. Does the events table need per-agent read checkpoints, or is `consumed_at` column enough?
2. Should `emit_event` be a SQLite trigger on `tw_tasks` / `tw_decisions` state changes, or an explicit call from each MCP tool that mutates state?
3. How do we prevent a stuck agent from blocking its own stall warnings (agent wakes, sees the stall warning, but can't act)? → proposed: after 2 consecutive stall warnings with no progress, emit `escalate_to_boss` event.
4. Should we keep the 2-min launchd cadence or drop to 60s for the dumb sensor? 60s costs nothing (no LLM) but means fresher stall detection.
5. Do we need a kill switch (`THREADWORK_NUDGE_DISABLE=1`) at the Tier 1 level too? Snoopy added it at `nudge.ts` — worth mirroring for Tier 1 so tests never emit real events.

## Migration Plan

1. Add `tw_events` table (schema below) with migration.
2. Add `emit_event()` MCP tool that wraps state changes in a transaction + event row.
3. Write `dumb-sensor.ts` as a new process, initially running alongside the old watchdog.
4. Convert `nudgeAgent()` callers one at a time: state change → `emit_event()` → Tier 1 routes → tmux wakeup.
5. Remove direct `nudgeAgent()` calls from watchdog.ts (leave session-liveness only).
6. Delete the legacy nudge logic once all callers migrated.
7. Flip launchd to run `dumb-sensor.ts` instead of `watchdog.ts`.

Tests use an in-memory events table. Ship behind a feature flag for 24h before cutover.

## Schema — tw_events (proposed)

```sql
CREATE TABLE tw_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent  TEXT NOT NULL,
  event_type    TEXT NOT NULL,       -- 'task_assigned', 'decision_ready', 'stall_warning', 'circuit_open', etc
  task_id       INTEGER,
  decision_id   INTEGER,
  payload_json  TEXT,                -- structured context for the agent
  urgency       TEXT NOT NULL DEFAULT 'normal',  -- low|normal|high|urgent
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT,                -- when Tier 1 sent the wakeup
  consumed_at   TEXT,                -- when the agent ACK'd
  consumed_by   TEXT
);

CREATE INDEX idx_tw_events_target_unconsumed
  ON tw_events(target_agent, consumed_at)
  WHERE consumed_at IS NULL;

-- dedup: one decision_ready event per (agent, decision_id)
CREATE UNIQUE INDEX idx_tw_events_decision_dedup
  ON tw_events(target_agent, decision_id, event_type)
  WHERE event_type = 'decision_ready' AND consumed_at IS NULL;
```

## Out of Scope

- Leader election / HA (single-machine system)
- Replacing tmux entirely (session identity is cheap and works)
- Context pruning within agent sessions (separate sprint)
- Telegram mirror of events table (marked optional in #217, defer)
