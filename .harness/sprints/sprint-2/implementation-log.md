# Sprint 2 Implementation Log — Daemon Boot-Recovery Fallback

Task: #1269 · Branch: feat/v2-cutover-runbook · Generator: harness-generator (re-spawn)

## RM-1 decision
Option B — **child-PID OS signal DESCOPED**. Justification recorded in
`proposed-contract.md` ("RM-1 Resolution" section): #843's symptom was a live
`claude_pid` + stale declarations (not a dead parent-shell); `pgrep -P` on
macOS launchd-spawned workers is unreliable; PID-alive + last_seen +
`tasks.last_progress_at` cover the symptom. No AC#11. ACs remain #1–#10.

### KNOWN GAP (carried forward)
Child-PID fallback is NOT implemented this sprint. If a future scenario emerges
where the parent-shell `claude_pid` dies but a live worker child survives AND
`last_seen_at`/task-progress are both stale, the daemon would still fall through
to the LLM tier (not STUCK). That is acceptable degradation (LLM-arbitrated, not
a false STUCK) but a child-PID signal would resolve it deterministically. Track
as a post-Sprint-2 enhancement.

## Canonical task-progress column
`tasks.last_progress_at`, joined via `agent_sessions.current_task_id → tasks.id`.
Fallback to `tasks.last_heartbeat_at` when `last_progress_at` is NULL. Both
columns confirmed present in the live `tasks.db` schema (verified 2026-05-22).

## Q-resolutions baked in
- TASK_PROGRESS_FRESH_SEC = 900s — named constant at top of daemon.
- New tests: sibling file tests/heartbeat/heartbeat-v2-fallback.test.sh.
- Existing tests/heartbeat/heartbeat-v2.test.sh kept byte-stable.

## Progress

### [2026-05-22] RM-1 resolved, status → implementing
- Files changed: .harness/sprints/sprint-2/proposed-contract.md, status.txt
- Decision: Option B descope (above).
- Next: write RED test file, prove it fails on pre-Sprint-2 daemon.

### [2026-05-22] Environmental discovery — deployed-path placeholder
- The test file `heartbeat-v2.test.sh` sources `$DAEMON =
  /Users/coachstokes/bin/heartbeat-daemon-v2.sh`. That path was a stale
  115-byte **placeholder** ("threadwork-v1.0.0 placeholder"), NOT the real
  489-line daemon (which lives in the repo at `bin/heartbeat-daemon-v2.sh`).
  Commit b620383 ("install.sh symlinks them") intends the deployed path to be
  a symlink. The launchd job (`com.threadwork.heartbeat-v2.plist`) already
  runs the repo daemon directly, so the placeholder was vestigial.
- Fix: replaced `/Users/coachstokes/bin/heartbeat-daemon-v2.sh` with a symlink
  to the repo daemon (placeholder backed up to `*.placeholder-bak`). This is
  environment bookkeeping — NOT a tracked repo file, does not appear in
  `git diff`, keeps `heartbeat-v2.test.sh` byte-stable. Without it AC#6's
  `5 pass / 0 fail` gate was unreachable for any daemon version.

### [2026-05-22] Daemon D1/D2 fix implemented — bin/heartbeat-daemon-v2.sh
Exact changes (line ranges are post-edit):
- **Env-var hardening (lines ~14-31, +require_env helper ~66-80, main() ~+1):**
  `TELEGRAM_TOKEN`/`SUPABASE_SERVICE_KEY` changed from `${VAR:?...}`
  source-time-fatal to `${VAR:-}` defaults. The `:?` form aborted
  `source heartbeat-daemon-v2.sh` in any test harness that does not export
  secrets — which broke the daemon's own `_SOURCED` test guard. New
  `require_env()` re-enforces both secrets, called as the first line of
  `main()`, so the real run path is unchanged. Added named constant
  `TASK_PROGRESS_FRESH_SEC=900` alongside `LAST_SEEN_ALIVE_SEC`.
- **NEW helpers `task_progress_age_sec()` + `os_facts_alive()` (inserted
  before `classify_agent_v2`):** `os_facts_alive` OR-s exactly three signals
  — pid_alive (`kill -0`), seen_alive (`last_seen_at` < `LAST_SEEN_ALIVE_SEC`),
  task_progress_alive (`tasks.last_progress_at` < `TASK_PROGRESS_FRESH_SEC`,
  via `agent_sessions.current_task_id → tasks.id`, falling back to
  `tasks.last_heartbeat_at` when `last_progress_at` is NULL). Exports global
  `OS_FACTS_REASON` naming which signal fired. No child-PID branch (RM-1 B).
