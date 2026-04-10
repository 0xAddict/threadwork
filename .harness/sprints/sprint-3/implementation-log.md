# Sprint 3 Implementation Log

## [2026-04-08T00:00] Starting implementation
- Contract: APPROVED, 8 acceptance criteria
- Baseline: 160 tests, 0 failures
- Plan:
  1. Fix agent-scoped open_decisions query in watchdog.ts (AC-8) -- the only code change
  2. Add cross-nudge guard in monitorIdleAgents (AC-2) -- prevents double-nudging
  3. Write tests/sprint3-integration.test.ts covering all 8 criteria (>= 10 tests)
  4. Run full regression, verify compile
- Next: implement AC-8 code fix, then write test file

## [2026-04-08T00:01] AC-8: Agent-scoped open_decisions query
- Files changed: watchdog.ts (line ~929-934)
- Decision: Changed the open_decisions COUNT query in monitorIdleAgents to use a SQL subquery excluding decisions where the agent already has a position in decision_positions. This is a SQL-level fix (not application-level) per the Verifier's requirement.
- Query now: `WHERE status IN ('open','positions','critique') AND id NOT IN (SELECT decision_id FROM decision_positions WHERE agent = ?)`
- Next: write integration tests

## [2026-04-08T00:02] AC-2: Cross-nudge guard
- Files changed: watchdog.ts (after cooldown check in monitorIdleAgents, ~line 961-978)
- Decision: Added a cross-nudge guard that checks the audit_log for a recent `decision_position_nudge` entry within the last 60 seconds. If the agent was already targeted by a decision position nudge AND has no pending tasks, the idle board nudge is skipped. When the agent HAS pending tasks, the idle nudge still fires because it covers different work (tasks vs decisions).
- Rationale: The guard is scoped to pendingTasks.cnt === 0 to avoid blocking legitimate idle nudges about tasks when a decision nudge also happened to fire in the same cycle.
- Next: write all integration tests

## [2026-04-08T00:03] Tests written: sprint3-integration.test.ts
- Files changed: tests/sprint3-integration.test.ts (new file, 13 tests)
- Tests cover all 8 acceptance criteria:
  - AC-1: 2 tests (expired decision not counted as pending work, multiple agents)
  - AC-2: 1 test (cross-nudge guard prevents idle nudge when decision nudge fired)
  - AC-3: 1 test (cycle time < 5 seconds with 5 decisions, 3 tasks, 4 agents)
  - AC-4: 1 test (cycle summary log line contains all four counter names)
  - AC-5: 2 tests (opener in nudge target list, no infinite loop)
  - AC-6: 2 tests (expired decisions not position-nudged, multiple)
  - AC-7: 1 test (all four counters fire in single cycle)
  - AC-8: 3 tests (agent-scoped query, partial participation, SQL-level filtering)

## [2026-04-08T00:04] Initial test run: 12/13 pass
- AC-2 test failed: monitorIdleAgents was not checking for cross-type nudges
- Fixed by adding cross-nudge guard in watchdog.ts
- Second run after fix: AC-4 and AC-7 failed because cross-nudge guard was too aggressive (blocked agents who also had pending tasks)
- Refined guard: only skip idle nudge when pendingTasks.cnt === 0 AND recent decision_position_nudge exists

## [2026-04-08T00:05] All tests pass
- Sprint 3 tests: 13/13 pass
- Full regression: 173/173 pass, 0 fail
- TypeScript compile: clean (no errors)
- Target met: 173 >= 170 total tests
- Next: set status to ready_for_evaluation
