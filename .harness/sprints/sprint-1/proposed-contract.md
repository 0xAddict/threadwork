# Sprint 1 Contract Proposal

## Goal
Add decision lifecycle monitoring to the watchdog's reconciliation cycle so that stale decisions get expired, idle participants get nudged, and ready-to-finalize decisions are surfaced to Boss.

## Acceptance Criteria

1. **expireStaleDecisions() called every watchdog cycle**: The watchdog's main `run()` loop calls `expireStaleDecisions(dec)` each cycle, right after task reconciliation and session checks. Expired decisions are logged to the audit trail and posted to the Telegram group.

2. **Position nudge for stale open decisions**: Open decisions (status 'open') that were created more than 10 minutes ago with zero positions trigger a nudge to the decision's `opened_by` agent (and all team agents, since any agent may need to weigh in). The nudge message references the decision ID and title.

3. **Ready-to-finalize detection**: Decisions in 'positions' or 'critique' status where the number of positions >= the number of active team agents (excluding the opener if they are Boss, since Boss finalizes rather than submits positions) trigger a notification to Boss that the decision is ready to finalize. Uses a heuristic: positions from at least 2 distinct agents means "all expected agents have responded" (since we cannot know which agents were explicitly invited, we check for quorum).

4. **Telegram group notifications for state changes**: When a decision is expired by the watchdog, `postToGroup()` is called with `formatDecisionExpired()`. When a decision is detected as ready-to-finalize, a new formatted message is posted to the group.

5. **Decision monitoring stats in cycle summary**: The `ReconcileResult` interface is extended with `decisions_expired`, `decisions_nudged`, and `decisions_ready` counters. These are logged in the cycle summary line.

6. **All decision actions logged to audit trail**: Every watchdog decision action (expire, nudge-for-position, ready-to-finalize notification) writes an entry to the audit log via `this.audit.log()`.

7. **No regressions**: All 132 existing tests continue to pass. The existing task reconciliation, session checking, and debrief logic remain unchanged.

## Test Commands

```bash
# Run all existing tests to verify no regressions
bun test

# Verify TypeScript compiles without errors
bun build watchdog.ts --no-bundle --target=bun 2>&1 | head -5

# Run the new decision monitoring tests specifically
bun test tests/watchdog.test.ts
```

## Definition of Done

- New `monitorDecisions()` method on TaskReconciler that handles all three decision monitoring tasks (expire, nudge, ready-to-finalize)
- Method is called in the watchdog `run()` loop alongside existing reconcileDueTasks and checkAgentSessions
- ReconcileResult extended with decision counters
- At least 5 new tests covering: expiry calling, position nudge timing, ready-to-finalize detection, audit logging, and no-double-notification
- All 132+ existing tests pass
- Code compiles without TypeScript errors

## Target Metrics

- 0 test regressions
- >= 5 new tests added
- Watchdog cycle time not meaningfully impacted (decision monitoring should be < 100ms)
