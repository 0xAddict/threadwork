# Agent-to-Agent Communications: Full Deliberation Record

**Date:** 2026-04-08  
**Method:** LLM Council (5 frontier models) + Research Pairs (Opus researcher + Sonnet verifier)  
**Question:** Should Threadwork adopt direct agent-to-agent communication (Telegram Bot-to-Bot or custom layer)?  
**Decision:** Option A+ — single coordination plane, enriched nudges + SQLite events/outbox table

---

## 1. Executive Summary

**Decision: A+. Do not add a second coordination plane.**

Five frontier models (GPT-5.4-Pro, Grok-4.20, DeepSeek-R1, Llama-4-Maverick, Gemini-2.5-Pro) evaluated the question and reached unanimous consensus: Threadwork should not adopt direct agent-to-agent communication as a coordination mechanism. The correct path is **Option A+**:

1. Enrich nudge payloads with structured JSON (so agents act on the wake signal, not just find the DB)
2. Add a SQLite events/outbox table (transactional outbox pattern — durable push semantics)
3. Treat nudge as wakeup-only; meaning lives in the event row
4. Improve dead-session recovery (reduce 330s worst-case to under 60s)
5. Optionally mirror board events to Telegram for human visibility (non-authoritative)

**The core insight:** The bottleneck is not transport latency (nudges already deliver in ~10-50ms). The bottleneck is *context propagation* — agents wake up and have to make multiple follow-up DB queries to understand what to do. Fix that by enriching the existing plane, not by adding a new one.

**GPT-5.4-Pro ranked #1 across all evaluators. Key ruling:**
> "Telegram may narrate the system. SQLite should run the system."

---

## 2. Council Chairman Synthesis

