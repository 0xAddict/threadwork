# Sprint 2 Contract Proposal — Daemon-side Boot-Recovery Fallback

Status: APPROVED (RM-1 resolved — Option B, child-PID descoped; see below)
Task: #1269 (V2 Cutover · Step 2b · EPIC #1266 · HARNESS Sprint 2)
Branch: feat/v2-cutover-runbook (continuing — Sprint 1 already merged here)

## RM-1 Resolution — Child-PID scope decision (Option B: DESCOPED)

Child-PID is **descoped** from Sprint 2 and deferred to a post-Sprint-2
enhancement. Justification (per approved-contract.md RM-1 Option B):

- (a) The primary false-positive scenario in #843 was a **live `claude_pid`
  with stale state declarations** (`declared=TOOL_IN_FLIGHT age=999999s
  pid=55271` on `claude-boss`), NOT a dead parent-shell with a live child.
  A child-PID signal does not address the actual observed symptom.
- (b) `pgrep -P "$claude_pid"` semantics on macOS launchd-spawned processes
  are unreliable for Claude Code worker processes — the process tree is
  reparented and `pgrep -P` will not consistently find the worker, making
  the signal noisy and untestable.
- (c) The remaining OS signals — PID alive (`kill -0`), `last_seen_at`
  freshness, and last task progress (`tasks.last_progress_at`) — are
  sufficient to fix the #843 symptom and are all deterministically testable.

Consequence: there is **no AC#11**. The contract's acceptance criteria
remain AC#1–#10. This descope is recorded as a known gap in
`implementation-log.md` per the Verifier's instruction.

The `os_facts_alive` helper OR-s exactly three signals: pid_alive,
seen_alive, task_progress_alive. No child-PID branch is added.

## Goal
Make `bin/heartbeat-daemon-v2.sh` fall back to OS facts (PID alive, child PID,
recent task progress) when an agent's state declaration is **stale or absent**,
so the daemon does NOT false-positive a healthy already-running agent as
STUCK/CRASHED — the #843 boot-recovery bug — without regressing any of the 5
existing `tests/heartbeat/heartbeat-v2.test.sh` scenarios.

## Context / Root-Cause Analysis (ground truth, already read)
Per task #843: Claude Code loads the `emit-state.sh` hooks from `settings.json`
only at **SessionStart**. An agent session that was already running when the
hooks were installed never wires `emit-state.sh` into `PreToolUse`, so it emits
NO fresh state declarations — every declaration goes stale (`age` grows toward
the `999999` sentinel) yet the agent is perfectly healthy.

I have read `bin/heartbeat-daemon-v2.sh` (489 lines) in full. The precise defect:

- **Defect D1 — the deterministic-hung check fires before any OS-facts check.**
  Lines 342-350: the `TOOL_IN_FLIGHT`/`SUBAGENT_RUNNING` hung checks run
  "regardless of freshness threshold." A stale `TOOL_IN_FLIGHT` row
  (`state_age_sec > TOOL_IN_FLIGHT_HUNG_SEC=600`) is classified **STUCK** with
  method `deterministic-hung-tool` — even when the agent's `claude_pid` is alive
  and `last_seen_at` is recent. This is exactly the #843 symptom
  (`declared=TOOL_IN_FLIGHT age=999999s pid=55271` → false STUCK on `claude-boss`).
- **What already works (must NOT regress):** lines 358-373 — when state is stale
  AND the declared state is NOT a hung-tool/subagent state, the daemon already
  checks `pid_alive` / `seen_alive` and resolves `ALIVE` via method `os-facts`
  (test scenario 3 proves this). Sprint 2 must preserve that path.
- **Defect D2 — "child PID" and "last task progress" OS signals are unused.**
  The roadmap and #843 name three OS fallback signals: PID alive, child PID,
  last task progress. Only `claude_pid` (PID alive) and `last_seen_at` are
  consulted today. A stale declaration with a dead parent-shell `claude_pid` but
  a live sub-agent, or with recent `tasks` table progress, should still resolve
  ALIVE, not STUCK/CRASHED.

## Scope
- IN SCOPE: modify `bin/heartbeat-daemon-v2.sh` so the deterministic-hung check
  (D1) consults OS facts before emitting STUCK; add a `last task progress` OS
  signal and a child-PID signal (D2) to the stale-state fallback; add new test
  scenarios proving the fallback; prove the 5 existing scenarios still pass.
