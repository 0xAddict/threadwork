# Sprint 2 Contract Proposal

## Goal
Add idle agent board check nudging to the watchdog: detect agents with no recent activity, check if there is pending work, and nudge them with a summary of what is waiting.

## Acceptance Criteria

1. **Activity tracking via audit_log**: The watchdog queries each agent's most recent audit_log entry (actions: task_claimed, status_written, decision_position_submitted, decision_critique_submitted, note_added, task_completed) to determine their "last activity" timestamp. No new tables needed.

2. **Idle detection (15-min threshold)**: If an agent's last activity is older than 15 minutes AND there are pending tasks assigned to them or open decisions awaiting their input, the watchdog nudges them to check the board.

3. **Active task exclusion**: Agents with at least one in_progress task are NOT nudged (they are busy, not idle).

4. **Per-agent cooldown (30 min)**: The watchdog checks the audit_log for a recent `idle_board_nudge` entry per agent within the last 30 minutes. If found, the agent is skipped. This prevents double-nudging without needing a new table.

5. **Nudge message with board summary**: The nudge message includes specific counts: "Board check: You have X pending task(s) and Y open decision(s) awaiting input. Run list_tasks and list_decisions to catch up."

6. **Audit trail logging**: Every idle nudge is logged to the audit_log with action='idle_board_nudge' and detail containing the agent name, pending task count, and open decision count.

7. **ReconcileResult updated**: Add `idle_nudges: number` field to ReconcileResult. The cycle summary log line includes the new counter.

8. **Bonus: Fix '#' escaping in MarkdownV2**: The postToGroup call at line 819 of watchdog.ts (ready-to-finalize message) sends an unescaped '#' in the Telegram MarkdownV2 message. Fix it to use `\\#` so it renders correctly instead of falling back to plain text.

## Test Commands

1. `bun test` -- all 147 existing tests still pass (no regressions)
2. New test: idle agent with pending tasks gets nudged after 15 min
3. New test: agent with active in_progress tasks is NOT nudged
4. New test: agent nudged once is NOT nudged again within 30 min cooldown
5. New test: nudge message includes correct pending task and decision counts
6. New test: idle_board_nudge action logged to audit trail
7. New test: ReconcileResult includes idle_nudges field
8. New test: watchdog '#' escaping fix -- verify postToGroup message uses escaped '#'

## Definition of Done

- All existing tests pass (147/147)
- At least 7 new tests pass covering the above criteria
- The watchdog.ts `monitorIdleAgents()` method is integrated into the main reconciliation cycle
- The '#' escaping bug from Sprint 1 is fixed
- Code compiles with no TypeScript errors (`bun build --target=bun watchdog.ts` succeeds)

## Target Metrics

- Existing test count: 147 pass, 0 fail
- New tests added: >= 7
- Total tests after sprint: >= 154
- Zero TypeScript compilation errors
