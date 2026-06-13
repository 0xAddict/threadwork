# V2 Heartbeat Cutover — Decision Log

## [2026-05-22] Harness initialized by Boss
- Project: V2 heartbeat cutover (epic task #1266). Design approved by
  GweiSprayer via Telegram 2026-05-22.
- Two sprints: Sprint 1 = cutover runbook (#1267), Sprint 2 = daemon
  boot-recovery fallback (#1269). Step 1 (#1268, repoint launchd) is
  interleaved ops done by Boss between sprints — not a harness sprint.
- A stale April harness run (.harness/ for "Watchdog Decision Monitoring") was
  archived to `.harness-archive-20260409/` before this run.

## RUBRIC ADAPTATION (this is infrastructure, not a web app)
The standard harness Verifier rubric is adapted — there is no browser/app:
- **Functionality** (40%, hard threshold >= 9): does the deliverable meet ALL
  contract acceptance criteria. Tested by reading the doc, running script
  tests, and code inspection — NOT browser automation.
- **"Design Quality"** -> reinterpret as **Completeness & structure** of the
  deliverable.
- **"Craft"** -> reinterpret as **Executability & correctness** — do the
  commands actually run, does the script pass its tests, no regressions.
- **"Originality"** -> de-emphasised; baseline 7-8 unless the work is notably
  sloppy or notably excellent.
- PASS still requires Functionality >= 9 AND overall >= 78.

## EVALUATOR STANCE (per GweiSprayer Q5)
The Verifier is a genuine OPPOSING-POSITION critic: attack each deliverable
hard — hunt gaps, inexecutable commands, untested states, V1 regressions,
wrong file paths, missing rollback. Argue the deliverable is wrong until
proven otherwise. BUT it is NOT a nitpick-blocker: PASS when the contract is
genuinely satisfied, and never block on things outside the contract. Opposing
position, fairly applied — not unforgiving for its own sake.

## [2026-05-22] Sprint 1 PASS + Step 1 complete
- Sprint 1 (cutover runbook) — Verifier PASS 90/100, all 10 criteria met. Task #1267 completed. status.txt=passed.
- Step 1 (launchd repoint, #1268) — done + verified by ops sub-agent: heartbeat-v2 now runs the real daemon (PID 61525), G1 fixed (KeepAlive, no StartInterval), G2 fixed via mode-600 ~/.threadwork/secrets.env. v1 untouched, v2 parallel. Backup retained.
- Sprint 2 (daemon boot-recovery fallback, #1269) kicked off — Generator proposing contract.

## [2026-05-22] Sprint 2 contract APPROVED (with RM-1)
- Generator submitted proposed-contract.md: 10 ACs. D1 = deterministic-hung check (lines ~342-350) fires before any OS-facts check → a stale TOOL_IN_FLIGHT row false-flags a healthy already-running agent as STUCK (the #843 symptom). D2 = only PID-alive + last_seen consulted; child-PID and task-progress OS signals unused.
- Verifier wrote approved-contract.md: APPROVED WITH ONE REQUIRED MODIFICATION. RM-1 — the child-PID OS signal must be explicitly scoped IN (Option A: AC#11 + test) or OUT (Option B: descope w/ justification, mark known gap). Q1 (TASK_PROGRESS_FRESH_SEC=900s, named constant), Q2 (sibling test file tests/heartbeat/heartbeat-v2-fallback.test.sh; existing suite byte-stable for AC#6), Q3 (tasks.last_progress_at via agent_sessions.current_task_id, fallback tasks.last_heartbeat_at) all resolved/accepted.
- MONITOR ACTION: original Generator agent (a51a7383678ccca8d) was cleaned up — SendMessage by ID failed. Re-spawned the harness Generator via Agent tool. NEW Generator agent ID = a868fc1345faf410e (background, opus), child task #1282 under #1269. Tasked to resolve RM-1, set status.txt→implementing, implement D1/D2 fix + fallback tests (RED-then-GREEN, zero V1 regression), commit, set status.txt→ready_for_evaluation. Future monitor ticks: use a868fc1345faf410e for the Generator, NOT the dead a51a7383678ccca8d. Verifier remains a20ba0de9ecc38731 (re-spawn if its SendMessage also fails).

## [2026-05-22] Sprint 2 PASS — Phase A complete
- Sprint 2 (daemon boot-recovery fallback, #1269) — harness Verifier verdict PASS, 91/100 (Functionality 9/10). All 10 ACs + RM-1 met. status.txt = passed. Task #1269 completed.
- D1 fixed: deterministic-hung check calls os_facts_alive before STUCK (stale hung-tool + live claude_pid/recent last_seen/recent task progress → ALIVE via os-facts-hung-override). D2 fixed: last-task-progress signal (tasks.last_progress_at via agent_sessions.current_task_id, fallback last_heartbeat_at, TASK_PROGRESS_FRESH_SEC=900s). Genuine hangs still → STUCK. RM-1 = Option B (child-PID descoped).
- RED-then-GREEN proven by Verifier: heartbeat-v2-fallback.test.sh 8p/9f on pre-S2 daemon → 17p/0f on S2 daemon; existing heartbeat-v2.test.sh 5/0 unchanged; v1 untouched. Commits 9107d5b + 5c2d4d6 on feat/v2-cutover-runbook.
- Verifier advisories (non-blocking, address before Step 3): F1 — Sprint 1 runbook G2 secrets line-citations stale after :? → :- change; F2 — install.sh should recreate the ~/bin/heartbeat-daemon-v2.sh symlink on env rebuild.
- PHASE A (Steps 0/1/2b) COMPLETE. HARD STOP per epic design: Steps 3/4 (#1270 48h soak, #1271 cutover flip + v1 decommission) remain STAGED — NOT executed until GweiSprayer greenlights. Telegram sent + epic #1266 noted. Harness monitor cron (56af9fae) cancelled.