- OUT OF SCOPE: changes to `emit-state.sh`, `settings.json`, the launchd plist,
  Telegram alert routing, v1 (`heartbeat-daemon.sh`), the cutover runbook. Steps
  3/4 remain STAGED.

## Acceptance Criteria
1. **Stale hung-tool + live PID → ALIVE, not STUCK.** When `declared_state` is
   `TOOL_IN_FLIGHT` or `SUBAGENT_RUNNING` with `state_age_sec` past the hung
   threshold BUT `claude_pid` is alive (`kill -0` succeeds), `classify_agent_v2`
   returns `ALIVE` with an OS-facts-based `classification_method` — NOT `STUCK`
   via `deterministic-hung-tool`/`-subagent`.
2. **Stale hung-tool + recent last_seen → ALIVE.** Same as AC#1 but the live
   signal is `last_seen_at` within `LAST_SEEN_ALIVE_SEC` (instead of, or in
   addition to, PID) → resolves `ALIVE`.
3. **Stale hung-tool + recent task progress → ALIVE.** When PID and last_seen
   are both stale/absent but the agent's current task shows recent progress
   (a `tasks`-table row updated within a documented freshness window), the agent
   resolves `ALIVE` via a `last-task-progress` OS signal — NOT STUCK.
4. **Genuine hung still detected.** When `declared_state` is `TOOL_IN_FLIGHT`/
   `SUBAGENT_RUNNING` past threshold AND ALL OS signals are negative (PID dead,
   `last_seen_at` stale, no recent task progress), `classify_agent_v2` still
   returns `STUCK`. The fallback must not blanket-suppress real hangs.
5. **Absent declaration → no false CRASHED.** When an agent has NO row / NULL
   `state` in `agent_sessions` (declaration absent) but its tmux session exists
   and a live OS signal is present, the daemon does NOT classify `CRASHED`/
   `STUCK` purely from the missing declaration — it uses OS facts. (Genuine
   tmux-session-missing → CRASHED at line 278 is unchanged and correct.)
6. **No regression — 5 existing scenarios pass.** `bash tests/heartbeat/heartbeat-v2.test.sh`
   exits 0 with `5 pass / 0 fail` against the modified daemon. The existing
   scenarios 1, 2, 4, 5 (fresh-ALIVE, fresh-hung-STUCK, stale-dead→LLM,
   ambiguous→Gemma) and especially scenario 3 (stale-PID-alive→ALIVE) are
   unaffected.
7. **V1 not regressed.** `heartbeat-daemon.sh` (v1) is not modified. The shared
   `tasks.db.agent_sessions` table is only READ by the daemon, never written by
   this change, so v1's reads are unaffected — verified by `git diff` showing
   zero changes outside `bin/heartbeat-daemon-v2.sh` and the test file.
8. **New tests committed and green.** New scenarios covering AC#1-#5 are added
   to a test file (extending `tests/heartbeat/heartbeat-v2.test.sh` or a sibling
   `tests/heartbeat/heartbeat-v2-fallback.test.sh`), they FAIL against the
   pre-Sprint-2 daemon (RED — proving they test the fix) and PASS against the
   post-Sprint-2 daemon (GREEN). At least one test per AC#1-#5.
9. **Sourcing + idempotency preserved.** The daemon still sources cleanly
   (`_SOURCED` guard at line 9 intact — the test suite sources it), `bash -n`
   passes, and `init_db_v2` / existing function signatures used by the test
   harness are unchanged.
10. **Committed to git.** All changes committed on `feat/v2-cutover-runbook`
    with a message referencing sprint-2 and task #1269; `implementation-log.md`
    records the commit hash, the exact lines changed, and the new OS-facts
    decision order.

## Test Commands (how the Verifier should grade)
- C6 (regression gate, run FIRST): `bash tests/heartbeat/heartbeat-v2.test.sh`
  → must print `5 pass / 0 fail`, exit 0.
- C8: `git stash` or checkout the pre-Sprint-2 daemon, run the NEW test file →
  must FAIL (RED); restore the Sprint-2 daemon, re-run → must PASS (GREEN). This
  proves the new tests actually exercise the fix.
- C1/C2/C4: inspect the new tests' assertions — a stale `TOOL_IN_FLIGHT`
  (age > 600s) with a live PID asserts `ALIVE`; same with a dead PID + stale
  last_seen + no task progress asserts `STUCK`.
