# Sprint 2 Implementation Log

## [2026-04-08T23:20:00Z] Contract Proposed
- Files read: watchdog.ts, db.ts, server.ts, nudge.ts, notify.ts, config.ts, audit.ts, decision.ts
- Decision: Use audit_log for activity tracking rather than a new table. The audit_log already records task_claimed, status_written, decision_position_submitted, decision_critique_submitted events per agent. Querying MAX(created_at) grouped by agent gives us "last activity" with zero schema changes.
- Decision: Use audit_log action='idle_board_nudge' for cooldown tracking, avoiding another new table.
- Decision: Fix the '#' escaping bug on watchdog.ts line 819 as part of this sprint.
- Next: Await contract approval, then implement.

## [2026-04-08T23:27:00Z] Bonus: MarkdownV2 '#' Escaping Fix
- Files changed: notify.ts, watchdog.ts
- Decision: Export `esc()` from notify.ts so watchdog.ts can use it for inline postToGroup calls
- Fixed ALL unescaped postToGroup calls in watchdog.ts (lines 280, 335, 363, 533, 617, 847) -- not just the one flagged by the Verifier
- Confirmed: after fix, Telegram errors changed from "can't parse entities: Character '#' is reserved" to "chat not found" (valid MarkdownV2 now, just no valid chat in test env)
- Next: Implement idle agent monitoring.

## [2026-04-08T23:28:00Z] Idle Agent Board Check Nudging Implemented
- Files changed: watchdog.ts (monitorIdleAgents method, ReconcileResult.idle_nudges, main loop integration)
- Added `monitorIdleAgents()` method to TaskReconciler (section 7)
- Activity tracking: queries audit_log MAX(created_at) for ACTIVITY_ACTIONS per agent
- Idle threshold: 15 min (static readonly IDLE_THRESHOLD_MS)
- Cooldown: 30 min per agent via audit_log action='idle_board_nudge' (static readonly NUDGE_COOLDOWN_MS)
- Active task exclusion: skips agents with in_progress tasks
- Nudge message: "Board check: You have X pending task(s) and Y open decision(s) awaiting input."
- Integrated into main loop as Step 3b (between decision monitoring and debrief gates)
- Updated cycle summary log to include idle_nudges counter
- No new database tables or columns needed
- Next: Write tests and verify.

## [2026-04-08T23:29:00Z] Tests Written and All Passing
- Files changed: tests/idle-nudge.test.ts (new, 11 tests), tests/notify.test.ts (2 new tests), tests/decision-monitor.test.ts (freshResult update)
- Test count: 160 pass, 0 fail (was 147 before sprint)
- 13 new tests: 11 idle-nudge tests + 2 esc/notify tests
- Fixed freshResult() in decision-monitor.test.ts to include idle_nudges field
- Build verification: `bun build --target=bun watchdog.ts` succeeds
- Next: Set status to ready_for_evaluation.
