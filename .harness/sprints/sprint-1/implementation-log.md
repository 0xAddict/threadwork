# Sprint 1 Implementation Log — V2 Heartbeat Cutover Runbook

## [2026-05-22] Contract approved, implementation started
- Verifier APPROVED all 10 acceptance criteria; both open questions resolved as
  proposed (Q1: bootout/bootstrap primary + unload/load fallback; Q2: env vars
  in plist EnvironmentVariables primary + secrets-file alternative).
- Branch `feat/v2-cutover-runbook` created off `main`.
- status.txt -> implementing.

## [2026-05-22] Ground-truth re-verification before writing
- Confirmed real v2 daemon: `bin/heartbeat-daemon-v2.sh`, 489 lines, executable.
- Confirmed stub: `~/bin/heartbeat-daemon-v2.sh`, 3-line threadwork-v1.0.0 placeholder.
- Confirmed v2 plist points ProgramArguments at the stub, StartInterval=300, no
  TELEGRAM_TOKEN / SUPABASE_SERVICE_KEY env vars.
- Confirmed v1 daemon `~/bin/heartbeat-daemon.sh`: LOG=`~/bin/heartbeat.log`,
  DB=`~/bin/heartbeat.db` table `heartbeats` (cols: timestamp, agent, status,
  reason, consecutive_stuck).
- Confirmed v2 DB `~/bin/heartbeat-v2.db` table `heartbeats_v2` (12108 rows from
  prior soak; cols: timestamp, agent, declared_state, declared_source,
  state_age_sec, external_status, classification_method, reason,
  consecutive_stuck).
- Confirmed launchd stdout/stderr dir `~/.threadwork/logs/` (heartbeat-v2 logs
  currently 0 bytes — proves the stub emits nothing).
- Read task bodies #826 (state-contracts spec), #842/#843 (soak bug root cause),
  #829/#830 (harness build) from the task board.

## [2026-05-22] Runbook written
- File: `docs/v2-heartbeat-cutover-runbook.md`.
- Structure: 5 step sections (0-4), each with 4 labelled sub-parts —
  Commands / File paths / Verification / Rollback (verified 5x each via grep).
- Step 1: explicit stub-vs-real-daemon naming; PlistBuddy `Set :ProgramArguments:0`
  to the real daemon path; reload via `launchctl bootout`/`bootstrap`
  (gui/$(id -u)) with `unload`/`load` fallback noted.
- G1 (launch-model mismatch): documented + remediated — delete `StartInterval`,
  add `KeepAlive bool true` (matches v1 plist's launch model). Verification:
  `pgrep -fl heartbeat-daemon-v2.sh` must show exactly one process.
- G2 (missing env vars): documented + remediated — add TELEGRAM_TOKEN and
  SUPABASE_SERVICE_KEY to plist EnvironmentVariables (primary) or source from
  `~/.threadwork/secrets.env` (alternative). Verification: `heartbeat-v2.err.log`
  must be empty (no ":? env var required" crash). Cited daemon line numbers
  (18, 31, 66-90).
- Step 2: stages the Sprint 2 boot-recovery fallback; references #843 root cause;
  no operator commands (code change lands in Sprint 2).
- Step 3: marked STAGED; pass gate stated (v2 FP rate <= 50% of v1 FP rate);
  SQL queries over both DBs to compute rates; fix-(a) pre-soak `/clear` step for
  the #842/#843 stale-declaration artefact.
- Step 4: marked STAGED; flip (v1 off, v2 on), DB collapse via ATTACH into the
  canonical `~/bin/heartbeat.db`, 14-day decommission timer, full rollback
  retaining the v1 plist for the whole window.

## [2026-05-22] Self-check (not self-grading)
- All 12 absolute paths in the runbook resolve on disk (`test -e`) — 0 missing.
- Real daemon `test -x` passes; 489 lines confirmed.
- Step 1 plist edits dry-run on a COPY of the real plist: `plutil -lint` -> OK;
  ProgramArguments repointed to real daemon; KeepAlive added; StartInterval gone.
- All 26 fenced `bash` blocks pass `bash -n` syntax check.
- Verification SQL queries executed against the real `heartbeat-v2.db` and
  `heartbeat.db` — columns confirmed, queries return real data.
- G1/G2 keyword coverage, `#842/#843` references (5), `STAGED` markers (5),
  `50%` soak gate — all present.

## Files changed
- ADDED: `docs/v2-heartbeat-cutover-runbook.md` (the deliverable).
- harness bookkeeping: `.harness/sprints/sprint-1/{status.txt,implementation-log.md}`.

## Commit
- Commit hash: `d7952c20c1ab644296f7d859b45042efcaa1c560` (`d7952c2`) on branch
  `feat/v2-cutover-runbook`.
- Commit message: "sprint-1: V2 heartbeat cutover runbook (#1267)".
- 5 files changed; `docs/v2-heartbeat-cutover-runbook.md` created.
- status.txt -> ready_for_evaluation.

## Handoff to Verifier
Deliverable ready for evaluation. Suggested test commands (contract C1-C10):
- C1: `test -f docs/v2-heartbeat-cutover-runbook.md && git -C
  /Users/coachstokes/.claude/mcp-servers/task-board log --oneline --
  docs/v2-heartbeat-cutover-runbook.md` (on branch feat/v2-cutover-runbook).
- C2: `grep -nE '^## [0-4]\.' docs/v2-heartbeat-cutover-runbook.md` -> 5 sections;
  `grep -c '^### Commands' ...` etc -> 5 each for all 4 sub-parts.
- C3/C4: dry-run the Step 1 PlistBuddy edits on a copy of the real plist, then
  `plutil -lint` (passes), confirm ProgramArguments resolves to the real daemon
  (`test -x`).
- C5: `grep -c 'StartInterval\|KeepAlive\|TELEGRAM_TOKEN\|SUPABASE_SERVICE_KEY'`.
- C6: extract verification blocks, run `bash -n` (all 26 blocks pass).
- C7: Rollback sub-part non-empty for Steps 1/3/4 (and 0/2).
- C8/C9/C10: `50%` soak gate present; `#842`/`#843` referenced (5x); `STAGED`
  markers on Steps 3 & 4 (5x).
