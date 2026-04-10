# v2-lite Watchdog Sprint — Spec

**Author:** Boss
**Date:** 2026-04-09
**Owner:** Sadie (assigned), Kiera (pair review), Steve (pair review)
**Parent task:** #232 (Fix heartbeats and watchdogs — convert to dumb sensors)
**Authority:** Decision #17 → Option B (Boss tiebreaker, 2026-04-09); Memory #340 (pinned, shared); Memory #344 (install status)
**Execution method:** `/god-mode v3` via claude-arsenal plugin (installed to all 4 layers 2026-04-09, see Memory #344)
**Council input:** 2026-04-09 5-model council report (`~/.claude/mcp-servers/task-board/logs/2026/04/2026-04-09-llm-council-report.md`) — chairman verdict: "v2 is directionally right but not ready to ship unchanged; v2-lite recovers 80% of savings for 20% of complexity."
**Codex input:** Partial review (task task-mnriag09-2koagd died at 13:23:37 mid-write). In-flight confirmations captured below; spec incorporates them.

---

## Why this sprint exists

Three compounding bugs make the current supervision stack actively harmful:

1. Every decision opened via `open_decision` with `expires_in_hours` gets auto-expired within ~60-90s of creation, blocking the team-deliberation workflow entirely. Decision #17 died before a single teammate could submit a position.
2. Agent circuit breakers open on 5 faults with a cooldown_until timestamp and never auto-close. Boss had to manually SQL-reset boss/sadie/kiera earlier today to delegate this very sprint.
3. The watchdog runs LLM-powered nudges and polls every cycle, burning tokens to push agents that are already in_progress and already reporting via write_status. This is the headline cost problem.

Decision #17 resolved as Option B: ship a **minimal debounce-based suppression layer** that recovers most of the cost savings in days instead of the full mailbox rewrite (which has 4 known semantic holes and weeks of migration risk). Two prerequisite bug fixes must ship in the same sprint because the supervision stack is otherwise too broken to validate the debounce metrics.

---

## Codex review summary (partial — task died mid-write)

Codex began its review at 13:21, confirmed several claims in in-flight reasoning logs, then the process was killed at ~13:23 before writing the formal output. What Codex confirmed before dying:

1. **Bug 1 CONFIRMED.** Quote from Codex's in-flight log: *"I've confirmed `open_decision` writes SQLite-style timestamps directly and `expireStaleDecisions` reads them back raw."* Codex also noted: *"The code already contains at least one explicit comment acknowledging SQLite stores datetimes as 'YYYY-MM-DD HH:MM:SS'."* — meaning the format mismatch is known at some callsite, just not this one.

2. **Bug 2 CORRECTED.** Quote: *"I found one important nuance on Bug 2: `tryHalfOpen` is not dead globally, but it only runs inside task reconciliation... there is no standalone circuit-healing sweeper; the only live `tryHalfOpen` call is inside due-task reconciliation."*

   **Implication:** my earlier diagnosis was wrong that `tryHalfOpen` is dead. It runs, but ONLY when the watchdog reconciles an overdue task for that agent. If an agent has no overdue tasks (because the delegator just refused to delegate), the breaker never auto-heals. Classic deadlock: you need an overdue task to heal the breaker, but you can't create a task to drive the agent because the breaker refuses delegation. The fix stands but should call `tryHalfOpen` from `isCircuitOpen` OR add a time-based sweep — the sprint specifies the former because it is a 6-line patch and avoids adding a new loop.

3. **Not yet confirmed** (codex died before writing the formal section): whether there are OTHER string-comparison-on-SQL-datetime bugs in the same file family; whether the proposed patches have subtle race conditions; what the existing bun-test scaffolding looks like. Sprint includes a pre-implementation discovery step to cover these gaps.

**Go/no-go:** Codex's partial review validates both diagnoses strongly enough to proceed. Sprint ships with an explicit "pre-implementation discovery" phase that re-runs the questions Codex didn't get to answer (other bugs, race conditions, test scaffold).

---

## Scope — what ships in this sprint

### Phase A — Prerequisite bug fixes (ship FIRST, land together)

**A1. Decision sweeper timestamp bug**
- **File:** `/Users/coachstokes/.claude/mcp-servers/task-board/decision.ts`
- **Function:** `expireStaleDecisions` (lines ~340-355)
- **Current code:** `const now = new Date().toISOString()` then `if (d.expires_at && d.expires_at < now)`
- **Root cause:** lexicographic string comparison between ISO-8601 ("2026-04-09T13:15:00.000Z") and SQLite naked datetime ("2026-04-09 17:34:37"). Space (0x20) sorts before 'T' (0x54), so every same-day future expiry reads as "already past".
- **Fix:** parse both sides as epoch ms before comparing. Patch:
  ```ts
  const nowMs = Date.now()
  for (const d of open) {
    if (d.expires_at) {
      const expiresMs = new Date(d.expires_at + 'Z').getTime()
      if (!Number.isNaN(expiresMs) && expiresMs < nowMs) {
        try { dec.expireDecision(d.id); count++ } catch { /* skip */ }
      }
    }
  }
  ```
  - NaN guard protects against malformed rows.
  - `+ 'Z'` coerces the naked SQLite datetime to UTC. All datetime inserts in this codebase use `datetime('now', ...)` which is UTC, so this is safe and matches the existing pattern already used at db.ts:1367.

**A2. Circuit breaker auto-heal**
- **File:** `/Users/coachstokes/.claude/mcp-servers/task-board/db.ts`
- **Function:** `isCircuitOpen` (line ~1401)
- **Root cause (corrected per Codex):** `isCircuitOpen` only checks `circuit_state === 'open'` and never attempts recovery. The only live `tryHalfOpen` call is inside watchdog task reconciliation, which only runs when an agent has an overdue task — circular: you can't get an overdue task to that agent because the delegator refuses.
- **Fix:** make `isCircuitOpen` consult `cooldown_until` and trigger the half-open transition when cooldown has elapsed. Patch:
  ```ts
  isCircuitOpen(agent: string): boolean {
    const state = this.getCircuitState(agent)
    if (state?.circuit_state !== 'open') return false
    // Auto-recover if cooldown elapsed — breaks the "no overdue task = no heal" deadlock
    if (state.cooldown_until) {
      const cooldownMs = new Date(state.cooldown_until + 'Z').getTime()
      if (!Number.isNaN(cooldownMs) && Date.now() >= cooldownMs) {
        this.tryHalfOpen(agent)
        return false
      }
    }
    // If cooldown_until is NULL on an open circuit, treat as healed (bad state — emit a warning log)
    if (!state.cooldown_until) {
      console.warn(`[circuit-breaker] agent=${agent} open with NULL cooldown_until; forcing closed`)
      this.closeCircuit(agent)
      return false
    }
    return true
  }
  ```
  - `getCircuitState` already returns `cooldown_until`, no new query needed.
  - NULL-cooldown healing is added because Codex's review path couldn't confirm this edge case and it IS reachable via schema default — better to self-heal than hang.
  - Race condition note: two concurrent delegate calls both hitting this path will both invoke `tryHalfOpen`. That's fine — `tryHalfOpen` has an idempotent guard (`row.circuit_state !== 'open' return false`) so only the first transition wins and the second no-ops. No double-recovery.

**A3. Timestamp normalization audit** (pre-implementation discovery, replaces Codex question 4)
- Grep for `.toISOString()` compared against any SELECT-returned timestamp column across `decision.ts`, `db.ts`, `watchdog.ts`, `server.ts`, `consolidate.ts`, `debrief.ts`.
- Any hit that compares a JS ISO string directly against a column sourced from `datetime('now', ...)` is the same bug family and MUST ship a fix in the same PR.
- Document findings in a comment block at the top of each touched file: `// Timestamp comparison policy: SQLite datetimes are 'YYYY-MM-DD HH:MM:SS' UTC; always parse with new Date(v + 'Z').getTime() before comparing to Date.now(). See sprint 2026-04-09-v2-lite-watchdog.`

### Phase B — v2-lite debounce implementation

**B1. Schema migration**
- New table `tw_nudge_debounce` in `tasks.db`:
  ```sql
  CREATE TABLE tw_nudge_debounce (
    agent TEXT PRIMARY KEY REFERENCES agent_sessions(agent),
    last_nudged_at TEXT,
    pending_count INTEGER NOT NULL DEFAULT 0,
    last_urgency TEXT NOT NULL DEFAULT 'normal',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```
- Apply as a new numbered migration in `db.ts` MIGRATIONS array. Backwards compatible: no existing rows touched.
- Seed one row per known agent (boss, steve, sadie, kiera) with `last_nudged_at=NULL, pending_count=0`.

**B2. Debounce helper** (`debounce.ts`, new file)
- `recordPendingEvent(agent, urgency)` — increments pending_count, updates last_urgency if higher priority.
- `tryNudge(agent, urgency)` — returns `{ shouldFire: boolean, pendingCount: number }`. Fires if `(now - last_nudged_at) >= DEBOUNCE_WINDOW_SEC` OR `urgency === 'urgent'`. Updates `last_nudged_at` and resets `pending_count` to 0 when fired.
- `DEBOUNCE_WINDOW_SEC = 90` as default; environment override `THREADWORK_DEBOUNCE_WINDOW_SEC`.
- Per-agent override column reserved but not implemented this sprint (YAGNI).

**B3. Integrate into nudge paths**
- Every existing call to the raw tmux nudge (search `tmux send-keys`, `nudgeSessionByName`, `sendNudge`, etc.) must go through `tryNudge` first.
- Callsites to cover (based on v2 spec §Migration audit, inherit list):
  - task_created → nudge target agent
  - task_claimed → (no nudge; no change)
  - decision_ready → nudge each participating agent
  - stall_warning → nudge owning agent
  - watchdog escalation_created → nudge supervisor (boss)
- Wake payload becomes uniform: `[wake] you have N pending events — call list_tasks and read_status to see what changed.` N comes from `pendingCount`. No event-specific payload.
- All suppressed nudges still write an audit_log row (`nudge_suppressed`) with agent, urgency, reason=`debounced`, window_ms_remaining. Required for metrics.

**B4. Feature flag gating**
- Gate the whole debounce path behind `THREADWORK_DEBOUNCE_ENABLED` env var.
- When disabled, `tryNudge` returns `{ shouldFire: true, pendingCount: 0 }` unconditionally (pass-through).
- Default ON in production after Phase D metrics confirm.

**B5. Stall scanner dedup hole** (council finding a, must-fix regardless of lane)
- **File:** `watchdog.ts`, stall detection logic.
- Current behavior: `NOT EXISTS` clause on unconsumed `stall_warning` prevents immediate spam but fires again the moment the prior warning is acknowledged.
- Fix: add explicit consecutive-miss counter on the task row (`stall_miss_count INTEGER DEFAULT 0`). Only fire `stall_warning` when counter reaches 2. Reset counter when the agent renews heartbeat or sends a status update.
- Migration: `ALTER TABLE tasks ADD COLUMN stall_miss_count INTEGER DEFAULT 0`.

### Phase C — Tests

Bun test format, one file per concern, in `tests/`:

**C1. `tests/decision-expiry.test.ts`**
- `it('does not expire a decision whose expires_at is in the future even on same day')`
- `it('expires a decision whose expires_at is in the past')`
- `it('ignores decisions with NULL expires_at')`
- `it('handles malformed expires_at without crashing')`
- Use the existing test DB scaffold (look for `tests/db.test.ts` for the pattern).

**C2. `tests/circuit-breaker-healing.test.ts`**
- `it('isCircuitOpen returns false when cooldown_until has passed (triggers half_open)')`
- `it('isCircuitOpen returns true when cooldown_until is still in the future')`
- `it('isCircuitOpen force-closes a circuit with NULL cooldown_until and warns')`
- `it('concurrent isCircuitOpen calls do not double-transition')` — spawn two calls in a tight loop, assert only one transitions to half_open.

**C3. `tests/debounce.test.ts`**
- `it('fires immediately when no prior nudge recorded')`
- `it('suppresses within debounce window for normal urgency')`
- `it('bypasses window for urgent urgency')`
- `it('increments pending_count on suppressed nudges')`
- `it('resets pending_count and updates last_nudged_at on fire')`
- `it('pass-through when THREADWORK_DEBOUNCE_ENABLED=0')`

**C4. `tests/stall-counter.test.ts`**
- `it('does not fire stall_warning on first detected stall')`
- `it('fires on second consecutive stall')`
- `it('resets counter when agent heartbeat renews')`

**C5. Integration smoke**
- `tests/integration-sprint.test.ts`: end-to-end — open a decision with expires_in_hours=6, simulate 90s of wall clock, assert status still 'open'. Open a circuit breaker via recordFault, advance cooldown via SQL, call delegate_task, assert success.

### Phase D — Metrics + rollout

- Add a new SQL view `v_nudge_metrics_24h` that aggregates from `audit_log`:
  - `nudges_suppressed_24h`
  - `nudges_fired_24h`
  - `suppression_rate = suppressed / (suppressed + fired)`
  - `wake_latency_p50_ms`, `wake_latency_p99_ms` — measured as time from event creation to `last_nudged_at`.
- Add a one-line `tw-debounce-metrics.ts` CLI under `bin/` that prints this view. Sadie's original smoke-test target (`tw-team-digest.ts`) is CANCELLED — this metrics CLI supersedes it and is the actual thing we need.
- Rollout plan:
  1. Land all of Phase A + B + C on a branch. All tests green.
  2. Run with `THREADWORK_DEBOUNCE_ENABLED=0` for 2 hours in prod to confirm no regressions.
  3. Flip to `THREADWORK_DEBOUNCE_ENABLED=1`. Observe for 24h.
  4. Flip kill criterion: if `suppression_rate < 0.40` OR `wake_latency_p99_ms > 180000`, roll back (flip env, restart sessions). If criterion met for 48h, make it default ON in code.

### NOT in scope for v2-lite (deferred to v3 if ever)

- Per-row mailbox table
- Per-event leases + ack tools
- `wake_attempts` accounting
- Dead-letter queue
- Phase-0 MCP tools (`read_mailbox`, `ack_event`, `ack_batch`, `heartbeat_lease`, `release_lease`)
- Full dual-write migration
- Semantic fingerprint audit infra for the migration
- Per-agent debounce window override

---

## Execution

**Assignee:** Sadie (she owns Task #217 — same work, deepest context).
**Method:** `/god-mode v3` via claude-arsenal plugin. Sadie must `/reload-plugins` before invoking; plugin is installed at all 4 layers as of Memory #344.
**Phases as god-mode understands them:** Phase 1 explore → Phase 2 plan → Phase 3 implement (parallel lanes: migration-impl for B1/B5 migrations, backend-impl for A1/A2/B2/B3/B4, test-impl for C1-C5) → Phase 4 verify → Phase 5 fix → Phase 6 SKIP (no UI) → Phase 7 wrap.
**Pair review:** Kiera + Steve each review one file before Phase 4 verification.
**Heartbeat:** Sadie must write_status at least once per god-mode phase. Delegate actual execution to `sadie-agent` sub-agent per standing policy.
**Re-run Decision #17 after A1 fix.** Once the decision-expiry bug is patched and deployed, Boss will open Decision #17b asking the team to critique the v2-lite implementation itself. This doubles as a live test that the fix works.

## Success criteria

1. Decision #17b opens and stays open for its full window; all three teammates submit positions.
2. A fresh circuit breaker opens on 5 simulated faults, then auto-heals on the next `isCircuitOpen` call after cooldown_until elapses — no manual SQL reset.
3. `THREADWORK_DEBOUNCE_ENABLED=1` 24h observation shows `suppression_rate >= 0.60` and `wake_latency_p99_ms <= 90000`.
4. All Phase C tests green.
5. Sadie's /god-mode run completes Phase 7 without a manual Boss intervention.

## Known risks

- **Sadie's sub-agent session caches skills at boot.** She must actually run `/reload-plugins` or restart before invoking /god-mode. Memory #344 documents this.
- **Codex's review was partial.** The pre-implementation discovery phase (A3) is meant to re-ask the questions Codex didn't get to answer. Sadie is expected to find at least one additional string-comparison bug and one race condition before Phase 3.
- **The watchdog itself is the thing being modified.** Phase B migrations touch live production tables. Ship behind the feature flag; do NOT enable until metrics prove the debounce path.
- **Duplicate plugin dir at `~/.claude/plugins/claude-arsenal/`.** Harmless but delete after sprint lands.

## Follow-up sprint targets (NOT this sprint)

- Watchdog escalation cascade bug (task #206): escalation tasks themselves get escalated recursively. Separate fix, unrelated to v2-lite.
- `boss` session false-positive "dead" state (today's observation — agent_sessions.state=dead while actively running).
- Consolidate duplicate plugin dirs and clean up `temp_git_*` caches in `~/.claude/plugins/cache/`.