**Chairman:** openai/gpt-5.4-pro (ranked #1 by unanimous peer review)

### Ruling

**No — Threadwork should not adopt direct agent-to-agent communication as a coordination/control path right now.**

The council's consensus is to choose **Option A+**:
- Keep SQLite task board as the single system of record
- Add enriched JSON nudge payloads
- Add a lightweight SQLite events/outbox table
- Use Telegram only as an optional mirror/visibility channel, not as an authoritative coordination channel

### Why This Is the Right Decision

**1. It optimizes the real bottleneck.**

Your own findings are decisive:
- Nudge delivery is already fast (~10–50ms)
- LLM turn time is slow (~10–30s)
- The real gap is *context propagation*, not transport latency

That means direct bot-to-bot messaging mostly solves the wrong problem. If Steve still spends 15 seconds thinking, making the message arrive in 5ms instead of 20ms changes almost nothing. What matters is whether Steve wakes up with enough context to act, instead of needing more board reads and follow-up turns.

**2. A second communication plane creates split-brain risk.**

The current architecture has an important virtue:
- One durable truth plane: SQLite
- One best-effort wake mechanism: nudge
- One human-facing channel: Telegram

Introducing Telegram B2B or a custom direct-message layer as a second agent coordination path creates immediate ambiguity:
- Did the agent act on the board or the chat?
- Which state is authoritative if they diverge?
- Was a message duplicated, delayed, dropped, or replayed?
- Did an agent "see" a Telegram message that never made it into the audit log?
- Did loop prevention suppress something real?

That is exactly the kind of debugging surface area you want to avoid in a multi-agent system.

**3. Direct comms do not improve the worst failure mode.**

You identified the worst failure mode as dead session recovery, up to 330s. Direct agent-to-agent messaging does **not** fix that. A dead Claude/tmux session will not process Telegram messages, websocket messages, event bus messages, or anything else.

If you want to improve the worst-case operational behavior, the highest-value work is in:
- Heartbeat and lease tuning
- Liveness detection
- Restart policy
- Watchdog escalation timing
- Possibly sidecar-style supervision

**4. SQLite already gives you the properties you care about.**

The task-board architecture already aligns with good distributed-systems practice:
- Durability
- Auditability
- Replayability
- Debuggability
- Reconciliation
- Clear supervision

That's a strong foundation. The right move is to strengthen it, not route around it.

### Option-by-Option Judgment

| Option | Reliability | Complexity | Audit Trail | Debugging | Solves real bottleneck? | Decision |
|--------|------------|------------|-------------|-----------|------------------------|---------|
| A | High | Low | High | Easy | Partly | Better than status quo |
| **A+** | **Very high** | **Low-medium** | **Excellent** | **Easy** | **Yes** | **Choose this** |
| B Telegram B2B | Medium-low | Medium | Weak unless mirrored | Hard | No | Reject |
| C Custom bus | Medium-high | High | Medium | Medium-hard | Not yet | Premature |
| D dual-plane hybrid | Medium | Medium-high | Split | Hard | No | Reject |
| D-lite mirror only | High | Medium | Good | Medium | Slightly | Optional only |

### Final Decision

**Threadwork should not adopt direct agent-to-agent communication as a supplementary coordination mechanism at this time.**

Adopt instead: **A+ = enriched JSON nudges + SQLite events/outbox table**

Keep:
- SQLite as the single source of truth
- Nudges as best-effort wakeups
- Watchdog as supervision/reconciliation
- Telegram as human-facing and optionally mirrored visibility only

**The juice is not worth the squeeze for Telegram B2B or a custom direct channel. Strengthen the single existing coordination plane instead of creating a second one.**

### When to Revisit Direct Agent-to-Agent Comms

Reconsider only if the system changes materially:
- More than 4 agents
- Multi-host deployment
- Real SQLite contention
- Need for sub-second streaming workflows
- Richer back-and-forth negotiation not well modeled as tasks/events
- Non-LLM workers joining the system

If you ever reach that point, prefer a proper internal bus over Telegram.

---

## 3. Codex's Verdict (GPT-5.4-Pro Individual Position)

### Short Answer

**No — not as a coordination/control path.**

Threadwork should keep SQLite as the single coordination plane and implement A+: enriched JSON nudges **plus** a lightweight SQLite events/outbox table.

If you want Telegram B2B at all, use it only as an optional visibility/mirror channel, not something agents rely on to coordinate work.

### The Core Architectural Principle

Threadwork should preserve:
- **One durable source of truth** → SQLite task board
- **One ephemeral wake-up mechanism** → nudge
- **Optional human-facing visibility** → Telegram

What you should avoid: **Two competing coordination planes**

Because then every bug becomes:
- "Did the task board say X?"
- "Did Telegram say Y?"
- "Which one did the agent actually act on?"
- "Was the message missed, duplicated, or stale?"
- "Did the agent see chat but not state, or state but not chat?"

That is classic split-brain debugging.

### Why A+ Is the Right Answer

**Better context propagation.** Instead of nudging "check the board", nudge with:
- `event_id`, `task_id`, `from_agent`, `to_agent`
- `event_type`, `priority`, `summary`, `required_action`
- `row_version`, `causation_id / trace_id`
- Optional compact task snapshot

**Durable push semantics.** An events table gives you:
- Backlog on restart
- Dedup
- Replay
- Observability
- At-least-once delivery
- Per-agent inbox semantics

Then the tmux nudge becomes just: *"Wake up, event(s) waiting."* That's the right separation.

**Preserves single-plane debugging.** Everything meaningful remains in SQLite: task mutations, notes, status writes, event generation, event consumption, watchdog actions. That makes postmortems and audits dramatically easier.

### Suggested Wake Packet Payload

```json
{
  "kind": "task_assigned",
  "event_id": 1842,
  "task_id": 731,
  "from": "Boss",
  "to": "Steve",
  "priority": "high",
  "summary": "Review Sadie's schema migration plan and propose rollout order.",
  "required_action": "analyze_and_comment",
  "row_version": 12,
  "causation_id": "c8b2c6e4-7f6d-4b5b-a7b8-1d2b3e4f5a6b",
  "deadline": "2026-04-08T14:30:00Z",
  "snapshot": {
    "task_status": "in_progress",
    "owner": "Steve",
    "dependencies": [702, 719]
  }
}
```

### Suggested Events Table Schema

Fields:
- `event_id` (PK autoincrement)
- `created_at`
- `recipient_agent`
- `sender_agent`
- `event_type`
- `task_id`
- `payload_json`
- `dedup_key` (unique index)
- `causation_id`
- `row_version`
- `processed_at`
- `acked_at`

Indexes:
- `(recipient_agent, processed_at, event_id)`
- Unique `dedup_key` if applicable

### Telegram: Allowed Uses Only

**Allowed:**
- Human visibility
- Mirrored agent activity feed
- Watchdog alerts
- Escalation and ops awareness

**Not allowed:**
- Authoritative task assignment
- Agent acceptance of work
- State transitions
- Coordination decisions
- Any action taken solely because of a Telegram message

**Hard rule:** If something matters, it must exist in SQLite first or be written into SQLite before execution.

---

## 4. Key Findings from Research Pairs

### 4.1 Architecture Analysis (Researcher: Sadie/Opus + Verifier: Sonnet)

**Confirmed facts about current architecture:**

- **Agent-to-agent messaging uses tmux send-keys** — the only real-time inter-agent channel. `nudgeAgent(agent, message)` runs `tmux send-keys -t claude-{agent} {message} Enter`. Fire-and-forget, no queue, no dedup, ~10-50ms delivery.
- **Shared SQLite DB is the primary state store** — WAL mode, multi-writer safe, stored at `~/.claude/mcp-servers/task-board/tasks.db`. All agents share one file.
- **MCP transport is stdio per session** — each Claude session spawns its own `bun run server.ts` subprocess. Not network sockets.
- **Watchdog runs on 30s cadence** — singleton lease via SQLite, handles escalation and dead session detection.
- **LaunchAgent auto-restarts on 300s interval** — creating a 330s worst-case dead session recovery window.
- **No WebSockets anywhere** — confirmed by source inspection.
- **Circuit breaker exists** — hard-blocks delegation to degraded agents (`isCircuitOpen(to)` check in `server.ts`).
- **Telegram is human-facing only** — mirror/log for humans, not an agent messaging channel.

**Communication mechanisms (complete inventory):**

| Tool | Direction | Medium | Durable? |
|------|-----------|--------|----------|
| `nudge_agent` | Agent→Agent | tmux send-keys | No |
| `interrupt_agent` | Agent→Agent | tmux Ctrl+C | No |
| `create_task` / `delegate_task` | Agent→Agent | SQLite + tmux | Yes |
| `complete_task` | Agent→Agent | SQLite + tmux | Yes |
| `send_note` | Agent→Task | SQLite + Telegram | Yes |
| `write_status` / `read_status` | Agent↔DB | SQLite | Yes |
| `open_decision` / `finalize_decision` | Agent↔All | SQLite + Telegram | Yes |
| `save_memory` / `recall_memories` | Agent↔DB | SQLite | Yes |

**Key bottlenecks identified:**

1. **Context loss** — Nudges carry no structured metadata. Agent wakes up, must run 1-2 follow-up DB queries to understand what to do. Fix: enriched JSON payloads.
2. **Polling lag** — Agents have no push mechanism for DB changes. Monitor loops run every 60s. Fix: SQLite events table.
3. **Dead session recovery** — 30s watchdog + 300s LaunchAgent = 330s worst-case gap. Fix: faster watchdog restart trigger.
4. **Broadcast storm risk** — every task lifecycle event posts to Telegram. Low severity currently.

**Key insight from architecture analysis:**
> "The current system's real bottleneck is not communication latency — it is context propagation. The bottleneck is the agent's response cycle, not the message delivery."

### 4.2 Telegram Bot-to-Bot Research (Researcher: Sadie/Opus + Verifier: Sonnet)

**What Telegram Bot API actually supports (verified against live docs, API 9.6, April 3, 2026):**

- **Default behavior:** Bots cannot see messages from other bots. Official FAQ states: "bots will not be able to see messages from other bots regardless of mode." This is a hard filter at the Telegram backend, not a configuration issue.

- **Bot-to-Bot Communication Mode (new in API 9.6):** An opt-in feature that enables limited bot-to-bot interaction within **group chats only**, via:
  1. Command mentions: `/command@OtherBot`
  2. Direct replies to another bot's message
  - NOT supported in DMs between bots (no private channels)
  - Requires at least one bot to have the mode enabled via BotFather mini app

- **Mandatory safeguards required:**
  - Message deduplication (detect and drop repeated messages)
  - Rate limiting (minimum 2s between replies per bot pair)
  - Maximum interaction depth (timeout globally and per sender/receiver pair)
  - Stability requirement: bot must not loop even if another bot responds instantly

- **Managed Bots (API 9.6):** Separate feature allowing bots to create/manage other bots. Not relevant to peer communication.

**Current Threadwork Telegram setup:**
- 5 bots (boss, steve, sadie, kiera, snoopy) — each with its own token
- All in a shared group (`-1003790554582`)
- File-based locks in `~/.claude/channels/telegram/locks/` prevent two sessions from sharing a bot token
- Current telegram plugin has NO bot-to-bot detection, loop prevention, or depth tracking
- Plugin uses `grammy` library with `getUpdates` long-polling

**Verifier conclusions:**
- Current architecture correctly uses task board (not Telegram) for inter-agent coordination
- Telegram B2B would require significant plugin modifications + loop prevention logic
- This would be more fragile than the current task-board approach
- **Verdict:** Current architecture is sound and correctly designed around real API constraints

---

## 5. Implementation Steps

### Step 1: Enrich Nudge Payloads with Structured JSON

**Current behavior:**
```
"You have a new task (#42) from boss. Run list_tasks(filter='mine') for details."
```

**Target behavior:**
```json
{
  "kind": "task_assigned",
  "event_id": 1842,
  "task_id": 42,
  "from": "boss",
  "to": "steve",
  "priority": "high",
  "summary": "Build login page with OAuth2 flow",
  "required_action": "claim_and_execute",
  "row_version": 7,
  "causation_id": "uuid-here"
}
```

**Implementation location:** `nudgeAgent()` in `/Users/coachstokes/threadwork/nudge.ts`

Modify to accept a structured payload object, JSON-encode it, and send via tmux send-keys. No new infrastructure required. Very low risk — the nudge is already a text string; changing its content does not change the mechanism.

**Impact:** Eliminates the "wake → query → query → act" pattern. Agent wakes up with full context. Reduces agent turn count by 1-2 per task handoff.

### Step 2: Add SQLite Events/Outbox Table (Transactional Outbox Pattern)

**Schema:**
```sql
CREATE TABLE agent_events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  recipient_agent TEXT NOT NULL,
  sender_agent  TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  task_id       INTEGER,
  payload_json  TEXT NOT NULL,
  dedup_key     TEXT UNIQUE,
  causation_id  TEXT,
  row_version   INTEGER,
  processed_at  TEXT,
  acked_at      TEXT
);
CREATE INDEX idx_events_inbox ON agent_events(recipient_agent, processed_at, event_id);
```

**Write pattern (transactional outbox):**
1. Write task/note/status change to existing tables
2. In the SAME SQLite transaction, insert a corresponding event row
3. Commit both atomically
4. After commit, fire a best-effort nudge to wake the recipient

**Read pattern:**
- Agent polls `SELECT * FROM agent_events WHERE recipient_agent=? AND processed_at IS NULL ORDER BY event_id` on a 5-10s interval
- Marks rows `processed_at` after handling
- Marks `acked_at` after successful completion

**Benefits:** Durable inbox semantics, deduplication via `dedup_key`, replay on restart, reduced polling waste, clean observability.

**Implementation location:** `server.ts` in `/Users/coachstokes/.claude/mcp-servers/task-board/`

### Step 3: Treat Nudge as Wakeup, Meaning Belongs in the Event Row

**Principle:** The tmux nudge should mean *"wake up, you have events"* — not carry all the meaning itself.

**Why this matters:**
- If the tmux nudge is lost (mid-turn, session busy), the event row persists
- Agent polling loop catches the event on next cycle
- No information loss even when nudge delivery is imperfect
- Duplicate nudges are harmless — agent reads events idempotently using `event_id`

**Agent processing loop (pseudocode):**
```
on_wakeup():
  events = query_unprocessed_events(my_agent_name)
  for event in events:
    if already_seen(event.event_id): continue
    dispatch(event)
    mark_processed(event.event_id)
```

**Design rule:** If something matters, it must exist in the events table. The nudge is courtesy, not authority.

### Step 4: Improve Dead-Session Recovery (Reduce 330s to Under 60s)

**Current worst-case timeline:**
- Agent session dies: t=0
- Watchdog detects on next 30s cycle: t=0 to t=30
- Watchdog creates escalation task for Boss: t=30
- LaunchAgent restarts sessions: every 300s

**Total worst-case gap: up to 330 seconds**

**Options to reduce to under 60s:**

**Option A — Watchdog self-heals:** When watchdog detects a dead session, call `launch-all.sh` directly instead of waiting for LaunchAgent. Watchdog already runs as a persistent Bun process.

**Option B — Faster LaunchAgent interval:** Change the `.plist` `StartInterval` from 300s to 60s. Minimal change, immediate improvement.

**Option C — inotify/FSEvents watcher:** Watch for session death events using macOS FSEvents on tmux socket files. Triggers restart immediately on death.

**Option D — Per-agent health-check sidecar:** Lightweight process per agent that pings tmux every 10s. If ping fails 3 consecutive times, triggers restart.

**Recommended path:** Start with Option B (faster LaunchAgent) for zero-code win, then implement Option A (watchdog self-heal) for a proper sub-30s response.

**Implementation location:**
- LaunchAgent plist: `~/Library/LaunchAgents/com.threadwork.agents.plist`
- Watchdog: `/Users/coachstokes/threadwork/watchdog.ts`

### Step 5: Optional — Telegram Mirror for Human Visibility (Non-Authoritative)

**If desired, Telegram can mirror board events for human situational awareness.**

**Acceptable uses:**
- "Steve picked up task #731"
- "Sadie blocked on missing schema details"
- "Watchdog restarted Kiera"
- "Boss reprioritized queue"

**Guardrails (mandatory):**
- Every Telegram post must be derived from a SQLite event, never the originating authority
- Agents must never act on a Telegram message alone — it must reference a task/event ID in SQLite
- No task assignment, acceptance, or state transition via Telegram
- Loop prevention required if enabling Bot-to-Bot mode

**Implementation:** The `postToGroup()` call already exists in `server.ts`. It can be enriched to mirror event payloads in a human-readable format. No structural changes needed.

**Hard rule:** Telegram may narrate the system. SQLite runs the system.

---

## 6. Council Rankings (Final Aggregate)

| Model | Avg Rank | Position |
|-------|----------|---------|
| openai/gpt-5.4-pro | 1.00 | #1 (Chairman) |
| x-ai/grok-4.20-multi-agent | 2.00 | #2 |
| deepseek/deepseek-r1 | 3.00 | #3 |
| meta-llama/llama-4-maverick | 4.00 | #4 |
| google/gemini-2.5-pro | 5.00 | #5 |

All five models converged on the same answer: **Option A+**. No model recommended Telegram B2B as a coordination mechanism. No model recommended a custom direct messaging layer.

---

## 7. Source Documents

- **Council Report:** `/Users/coachstokes/.claude/mcp-servers/task-board/logs/2026/04/2026-04-08-llm-council-report.md`
- **Architecture Analysis:** `/tmp/threadwork-architecture-analysis.md`
- **Architecture Verification:** `/tmp/threadwork-architecture-verification.md`
- **Telegram B2B Research:** `/tmp/telegram-bot-to-bot-research.md`
- **Telegram B2B Verification:** `/tmp/telegram-bot-to-bot-verification.md`
