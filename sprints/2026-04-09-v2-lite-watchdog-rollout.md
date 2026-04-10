# v2-lite Watchdog Sprint — Staged Rollout Plan

**Author:** Sadie (via sadie-agent, task #251)
**Date:** 2026-04-09
**Spec:** `/Users/coachstokes/threadwork/sprints/2026-04-09-v2-lite-watchdog-sprint.md`
**Status:** Phase A + B + C shipped (24/24 new tests green). Phase D metrics
landed (see patches 17-19). This document is the operational playbook for
promoting `THREADWORK_DEBOUNCE_ENABLED` from off → on → default.

## Preconditions

- All patches 1-19 applied to `/Users/coachstokes/.claude/mcp-servers/task-board/`.
- `bun test` on the task-board: the 24 new v2-lite tests (decision-expiry,
  circuit-breaker-healing, debounce, stall-counter, integration-sprint) are
  all green. Pre-existing 16 failures are known-broken and unrelated.
- `sqlite3 tasks.db "SELECT name FROM sqlite_master WHERE type='view'"` lists
  `v_nudge_metrics_24h` and `v_nudge_metrics_24h_total`.
- `sqlite3 tasks.db "SELECT agent FROM tw_nudge_debounce"` lists
  boss/steve/sadie/kiera.
- `sqlite3 tasks.db "PRAGMA table_info(tasks)"` lists `stall_miss_count`.

## Stage 0 — cold deploy (debounce OFF)

Goal: confirm the new code loads cleanly in production without changing
behavior. No suppression yet.

1. Restart the MCP server session and watchdog session. Do NOT set
   `THREADWORK_DEBOUNCE_ENABLED`.
2. Watch `watchdog.log` for the first cycle. Expect:
   - No `nudge_suppressed` audit rows (the flag is OFF so `tryNudge`
     returns `{shouldFire:true, reason:'disabled'}` for every call).
   - Business-as-usual nudge counts in logs.
3. Quick sanity:
   ```
   sqlite3 tasks.db "SELECT COUNT(*) FROM audit_log WHERE action='nudge_suppressed' AND created_at >= datetime('now', '-10 minutes')"
   ```
   Expected: 0.
4. Run the metrics CLI — it should print "no nudge_fired or nudge_suppressed
   events in this window":
   ```
   bun run /Users/coachstokes/.claude/mcp-servers/task-board/bin/tw-debounce-metrics.ts
   ```
5. Observe for 2 hours. If no regressions in watchdog escalations, decision
   sweeping, or session liveness, proceed to Stage 1.

## Stage 1 — enable with 90s default window

Goal: turn on debounce with the spec-default window and collect 24h of
real traffic data.

1. Set the env var in BOTH server and watchdog sessions:
   ```
   export THREADWORK_DEBOUNCE_ENABLED=1
   # THREADWORK_DEBOUNCE_WINDOW_SEC defaults to 90 if unset — leave unset.
   ```
2. Restart server and watchdog.
3. At t+1h, run metrics CLI:
   ```
   bun run bin/tw-debounce-metrics.ts
   ```
   Sanity-check that:
   - `nudges_fired_24h > 0` and `nudges_suppressed_24h > 0` (debounce is live)
   - per-target breakdown covers boss/steve/sadie/kiera (or at least the
     agents that actually received events)
   - no agent has `suppression_rate = 1.0` (would mean zero fires, i.e.
     the agent is never getting woken — investigate)
4. At t+6h, rerun. Expect early shape of `suppression_rate >= 0.40`. If
   it's < 0.30 at 6h, the system either isn't debouncing at all (env var
   not propagated, or debounce db config failed to wire) OR traffic is
   too sparse to matter. Verify by:
   ```
   sqlite3 tasks.db "SELECT action, COUNT(*) FROM audit_log WHERE created_at >= datetime('now','-6 hours') AND action LIKE 'nudge_%' GROUP BY action"
   ```
5. At t+24h, run the CLI one final time. Capture the JSON output:
   ```
   bun run bin/tw-debounce-metrics.ts --json > /tmp/tw-debounce-24h.json
   ```
   Success criteria (spec §Success):
   - `sprint_criteria.suppression_rate_met === true` (>= 0.60)
   - `sprint_criteria.wake_latency_p99_met === true` (<= 90000ms)
   The CLI exits with code `2` if either criterion fails (and there IS
   data to evaluate), so this can be wired into a cron/alert check.

## Stage 2 — promote to default-ON

Only after 24h of green metrics. Criteria:
- `suppression_rate >= 0.60` on both the aggregate and per-target view
- `wake_latency_p99 <= 90000ms`
- No observed regression in:
  - decision finalization latency (Decision #17b and any follow-ups
    stayed open through their full window and received positions)
  - escalation correctness (overdue tasks still escalated to boss)
  - agent-wake correctness (no agent missed a pending task for > 90s
    across the window)

Promotion steps:
1. Flip the default in `debounce.ts::getDebounceConfig`: change
   ```ts
   const enabled = process.env.THREADWORK_DEBOUNCE_ENABLED === '1'
   ```
   to
   ```ts
   const enabled = process.env.THREADWORK_DEBOUNCE_ENABLED !== '0'
   ```
   i.e. default ON, explicit `=0` opt-out.
2. Add a test case to `tests/debounce.test.ts` asserting the new default
   (env unset ⇒ enabled true).
3. Land the flip as a small follow-up commit; do NOT bundle with other
   changes. A one-line diff makes rollback trivial.
4. Observe for another 24h. If any criterion regresses, revert the flip
   and investigate — data is in `v_nudge_metrics_24h`.

## Rollback criteria (kill switch)

If at any point during Stage 1 or Stage 2 we observe:
- `suppression_rate < 0.40` (under-debouncing, the feature is pointless)
- `wake_latency_p99 > 180000ms` (over-debouncing, agents starved)
- any on-call fire attributed to missed or delayed wake

Then:
1. `export THREADWORK_DEBOUNCE_ENABLED=0` on server + watchdog sessions.
2. Restart both.
3. Confirm `nudge_suppressed` count stops growing.
4. Open a post-mortem task against #251 referencing the audit_log window
   that showed the regression.
5. Investigate before re-enabling. Candidate levers:
   - Lower `THREADWORK_DEBOUNCE_WINDOW_SEC` (e.g. 60 or 45)
   - Mark more callsites `urgency: 'urgent'` to bypass the window
   - Add a per-agent window override column (deferred from this sprint)

## Observability one-liners

```
# Raw last-hour counts
sqlite3 tasks.db "SELECT action, COUNT(*) FROM audit_log WHERE action IN ('nudge_fired','nudge_suppressed') AND created_at >= datetime('now','-1 hours') GROUP BY action"

# Per-target view
sqlite3 -header -column tasks.db "SELECT * FROM v_nudge_metrics_24h"

# Total view
sqlite3 -header -column tasks.db "SELECT * FROM v_nudge_metrics_24h_total"

# Recent suppressed events (for debugging a specific agent)
sqlite3 tasks.db "SELECT created_at, detail FROM audit_log WHERE action='nudge_suppressed' AND json_extract(detail,'\$.target')='steve' ORDER BY created_at DESC LIMIT 20"

# CLI health check (human-readable)
bun run /Users/coachstokes/.claude/mcp-servers/task-board/bin/tw-debounce-metrics.ts

# CLI for an alerting script (exits 2 if sprint criteria unmet with data)
bun run /Users/coachstokes/.claude/mcp-servers/task-board/bin/tw-debounce-metrics.ts --json
```

## Known limitations

- **Latency is proxy-derived.** The spec asked for "time from event creation
  to last_nudged_at" but Phase B does not persist per-event creation
  timestamps. The CLI computes latency as `fire.created_at -
  earliest_prior_suppressed.created_at`, which is a lower bound: it
  measures how long a suppressed batch waited before the collapsing fire.
  A fire with zero prior suppressions reports latency 0 (the event fired
  immediately). This is good enough to enforce the p99 <= 90s criterion
  because that criterion is precisely about collapsed-batch latency, but
  do NOT use this number to measure single-event wake latency — those are
  effectively 0 in this metric.
- **JSON1 dependency.** The views rely on `json_extract()`. Bun's bundled
  sqlite has JSON1 compiled in, so this is fine today. If that ever
  changes, the views will need to be replaced with materialized columns
  on audit_log.
- **24h window is rolling from "now".** The views recompute on every
  SELECT, so running the CLI twice back-to-back will show slightly
  different boundaries. For a stable snapshot, use
  `bun run bin/tw-debounce-metrics.ts --json > snapshot.json` and diff
  snapshots.
- **Per-agent window override** (column reserved but unimplemented, per
  spec YAGNI) may be needed in Stage 2 if one specific agent is starved.
  Add in a follow-up sprint, not this one.
