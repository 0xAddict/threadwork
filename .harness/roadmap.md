# Watchdog Decision Monitoring & Idle Agent Nudging

## Goal
Extend the threadwork watchdog to monitor open decisions and nudge idle agents, closing two visibility gaps in the agent coordination system.

## Sprint 1: Decision Lifecycle Monitoring

**Scope:** Add decision monitoring to the watchdog's reconciliation cycle.

Features:
1. Call `expireStaleDecisions()` each watchdog cycle to auto-expire overdue decisions
2. Detect open decisions that have been waiting for positions > 10 minutes — nudge assigned/relevant agents to submit positions
3. Detect decisions in 'positions' or 'critique' status where all expected agents have responded — alert Boss that the decision is ready to finalize
4. Post Telegram group notifications for decision state changes (expired, ready-to-finalize)
5. Add decision monitoring stats to the cycle summary log

Key files: `watchdog.ts`, `decision.ts`, `nudge.ts`, `notify.ts`

Acceptance criteria:
- expireStaleDecisions() called every watchdog cycle
- Open decisions with no positions after 10 min trigger agent nudge
- Decisions with positions from all participating agents trigger Boss notification
- All decision actions logged to audit trail
- Existing watchdog task reconciliation unchanged (no regressions)

## Sprint 2: Idle Agent Board Check Nudging

**Scope:** Periodically nudge idle agents to check the task board for pending work and open decisions.

Features:
1. Track agent "last activity" (last task claim, last status update, last position/critique submission)
2. If an agent has been idle > 15 minutes and there are pending tasks or open decisions, nudge them to check the board
3. Respect a per-agent cooldown (don't nudge the same agent more than once per 30 minutes)
4. Include summary of what's waiting in the nudge message (e.g., "2 pending tasks, 1 open decision awaiting your position")
5. Skip agents with active in_progress tasks (they're busy, not idle)

Key files: `watchdog.ts`, `db.ts`, `nudge.ts`, `server.ts`

Acceptance criteria:
- Idle agents (no activity for 15 min) get nudged with board summary
- Agents with active tasks are NOT nudged
- 30-minute cooldown between nudges per agent
- Nudge message includes specific counts of pending work
- All nudges logged to audit trail

## Sprint 3: Integration Testing & Edge Cases

**Scope:** Verify both features work together without conflicts, handle edge cases.

Features:
1. Test decision expiry + nudge interaction (expired decisions shouldn't trigger position nudges)
2. Test idle nudge doesn't fire during decision monitoring nudges (avoid double-nudging)
3. Verify watchdog cycle time stays under 5 seconds with both features active
4. Add decision monitoring metrics to watchdog cycle summary
5. Handle edge case: agent opens decision and is also the only one expected to respond

Acceptance criteria:
- No double-nudges within 30-second window
- Watchdog cycle completes in < 5 seconds
- Expired decisions don't generate position nudges
- Cycle summary includes decision stats
- All existing tests still pass (`bun test`)
