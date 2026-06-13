# Sprint 2 Approved Contract — Daemon-side Boot-Recovery Fallback

Status: APPROVED (with one required modification — see below)
Verifier: harness-verifier
Date: 2026-05-22

## Decision

APPROVED WITH REQUIRED MODIFICATION — see RM-1 below. The contract is otherwise
solid: criteria are objective, measurable, and testable without a browser; all
10 are specifically testable via script execution + code inspection; ground-truth
line number citations are accurate.

## Contract Assessment

All ground-truth claims verified:
- Lines 342–350: deterministic-hung check confirmed (TOOL_IN_FLIGHT / SUBAGENT_RUNNING
  STUCK paths, "regardless of freshness threshold").
- Lines 358–373: existing stale-state OS-facts branch confirmed (pid_alive /
  seen_alive → ALIVE via `os-facts`).
- Line 9: `_SOURCED` guard confirmed.
- `agent_sessions.current_task_id` → `tasks.last_progress_at` confirmed as the
  right column for Q3 (canonical task progress signal).

Design approach (os_facts_alive helper, D1/D2 fix) is correct and minimal.
The refactor to share the helper across the hung-check and the existing stale
branch is the right pattern; it ensures scenario 3 stays green without a
separate code path.

## Open Questions — Resolutions

Q1 (TASK_PROGRESS_FRESH_SEC = 900s): Accepted. 900s is a reasonable threshold
for distinguishing a genuinely hung agent (no task progress for 15 min) from a
healthy already-running one (regular `write_status`/`send_note` calls). Document
it as a named constant so it can be tuned later.

Q2 (sibling test file `heartbeat-v2-fallback.test.sh`): Accepted. The existing
suite's `5 pass / 0 fail` gate stays byte-stable for AC#6. The sibling file owns
AC#1–#5 (and any child-PID test required by RM-1). The Verifier will run both
files and require green results on both.

Q3 (task progress column): Use `tasks.last_progress_at` as the canonical signal,
accessed via `agent_sessions.current_task_id → tasks.id`. If `last_progress_at`
is NULL, fall back to `tasks.last_heartbeat_at` (also present in the schema).
Document the fallback column in the implementation log.

## Required Modification

**RM-1: Child-PID signal must be explicitly scoped in or out.**

The roadmap (Sprint 2 specification) states: "it must fall back to OS facts (PID
alive, child PID, last task progress)." Child PID is listed as a named OS signal
alongside PID alive and task progress. The contract's design approach marks it
"optionally also." This is ambiguous — the contract cannot leave a roadmap-
specified signal in "optional" limbo.

The Generator must do ONE of the following before implementation begins:

**Option A — include child-PID in scope:**
Add an acceptance criterion (AC#11) for child-PID:
"Stale hung-tool + dead claude_pid + live child PID → ALIVE. When claude_pid is
dead but `pgrep -P claude_pid` (or equivalent) shows a live child process,
classify ALIVE via `os-facts-child-pid`."
Add a corresponding test in the fallback test file (set pid=dead but seed a
real child PID that is alive).

**Option B — explicitly descope child-PID with justification:**
Add a section "Child-PID scope decision" to the contract stating: child-PID is
deferred to a post-Sprint-2 enhancement because (a) the primary false-positive
scenario in #843 was a live claude_pid with stale declarations, not a dead
parent-shell; (b) `pgrep -P` semantics on macOS launchd-spawned processes may
not reliably find Claude Code's worker processes; (c) the remaining OS signals
(PID alive, last_seen_at, task progress) are sufficient to fix the #843 symptom.
If descoped, explicitly mark it as a known gap in the implementation log.

Either option is acceptable. Pick one, update the contract, set status to
"negotiating" → "implementing" when ready.

**No other modifications required.** Once RM-1 is resolved, the contract is
approved as-is.

## Rubric Thresholds (reminder)

Per decision-log.md adapted rubric:
- Functionality (40%) hard threshold >= 9 for PASS.
- "Design Quality" → Completeness & structure (25%).
- "Craft" → Executability & correctness (20%).
- "Originality" → de-emphasised, baseline 7-8 (15%).
- Overall >= 78 required for PASS.

## What Will Fail This Sprint

The Verifier will fail if ANY of the following:

- `bash tests/heartbeat/heartbeat-v2.test.sh` does not exit 0 with `5 pass / 0 fail`.
- The fallback test file does not exist with at least 5 new scenarios (AC#1–#5).
- RED-then-GREEN not demonstrated: new tests must fail against the pre-Sprint-2
  daemon and pass against the Sprint-2 daemon.
- Stale TOOL_IN_FLIGHT + live claude_pid returns STUCK (D1 not fixed).
- Genuine hung (all OS signals negative) still returns ALIVE (real hung suppressed).
- `heartbeat-daemon.sh` (v1) is modified.
- Any file other than `bin/heartbeat-daemon-v2.sh` and `tests/heartbeat/heartbeat-v2-fallback.test.sh`
  (plus `.harness/` bookkeeping) is modified — confirmed by `git diff`.
- `bash -n bin/heartbeat-daemon-v2.sh` fails.
- The daemon cannot be sourced in tests (the `_SOURCED` guard breaks).
- Commit message does not reference sprint-2 and task #1269.

## Notes for Implementation

- The `last_progress_at` column exists in the tasks table and is the right
  signal. The query to check it: `SELECT last_progress_at FROM tasks WHERE id=(SELECT current_task_id FROM agent_sessions WHERE agent='$agent' LIMIT 1) LIMIT 1;` — handle NULLs gracefully.
- `TASK_PROGRESS_FRESH_SEC` should be a named constant at the top of the daemon
  (alongside `LAST_SEEN_ALIVE_SEC` and the other thresholds).
- The new `classification_method` strings for auditing should be:
  `os-facts-hung-override` (D1 fix, PID/seen_alive signal), and
  `last-task-progress` (D2 fix, task progress signal) — or equivalently named
  strings that make the decision path unambiguous in the DB.
- Do NOT rename or alter `init_db_v2` or `classify_agent_v2` function signatures
  — the test harness calls them by name.
