# Sprint 1 Contract Proposal — V2 Heartbeat Cutover Runbook

Status: PROPOSED
Task: #1267 (V2 Cutover · Step 0 · EPIC #1266 · HARNESS Sprint 1)
Branch: feat/v2-cutover-runbook (off main)

## Goal
Write a durable, executable on-disk cutover runbook at
`docs/v2-heartbeat-cutover-runbook.md` that lets any operator migrate the
threadwork heartbeat from v1 (LLM pane-text guessing) to the already-built v2
state-contracts daemon, covering all 5 cutover steps with exact commands, file
paths, verification checks, and rollback.

## Context / Ground Truth (reconstructed, not assumed)
The contract is grounded in artifacts I have already read:
- Real v2 daemon: `bin/heartbeat-daemon-v2.sh` (489 lines) — the cutover target.
- v2 launchd plist `~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist`
  currently points `ProgramArguments` at `/Users/coachstokes/bin/heartbeat-daemon-v2.sh`,
  which is a 3-line `threadwork-v1.0.0 placeholder` stub (confirmed on disk).
- v1 launchd plist `com.threadwork.heartbeat.plist` runs
  `/Users/coachstokes/bin/heartbeat-daemon.sh` with `KeepAlive`.
- Feature flag `heartbeat_v2_enabled` is already `1` in `tasks.db`.
- `~/bin/heartbeat-v2.db` and `~/bin/heartbeat-v2.log` already exist.
- Task bodies #826 (state-contracts spec), #842/#843 (soak bug), #829/#830
  (harness build) read for design intent.

Two real gaps the runbook MUST surface (not gloss over):
- G1: the v2 plist invokes the daemon directly (no `/bin/bash`) and as a
  `StartInterval=300` periodic job, while the real daemon has its OWN internal
  `while true; sleep 300` loop — a launch model mismatch.
- G2: the v2 plist sets NO `TELEGRAM_TOKEN` / `SUPABASE_SERVICE_KEY` env vars,
  but the real daemon hard-fails at startup via `:?` parameter expansion if
  either is unset.

