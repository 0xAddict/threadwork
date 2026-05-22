# Sprint 1 Approved Contract — V2 Heartbeat Cutover Runbook

Status: APPROVED
Verifier: harness-verifier
Date: 2026-05-22

## Decision

APPROVED — proceed to implementation.

## Contract Assessment

All 10 acceptance criteria are objective, measurable, and testable by code/doc
inspection without a browser. Each has corresponding test commands (C1–C10).
Ground-truth anchoring has been verified:

- `/Users/coachstokes/bin/heartbeat-daemon-v2.sh` confirmed as 3-line stub.
- `/Users/coachstokes/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist`
  confirmed to point `ProgramArguments` at the stub path, with `StartInterval=300`
  and NO `TELEGRAM_TOKEN`/`SUPABASE_SERVICE_KEY` env vars.
- `heartbeat_v2_enabled` flag confirmed as `1` in `tasks.db`.
- Real 489-line daemon confirmed at `bin/heartbeat-daemon-v2.sh`.
- `~/bin/heartbeat-v2.db` and `~/bin/heartbeat-v2.log` confirmed to exist.

Gaps G1 and G2 are genuine, accurately diagnosed, and correctly required by
AC#5. A runbook that does not address them would produce a daemon that either
double-loops or crashes on boot. Good catch.

## Open Questions — Resolutions

Q1 (launchctl syntax): The Generator's proposal — `bootout`/`bootstrap` as
primary, `unload`/`load` as noted fallback — is accepted. Darwin 25.5.0 is
the current platform; `bootout`/`bootstrap` is the correct modern form.

Q2 (G2 remediation): The Generator's proposal — document adding env vars
directly to the plist `EnvironmentVariables` dict as primary, secrets-file
as noted alternative — is accepted. This is the straightforward operator
path and matches how the daemon consumes the vars.

## Rubric Thresholds (reminder)

Per decision-log.md adapted rubric:
- Functionality (40%) hard threshold >= 9 for PASS.
- "Design Quality" → Completeness & structure (25%).
- "Craft" → Executability & correctness (20%).
- "Originality" → de-emphasised, baseline 7-8 (15%).
- Overall >= 78 required for PASS.

## What Will Fail This Sprint

The Verifier will fail this sprint if ANY of the following:

- `docs/v2-heartbeat-cutover-runbook.md` does not exist or is not committed on
  `feat/v2-cutover-runbook`.
- Any of the 5 steps (0–4) is missing its section or any of the 4 sub-parts
  (Commands, File paths, Verification, Rollback).
- Any absolute path in the runbook does not resolve to a real file/directory
  on this machine.
- The Step 1 section does not explicitly name the stub, give the corrected
  `ProgramArguments` value pointing at the real daemon, and give reload commands.
- G1 (StartInterval double-loop) and G2 (missing env vars) are not addressed
  with concrete remediations in the Step 1 section.
- Any Verification sub-part is prose only with no runnable command.
- Rollback is missing or empty for Steps 1, 3, or 4.
- The soak pass criterion (v2 FP rate <= 50% of v1) is not stated.
- Steps 3 and 4 are not explicitly marked STAGED.
- The file references task #842 or #843 for the soak bug or omits the
  forward-reference to Sprint 2 / Step 2b.

## Notes for Implementation

- Do not execute Steps 1, 3, or 4. Write only.
- `plutil -lint` should pass on a copy of the plist after the documented edit.
- The test command `test -x /Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh`
  must pass (it does today — the Verifier will re-check after the runbook is written
  to confirm no accidental path divergence).
- C1 placeholder `<PROJECT>` should be replaced with the real path in the
  implementation-log's test-command examples; the runbook itself should use
  the real path.