- **Step 2 query:** added `COALESCE(current_task_id,'')` to the
  `agent_sessions` SELECT + a new `current_task_id` local.
- **Defect D1 — deterministic-hung branch:** the `TOOL_IN_FLIGHT` /
  `SUBAGENT_RUNNING` past-threshold detection now sets `is_hung_declared`,
  then calls `os_facts_alive` BEFORE emitting STUCK. OS-alive → `ALIVE`,
  method `os-facts-hung-override`, reason quotes the suppressed hung state +
  `OS_FACTS_REASON`. OS-dead → `STUCK` via `deterministic-hung-tool` /
  `-subagent` (genuine hang preserved).
- **Defect D2 — stale-state branch refactored:** the old inline pid/seen
  checks are replaced by a single `os_facts_alive` call, so the
  last-task-progress signal applies here too and scenario 3 of
  `heartbeat-v2.test.sh` stays green via the SAME code path (method
  `os-facts`). LLM enriched prompt now also carries `OS_FACTS_REASON`.

New decision order in `classify_agent_v2`:
  1. tmux session missing            → CRASHED (unchanged)
  2. declared hung past threshold:
       os_facts_alive ? ALIVE(os-facts-hung-override) : STUCK(deterministic-hung-*)
  3. state fresh                     → trust declared (deterministic-fresh)
  4. state stale/absent:
       os_facts_alive ? ALIVE(os-facts) : LLM tier (llm-gemma / no-api-key)

### RED-then-GREEN evidence
- RED — `tests/heartbeat/heartbeat-v2-fallback.test.sh` against the
  pre-Sprint-2 daemon (`git show HEAD:bin/heartbeat-daemon-v2.sh`):
  **8 pass / 9 fail**. Scenarios 1, 2, 3a, 3b all fail with `got='STUCK'`,
  `method=deterministic-hung-tool` — proving the tests exercise the D1/D2 fix.
  (Scenarios 4, 5a, 5b pass against the old daemon too: 4 was already correct;
  5a/5b are handled by the pre-existing stale-OS-facts branch.)
- GREEN — same file against the Sprint-2 daemon: **17 pass / 0 fail**, exit 0.
- AC#6 regression gate — `tests/heartbeat/heartbeat-v2.test.sh`: **5 scenarios,
  16 assertions, 0 fail**, exit 0. (`5 pass / 0 fail` of scenarios.)
- `bash -n bin/heartbeat-daemon-v2.sh` → exit 0.
- `bash -n tests/heartbeat/heartbeat-v2-fallback.test.sh` → exit 0.
- `source bin/heartbeat-daemon-v2.sh` with NO env vars → exit 0, all
  functions defined (`_SOURCED` guard intact, daemon does not run `main`).

### Test scenario → AC mapping (heartbeat-v2-fallback.test.sh)
- Scenario 1  → AC#1 (stale hung-tool + live claude_pid → ALIVE)
- Scenario 2  → AC#2 (stale hung-tool + recent last_seen → ALIVE)
- Scenario 3a → AC#3 (stale hung-tool + fresh tasks.last_progress_at → ALIVE)
- Scenario 3b → AC#3 (last_progress_at NULL → last_heartbeat_at fallback)
- Scenario 4  → AC#4 (genuine hung, all OS signals dead → STUCK preserved)
- Scenario 5a → AC#5 (absent declaration + live PID → ALIVE, not CRASHED)
- Scenario 5b → AC#5 (absent declaration + recent last_seen → ALIVE)

### Files in this sprint's commit
- `bin/heartbeat-daemon-v2.sh` (modified — D1/D2 fix, +156/-26 lines)
- `tests/heartbeat/heartbeat-v2-fallback.test.sh` (new)
- `.harness/sprints/sprint-2/{proposed-contract.md,status.txt,implementation-log.md}`
Note: `heartbeat-daemon.sh` (v1) NOT touched. Pre-existing unrelated
working-tree changes (`briefings/steve.json`, `.harness/sprints/sprint-3/*`,
`roadmap.md`, etc.) are from other agents and are deliberately NOT staged —
the commit stages only the files listed above.

### KNOWN GAPS
- Child-PID OS signal descoped (RM-1 Option B) — see top of this log.
- The deployed-path symlink fix (above) is an out-of-repo environment change,
  not captured by git; if the environment is rebuilt, `install.sh` must
  recreate the symlink (or the test's `$DAEMON` constant should point at the
  repo path). Flagged for the cutover runbook owner.