## The 5 Cutover Steps (runbook scope)
- Step 0: this runbook itself (meta — it is the deliverable).
- Step 1: repoint launchd `com.threadwork.heartbeat-v2` from the stub to the
  real daemon; reload; verify it runs real code. (Boss executes via interleaved
  ops task #1268 — runbook documents it, harness does not run it.)
- Step 2b: daemon-side boot-recovery fallback (implemented in Sprint 2 — Step 2
  section in the runbook STAGES it: describes the #843 bug and points forward).
- Step 3: 48h v1/v2 parallel soak; pass = v2 false-positive rate <= 50% of v1.
  (STAGED — section written, not executed by harness.)
- Step 4: cutover flip (v1 off, v2 on), DB collapse, 14-day v1 decommission with
  rollback. (STAGED — section written, not executed by harness.)

## Acceptance Criteria
1. **File exists & committed.** `docs/v2-heartbeat-cutover-runbook.md` exists on
   branch `feat/v2-cutover-runbook` and is committed to git with a message
   referencing sprint-1 and task #1267.
2. **All 5 steps covered.** The runbook has a clearly delimited section for each
   of Step 0, Step 1, Step 2, Step 3, Step 4. Each step section contains four
   labelled sub-parts: **Commands**, **File paths**, **Verification**, **Rollback**.
3. **Exact, executable commands.** Every command block uses absolute paths and
   real artifact names that match ground truth (e.g.
   `~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist`,
   `/Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh`,
   `launchctl bootout`/`bootstrap` or `unload`/`load`). No placeholder paths, no
   invented filenames. A reviewer copy-pasting Step 1's commands would actually
   repoint the daemon.
4. **Step 1 correctness.** The Step 1 section explicitly states the plist
   currently points at the 3-line stub, gives the exact edit to the
   `ProgramArguments` array (new value =
   `/Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh`),
   the reload command sequence, and a verification that confirms the *real*
   489-line daemon (not the stub) is what launchd now executes.
5. **Gaps G1 & G2 addressed.** The runbook explicitly calls out the launch-model
   mismatch (G1) and the missing `TELEGRAM_TOKEN` / `SUPABASE_SERVICE_KEY` env
   vars (G2), and gives the operator a concrete remediation for each inside the
   Step 1 section (e.g. add `EnvironmentVariables` keys / decide periodic vs
   long-running). The runbook does not ship a daemon that would crash on boot.
6. **Verification commands are real checks, not prose.** Each step's
   Verification sub-part contains runnable commands (e.g. `launchctl list`,
   `sqlite3 ~/bin/heartbeat-v2.db "SELECT ..."`, `grep` on the v2 log, `pgrep`)
   with the expected output described.
7. **Rollback for every step.** Each step (1, 3, 4) has a concrete rollback
   sequence that returns the system to the prior known-good state. Step 4's
   rollback covers the 14-day v1-decommission window (v1 plist is retained, not
   deleted, until day 14; rollback = re-`bootstrap` v1, disable v2 flag).
8. **Soak pass criterion stated.** The Step 3 section states the explicit pass
   gate: v2 false-positive rate <= 50% of v1's false-positive rate over the 48h
   window, and gives the SQL/log queries to compute both rates from
   `heartbeat-v2.db` (`heartbeats_v2` table) and the v1 heartbeat DB/log.
9. **Soak bug cross-reference.** The Step 2 / Step 3 sections reference the
   #842/#843 soak bug (existing sessions don't load emit-state hooks → stale
   declarations → false STUCK), explain the short-term mitigation (restart/clear
   sessions, fix (a)) and forward-reference the Sprint 2 daemon-side fallback
   (fix (b), Step 2b).
10. **Staged-vs-executed clarity.** The runbook explicitly marks Step 3 and
    Step 4 as STAGED (documented, awaiting GweiSprayer greenlight) vs Step 1 as
    operator-executable now, so no one runs the soak/flip prematurely.

## Test Commands (how the Verifier should grade)
- C1: `test -f docs/v2-heartbeat-cutover-runbook.md && git -C <PROJECT> log
  --oneline -- docs/v2-heartbeat-cutover-runbook.md` → file present & committed
  on `feat/v2-cutover-runbook`.
- C2: `grep -nE '^#+ .*Step [01234]' docs/v2-heartbeat-cutover-runbook.md` →
  5 step sections; per-section `grep` for Commands/File paths/Verification/Rollback.
- C3/C4: Read the Step 1 section. Confirm the stub-vs-real-daemon paths match
  ground truth; dry-run the plist edit logic against the real plist file
  (without applying) — e.g. `plutil -lint` on a copy after the documented edit,
  or inspect that the documented new `ProgramArguments` value resolves to a real
  executable file (`test -x`).
- C5: `grep -n -i 'TELEGRAM_TOKEN\|SUPABASE_SERVICE_KEY\|StartInterval\|while'`
  in the runbook → confirms G1 & G2 are addressed with remediation text.
- C6: Extract each Verification command block; confirm they are syntactically
  valid shell and reference real DBs/paths (`sqlite3 ~/bin/heartbeat-v2.db
  '.tables'` shows `heartbeats_v2`).
- C7: Confirm a Rollback sub-part exists and is non-empty for Steps 1, 3, 4.
- C8/C9/C10: Read for the soak pass gate (<=50%), the #842/#843 reference, and
  explicit STAGED markers on Steps 3 & 4.
- Inspection: spot-check that no command uses an invented path. Cross-check 5
  random absolute paths in the runbook against `ls`/`test -e`.

## Definition of Done
- `docs/v2-heartbeat-cutover-runbook.md` written, complete, and committed on
  branch `feat/v2-cutover-runbook`.
- All 10 acceptance criteria satisfiable by the Verifier's test commands.
- `implementation-log.md` updated with files changed and the commit hash.
- `status.txt` set to `ready_for_evaluation`.
- No code execution of Steps 1/3/4 — this sprint only writes the runbook.

## Target Metrics (adapted rubric — see decision-log.md)
- Functionality >= 9: all 10 criteria met, every command executable & paths real.
- Completeness & structure: all 5 steps, all 4 sub-parts each, no gaps.
- Executability & correctness: commands copy-paste-run; G1/G2 prevent a
  boot-crash; verification queries return real data.
- Overall >= 78 for PASS.

## Open Questions for the Verifier
- Q1: Step 1 plist edit — prefer `launchctl bootout/bootstrap gui/$UID` (modern)
  or `unload/load` (legacy)? Proposal: document `bootout`/`bootstrap` as primary
  with `unload`/`load` as a noted fallback, since both still work on Darwin 25.
- Q2: For G2, should Step 1 add the env vars to the v2 plist directly, or source
  them from a shared secrets file? Proposal: document adding them to the plist
  `EnvironmentVariables` dict (matches how the daemon reads them) and note the
  secrets-file alternative — operator's call, runbook presents both.