- C3: the new test seeds a `tasks`-table fixture with a recent progress
  timestamp and asserts `ALIVE` via the task-progress signal.
- C5: the new test removes the `agent_sessions` row (or NULLs `state`) and, with
  a live PID, asserts not-CRASHED.
- C7: `git diff main -- . ':!bin/heartbeat-daemon-v2.sh' ':!tests/heartbeat/*'`
  → empty (no changes outside the daemon + tests, modulo `.harness/` bookkeeping).
- C9: `bash -n bin/heartbeat-daemon-v2.sh` → exit 0; `source bin/heartbeat-daemon-v2.sh`
  in a subshell with `_SOURCED` does not run `main`.
- C10: `git log --oneline -- bin/heartbeat-daemon-v2.sh` shows the sprint-2
  commit on `feat/v2-cutover-runbook`.
- Code inspection: confirm the deterministic-hung branch now calls an OS-facts
  helper before emitting STUCK, and the `classification_method` strings make the
  decision path auditable (e.g. `os-facts-hung-override`, `last-task-progress`).

## Definition of Done
- `bin/heartbeat-daemon-v2.sh` modified so D1 and D2 are fixed.
- New test scenarios for AC#1-#5 added, RED-then-GREEN proven.
- `bash tests/heartbeat/heartbeat-v2.test.sh` → `5 pass / 0 fail`.
- All 10 acceptance criteria satisfiable by the Verifier's test commands.
- Committed on `feat/v2-cutover-runbook`; `implementation-log.md` updated with
  commit hash, line ranges changed, and the new decision order.
- `status.txt` set to `ready_for_evaluation`.

## Target Metrics (adapted rubric — see decision-log.md)
- Functionality >= 9: all 10 criteria met; fallback works AND no regression.
- Completeness & structure: D1 and D2 both fixed; tests cover every AC.
- Executability & correctness: daemon sources + runs, all tests green,
  RED-then-GREEN demonstrated, v1 untouched.
- Overall >= 78 for PASS.

## Design Approach (for Verifier review before approval)
The minimal, low-risk change:
1. Add a helper `os_facts_alive(agent, declared_pid, last_seen_age_sec)` that
   returns 0/1 by OR-ing exactly three signals: (a) `claude_pid` alive via
   `kill -0`, (b) `last_seen_at` within `LAST_SEEN_ALIVE_SEC`, (c) NEW —
   last task progress for the agent's current task
   (`tasks.last_progress_at`, joined via `agent_sessions.current_task_id`,
   falling back to `tasks.last_heartbeat_at` when `last_progress_at` is NULL)
   within the new `TASK_PROGRESS_FRESH_SEC=900s` threshold. No child-PID
   check — descoped per RM-1 Option B.
   The helper also exports `OS_FACTS_REASON` describing which signal fired
   (pid_alive / seen_alive / task_progress_alive) so the
   `classification_method` and reason strings are auditable.
2. In the deterministic-hung branch (lines 343-350): before emitting `STUCK`,
   call `os_facts_alive`. If alive → classify `ALIVE`, method
   `os-facts-hung-override`, reason naming the suppressed-hung state. If not
   alive → emit `STUCK` as today (genuine hang).
3. The existing stale-state `os-facts` branch (lines 358-373) is refactored to
   reuse the same `os_facts_alive` helper so behaviour is consistent and
   scenario 3 still passes.

## Open Questions for the Verifier — RESOLVED

- Q1 (RESOLVED): `TASK_PROGRESS_FRESH_SEC = 900s` (15 min). Accepted by the
  Verifier. Implemented as a named constant at the top of the daemon
  alongside `LAST_SEEN_ALIVE_SEC` and the other thresholds.
- Q2 (RESOLVED): New tests live in a sibling file
  `tests/heartbeat/heartbeat-v2-fallback.test.sh`. The existing
  `tests/heartbeat/heartbeat-v2.test.sh` stays byte-stable for AC#6. The
  Verifier runs both and requires green on both.
- Q3 (RESOLVED): Canonical task-progress signal is `tasks.last_progress_at`,
  accessed via `agent_sessions.current_task_id → tasks.id`. When
  `last_progress_at` is NULL, fall back to `tasks.last_heartbeat_at`. Both
  columns confirmed present in the live `tasks.db` schema.
