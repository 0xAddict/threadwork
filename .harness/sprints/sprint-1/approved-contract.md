# Sprint 1 Approved Contract

status: APPROVED

## Reviewer Notes

All 7 criteria are objective, measurable, and verifiable via code inspection and `bun test`. The proposed contract closely mirrors the roadmap scope. Baseline confirmed at 132 passing tests.

One clarification added to Criterion 3: "at least 2 distinct agents" is an explicitly acknowledged heuristic — acceptable for this sprint. No structural changes to the criteria were required.

One constraint added (Criterion 7 supplement): the cycle summary log line must include `decisions_expired=`, `decisions_nudged=`, and `decisions_ready=` — the exact field names match the interface extension in Criterion 5.

---

## Acceptance Criteria (Approved)

### AC-1: expireStaleDecisions() called every watchdog cycle
- `expireStaleDecisions(dec)` is called in the `run()` loop each cycle.
- Call site must be after `reconcileDueTasks()` and `checkAgentSessions()`, and before (or alongside) the debrief gate.
- Expired decisions are logged to the audit trail AND posted to the Telegram group via `postToGroup(formatDecisionExpired(...))`.
- Verifiable by: code inspection of `watchdog.ts` run() loop; test asserting `expireStaleDecisions` is called and audit entry exists.

### AC-2: Position nudge for stale open decisions
- Decisions with `status = 'open'` that were created more than 10 minutes ago with zero positions trigger agent nudges.
- The nudge must reference the decision ID and title.
- Nudge target: the decision's `opened_by` agent and all team agents (since any may need to weigh in).
- Verifiable by: test creating an 'open' decision with `created_at` backdated 11+ minutes, confirming nudge is issued with correct content.

### AC-3: Ready-to-finalize detection
- Decisions in `'positions'` or `'critique'` status where positions from >= 2 distinct agents exist trigger a notification to Boss.
- Notification message must identify the decision ID and title.
- Verifiable by: test creating a decision with 2 positions from distinct agents, confirming Boss notification fires.

### AC-4: Telegram group notifications for state changes
- Expired decision: `postToGroup(formatDecisionExpired(...))` called — uses the existing `formatDecisionExpired` function from `notify.ts`.
- Ready-to-finalize: a distinct formatted message posted to the group (new formatter or inline string acceptable).
- Verifiable by: tests mock/spy `postToGroup` and assert it is called with correctly formatted strings.

### AC-5: Decision monitoring stats in cycle summary
- `ReconcileResult` interface extended with three new optional or required numeric fields: `decisions_expired`, `decisions_nudged`, `decisions_ready`.
- Cycle summary log line includes these counters (e.g., `decisions_expired=0 decisions_nudged=1 decisions_ready=0`).
- Verifiable by: TypeScript compilation succeeds; log output contains the three counter names.

### AC-6: All decision actions logged to audit trail
- Every watchdog decision action (expire, nudge-for-position, ready-to-finalize) calls `this.audit.log(...)`.
- Action types should be distinct strings (e.g., `'decision_expired'`, `'decision_position_nudge'`, `'decision_ready_to_finalize'`).
- Verifiable by: tests assert `audit.getLogs()` or equivalent contains entries with the expected action strings after triggering each path.

### AC-7: No regressions
- All 132 existing tests continue to pass after the implementation.
- `bun test` exits with 0 failures.
- Verifiable by: running `bun test` and confirming 132+ tests pass, 0 fail.

---

## Definition of Done

- New `monitorDecisions()` method (or equivalent private methods) on `TaskReconciler` handling all three paths: expire, nudge, ready-to-finalize.
- Method called in the `run()` loop alongside `reconcileDueTasks` and `checkAgentSessions`.
- `ReconcileResult` interface extended with `decisions_expired`, `decisions_nudged`, `decisions_ready`.
- At least 5 new tests covering: expiry calling, position nudge timing, ready-to-finalize detection, audit logging, and no-double-notification.
- All 132+ existing tests pass.
- TypeScript compiles without errors: `bun build watchdog.ts --no-bundle --target=bun` exits cleanly.

## Test Commands

```bash
# Regression check
bun test

# TypeScript compile check
bun build watchdog.ts --no-bundle --target=bun 2>&1 | head -5

# Decision monitoring tests specifically
bun test tests/watchdog.test.ts
```
