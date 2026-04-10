# Sprint 3 Contract Proposal

## Goal
Add comprehensive integration tests verifying that decision monitoring and idle agent nudging work together without conflicts, handle edge cases correctly, and include decision metrics in the watchdog cycle summary.

## Acceptance Criteria

1. **Expired decisions do not trigger idle board nudges**: When a decision expires during `monitorDecisions()`, the subsequent `monitorIdleAgents()` call in the same cycle must NOT count that expired decision as "pending work" when deciding whether to nudge idle agents. Test: create an expired decision as the only open decision, run a full cycle (monitorDecisions then monitorIdleAgents), verify idle_nudges=0 for agents whose only pending work was that decision.

2. **No double-nudging within a 30-second window**: If `monitorDecisions()` nudges an agent about a stale open decision, `monitorIdleAgents()` must not also nudge the same agent in the same cycle for the same underlying reason. Test: set up an idle agent (20 min idle) with a single stale open decision (15 min old, no positions) and no pending tasks. Run both monitors in sequence. Verify the agent receives a decision_position_nudge (from monitorDecisions) but NOT an idle_board_nudge in the same cycle (because the decision nudge counts as recent activity in the cooldown check, or the open_decisions count drops to zero post-expiry).

3. **Watchdog cycle time under 5 seconds**: With both features active and a realistic workload (5 open decisions, 3 pending tasks, 4 agents), a single reconciliation cycle (reconcileDueTasks + monitorDecisions + monitorIdleAgents) completes in under 5 seconds. Test: create the workload in a test database, time the full cycle, assert elapsed < 5000ms.

4. **Decision monitoring metrics in cycle summary**: The watchdog `run()` loop's cycle summary log line already includes `decisions_expired=`, `decisions_nudged=`, `decisions_ready=`, and `idle_nudges=`. Verify the log line is emitted correctly by running a cycle with at least one of each event type and checking that the log output contains all four counter names with non-zero values.

5. **Edge case: agent opens decision and is the only expected responder**: When an agent opens a decision AND is the only worker agent (simulated by having all other agents with active tasks so they are excluded from nudging), the system must not enter an infinite nudge loop. Specifically: the opener should still be nudged for their own decision after 10 minutes (the position nudge targets all WORKER_AGENTS, which includes the opener). Test: create decision opened by 'steve', backdate 15 min, verify steve is included in the nudge target list.

6. **Decision position nudge does NOT fire for expired decisions**: When a decision is both old (>10 min) AND has an expired deadline, `monitorDecisions()` must expire it first and then NOT issue a position nudge for it. This is a refinement of the existing test to verify the ordering guarantee within `monitorDecisions()` itself. Test: create decision with expires_at in the past AND created_at 15 min ago, run monitorDecisions, verify decisions_expired=1 AND decisions_nudged=0.

7. **Full cycle integration: all three paths fire in one cycle**: In a single watchdog cycle, verify that expiry, position nudge, ready-to-finalize, AND idle nudge can all fire for different decisions/agents without interfering. Test: set up (a) one expired decision, (b) one stale open decision, (c) one decision with 2 positions ready to finalize, (d) one idle agent with pending tasks. Run the full cycle. Verify all four counters are >= 1.

8. **Agent-scoped open_decisions count in idle nudge**: Fix the Verifier's Sprint 2 finding -- the idle nudge open_decisions count currently counts ALL open decisions, not just those where the agent has NOT already submitted a position. Update the query in `monitorIdleAgents()` to exclude decisions where the agent already has a position. Test: create agent with position already submitted on all open decisions, verify they are NOT nudged for open decisions.

## Test Commands

```bash
# Full regression
bun test

# Sprint 3 integration tests specifically
bun test tests/sprint3-integration.test.ts

# TypeScript compile check
bun build watchdog.ts --no-bundle --target=bun 2>&1 | head -5
```

## Definition of Done

- All 160 existing tests pass (0 regressions)
- At least 10 new tests covering the 8 criteria above
- New test file: `tests/sprint3-integration.test.ts`
- The `monitorIdleAgents()` open_decisions query is agent-scoped (fixes Sprint 2 finding)
- Code compiles with no TypeScript errors
- Total test count: >= 170

## Target Metrics

- Existing tests: 160 pass, 0 fail
- New tests: >= 10
- Total: >= 170
- Watchdog cycle time: < 5 seconds (measured in test)
- Zero TypeScript compilation errors
