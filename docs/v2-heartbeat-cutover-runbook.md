# V2 Heartbeat Cutover Runbook

**Status:** Step 0 deliverable — harness Sprint 1 (epic #1266, task #1267).
**Audience:** any threadwork operator (Boss, Snoopy, or GweiSprayer-directed).
**Last updated:** 2026-05-22.
**Branch of record:** `feat/v2-cutover-runbook`.

---

## 0. Purpose & Overview

### Commands
This section is documentation only — no commands to run. Read it before doing
anything else.

### File paths
- This runbook: `~/.claude/mcp-servers/task-board/docs/v2-heartbeat-cutover-runbook.md`
- Real v2 daemon (cutover target): `~/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh` (489 lines)
- Stub currently wired into launchd: `~/bin/heartbeat-daemon-v2.sh` (3-line `threadwork-v1.0.0 placeholder`)
- v1 daemon (the system we are migrating off): `~/bin/heartbeat-daemon.sh`
- v2 launchd plist: `~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist`
- v1 launchd plist: `~/Library/LaunchAgents/com.threadwork.heartbeat.plist`
- v2 heartbeat DB: `~/bin/heartbeat-v2.db` (table `heartbeats_v2`)
- v1 heartbeat DB: `~/bin/heartbeat.db` (table `heartbeats`)
- v2 daemon log (written by the daemon itself): `~/bin/heartbeat-v2.log`
- v2 launchd stdout/stderr: `~/.threadwork/logs/heartbeat-v2.{out,err}.log`
- v1 daemon log: `~/bin/heartbeat.log`
- Task board DB (feature flag + `agent_sessions`): `~/.claude/mcp-servers/task-board/tasks.db`

### Why this cutover exists
The v1 heartbeat (`~/bin/heartbeat-daemon.sh`) classifies agent health by feeding
the last 50 lines of each tmux pane to an LLM (OpenRouter `google/gemma-3-12b-it`).
The system prompt collapses "actively working" and "waiting for input" into a
single `ALIVE` label, so the daemon **cannot distinguish a healthy idle agent
from an agent parked at a UI picker** — the idle-UI-park blind spot. This drives
both false-positive STUCK alerts and escalation storms.

V2 (`heartbeat-daemon-v2.sh`) replaces guessing with **state contracts**: agents
*declare* their state (`ACTIVE_THINKING`, `TOOL_IN_FLIGHT`, `SUBAGENT_RUNNING`,
`WAITING_HUMAN`, `COMPLETED`, `IDLE_BOOT`, `DEAD`) into `tasks.db.agent_sessions`
via `emit-state.sh` hooks + MCP tool calls. The daemon **reads** declarations,
verifies them against OS facts (PID alive, `last_seen_at` freshness), applies
deterministic STUCK thresholds, and only calls the LLM for genuinely ambiguous
leftovers. Design lineage: spec task #826, harness build tasks #829/#830.

### The 5 cutover steps
| Step | Title | Executed by | State |
|------|-------|-------------|-------|
| 0 | This runbook | harness Sprint 1 | **DONE** (this file) |
| 1 | Repoint launchd v2 stub → real daemon | Boss, interleaved ops task #1268 | Operator-executable now |
| 2 | Daemon-side boot-recovery fallback | harness Sprint 2, task #1269 | Code change — see §2 |
| 3 | 48h v1/v2 parallel soak | Boss, after GweiSprayer greenlight | **STAGED** — documented, not run by harness |
| 4 | Cutover flip + v1 decommission | Boss, after GweiSprayer greenlight | **STAGED** — documented, not run by harness |

**STAGED** means: the section below is a complete, executable plan, but the
harness does **not** run it. Steps 3 and 4 wait for an explicit GweiSprayer
greenlight. Do not run the soak or the flip from this runbook unprompted.

### Two known gaps in the current v2 launchd setup
Before Step 1 makes v2 run real code, two defects in the existing
`com.threadwork.heartbeat-v2.plist` must be fixed in the same edit. They are
harmless today only because the plist points at a no-op stub.

- **Gap G1 — launch-model mismatch.** The plist declares `StartInterval` `300`
  and `RunAtLoad`, i.e. launchd is told to *re-spawn the program every 300s*.
  But the real `heartbeat-daemon-v2.sh` is a **long-running process** with its
  own internal `while true; … sleep "$CHECK_INTERVAL"` loop (`CHECK_INTERVAL=300`,
  see `heartbeat-daemon-v2.sh` lines 22 and 447–468). If launchd also re-spawns
  it every 300s you get overlapping daemon processes, each running their own
  loop — duplicate ticks, duplicate Telegram alerts, DB write contention. G1 is
  remediated in Step 1.
- **Gap G2 — missing required env vars.** The real daemon reads
  `TELEGRAM_TOKEN` and `SUPABASE_SERVICE_KEY` with bash `:?` parameter
  expansion (`heartbeat-daemon-v2.sh` lines 18 and 31:
  `TELEGRAM_TOKEN="${TELEGRAM_TOKEN:?TELEGRAM_TOKEN env var required}"`). If
  either variable is unset the daemon **exits immediately on startup** with a
  non-zero status. The current v2 plist's `EnvironmentVariables` dict sets only
  `HOME`, `PATH`, and `THREADWORK_VERSION` — neither secret. G2 is remediated in
  Step 1.

### Soak bug cross-reference (#842 / #843)
During the original v2 soak, the first post-launch tick classified `claude-boss`
as STUCK because its `agent_sessions` row showed `declared=TOOL_IN_FLIGHT
age=999999s` — a stale, never-updated declaration. Tasks **#842** and **#843**
diagnosed the root cause: Claude Code loads the `emit-state.sh` hooks from
`settings.json` only at **SessionStart**. Agent sessions that were already
running when the hooks were installed never wired `emit-state.sh` into
`PreToolUse`, so they emit no fresh state declarations — every declaration goes
stale and the daemon risks a false STUCK.

This runbook carries two mitigations for that bug:
- **Short-term (fix (a), this runbook):** before the soak, `/clear` or restart
  every agent session so the hooks load. Documented in §3.
- **Long-term (fix (b), Sprint 2 / Step 2b):** make the daemon fall back to OS
  facts instead of false-positiving on stale/absent declarations. Forward-
  referenced in §2; implemented by harness Sprint 2 (task #1269).

### Verification
Confirm this runbook is present, complete, and that the ground-truth artifacts
it relies on exist before starting Step 1:
```bash
# This runbook is on disk:
test -f ~/.claude/mcp-servers/task-board/docs/v2-heartbeat-cutover-runbook.md \
  && echo "runbook present" || echo "runbook MISSING"

# All 5 step sections are present:
grep -nE '^## [0-4]\.' ~/.claude/mcp-servers/task-board/docs/v2-heartbeat-cutover-runbook.md
#    Expect 5 lines: Step 0 through Step 4.

# The two daemons the runbook acts on both exist:
test -x /Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh \
  && echo "real v2 daemon OK"
test -x /Users/coachstokes/bin/heartbeat-daemon.sh && echo "v1 daemon OK"
```

### Rollback
Step 0 produces only this document — there is no system state to roll back. To
revert the runbook itself, use git (it is committed on branch
`feat/v2-cutover-runbook`):
```bash
cd ~/.claude/mcp-servers/task-board
git log --oneline -- docs/v2-heartbeat-cutover-runbook.md   # find the commit SHA
COMMIT_SHA="REPLACE_WITH_RUNBOOK_COMMIT_SHA"
git revert "$COMMIT_SHA"   # or: git checkout <prev-sha> -- docs/v2-heartbeat-cutover-runbook.md
```
No operator action taken from Step 0 alone changes the live heartbeat system, so
reverting this file is consequence-free.

---

## 1. Repoint launchd v2 from the stub to the real daemon

**Executed by:** Boss, via interleaved ops task **#1268** (not by the harness).
**Goal:** make `com.threadwork.heartbeat-v2` actually run the 489-line daemon,
with a correct launch model (G1) and the required secrets (G2).

### File paths
- Edit target: `~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist`
- New `ProgramArguments` value:
  `/Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh`
- Old (wrong) `ProgramArguments` value — the stub:
  `/Users/coachstokes/bin/heartbeat-daemon-v2.sh`
- Backup written to: `~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist.bak-pre-step1`

### Current (broken) state — confirm before editing
The plist today points at the stub and runs it as a periodic job:
```bash
# Confirm the plist points at the STUB (expect the ~/bin path):
/usr/libexec/PlistBuddy -c "Print :ProgramArguments" \
  ~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist

# Confirm ~/bin/heartbeat-daemon-v2.sh is the 3-line placeholder:
wc -l ~/bin/heartbeat-daemon-v2.sh        # expect 3
head -1 ~/bin/heartbeat-daemon-v2.sh      # expect: # threadwork-v1.0.0 placeholder

# Confirm the REAL daemon exists and is executable:
test -x /Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh \
  && echo "real daemon OK" || echo "real daemon MISSING"
wc -l /Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh   # expect 489
```

### Commands

**1a. Back up the current plist.**
```bash
cp ~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist \
   ~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist.bak-pre-step1
```

**1b. Stop the running job before editing** (it currently runs the harmless
stub; stopping it cleanly avoids a stale job lingering against the old plist).
Modern form first; legacy fallback noted.
```bash
# Modern (Darwin 25.5.0 — preferred):
launchctl bootout gui/$(id -u)/com.threadwork.heartbeat-v2 2>/dev/null || true

# Legacy fallback if bootout is unavailable on an older OS:
# launchctl unload ~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist 2>/dev/null || true
```

**1c. Repoint `ProgramArguments` at the real daemon (fixes the core defect).**
The real daemon has a `#!/usr/bin/env bash` shebang and is `chmod +x`, so it can
be invoked directly as a single-element `ProgramArguments` array.
```bash
PLIST=~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist
REAL=/Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh

# Replace the single ProgramArguments entry (index 0) with the real daemon path:
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $REAL" "$PLIST"
```

**1d. Fix Gap G1 — switch from periodic re-spawn to long-running + keep-alive.**
The real daemon loops internally, so `StartInterval` must be removed and
replaced with `KeepAlive` (relaunch only if the long-running process dies).
This matches how the v1 plist runs `heartbeat-daemon.sh` (`KeepAlive` true, no
`StartInterval`).
```bash
PLIST=~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist

# Remove the periodic-respawn key (ignore error if already absent):
/usr/libexec/PlistBuddy -c "Delete :StartInterval" "$PLIST" 2>/dev/null || true

# Add KeepAlive so launchd relaunches the daemon only if it exits:
/usr/libexec/PlistBuddy -c "Delete :KeepAlive" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$PLIST"
```

**1e. Fix Gap G2 — inject the required secrets.**
The daemon hard-fails without `TELEGRAM_TOKEN` and `SUPABASE_SERVICE_KEY`. Add
them to the plist's `EnvironmentVariables` dict. Pull the live values from the
v1 daemon's environment (v1 already uses the same `TELEGRAM_TOKEN`) or from the
operator's secret store — **do not commit secret values to git**.

*Primary path — add directly to the plist `EnvironmentVariables` dict:*
```bash
PLIST=~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist

# Provide the real secret values in the current shell first, e.g.:
#   export TELEGRAM_TOKEN='...'        # same token v1 uses
#   export SUPABASE_SERVICE_KEY='...'  # Supabase service role key
# (Source them from your secret store; never paste them into a committed file.)

/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TELEGRAM_TOKEN string $TELEGRAM_TOKEN" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:SUPABASE_SERVICE_KEY string $SUPABASE_SERVICE_KEY" "$PLIST"
```

*Alternative path — secrets file (operator's choice).* Instead of embedding the
secrets in the plist, wrap the daemon so it sources them at launch. Change
`ProgramArguments` to `["/bin/bash","-lc","set -a; . ~/.threadwork/secrets.env; exec /Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh"]`
where `~/.threadwork/secrets.env` (mode `600`, git-ignored) exports both vars.
This keeps secrets out of the LaunchAgents directory; pick whichever your
secret-management policy prefers.

> Note: `SUPABASE_SERVICE_KEY` is only strictly required if `OPENROUTER_API_KEY`
> is not otherwise provided — the daemon uses the Supabase key to fetch the
> OpenRouter key for the LLM fallback (`load_api_key`, `heartbeat-daemon-v2.sh`
> lines 66–90). `TELEGRAM_TOKEN` is unconditionally required. Set both for a
> clean boot; the daemon degrades gracefully (no LLM fallback) only if the
> OpenRouter path is unavailable, not if `TELEGRAM_TOKEN` is missing.

**1f. Validate the edited plist, then reload it.**
```bash
PLIST=~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist

# Syntax check — must print "OK":
plutil -lint "$PLIST"

# Load the corrected job (modern form):
launchctl bootstrap gui/$(id -u) "$PLIST"

# Legacy fallback for older OS:
# launchctl load "$PLIST"
```

### Verification
```bash
# 1. The job is loaded and shows a live PID (not "-"):
launchctl list | grep com.threadwork.heartbeat-v2
#    Expect a numeric PID in column 1 within a few seconds of bootstrap.

# 2. The loaded job points at the REAL daemon, not the stub:
launchctl print gui/$(id -u)/com.threadwork.heartbeat-v2 2>/dev/null \
  | grep -i 'program\|arguments'
#    Expect the .../task-board/bin/heartbeat-daemon-v2.sh path.

# 3. The daemon is actually running real code — its own log shows the
#    real-daemon banner (the stub writes nothing):
tail -n 20 ~/bin/heartbeat-v2.log
#    Expect lines like "heartbeat-daemon-v2 starting" and
#    "Agents: boss steve sadie kiera" — these are emitted only by the
#    real daemon (heartbeat-daemon-v2.sh lines 422-426).

# 4. No env-var crash — the launchd stderr log is clean:
cat ~/.threadwork/logs/heartbeat-v2.err.log
#    Expect EMPTY. A line containing "TELEGRAM_TOKEN env var required" or
#    "SUPABASE_SERVICE_KEY env var required" means G2 was not fixed — re-do 1e.

# 5. Exactly ONE daemon process is running (confirms G1 fix — no double-loop):
pgrep -fl heartbeat-daemon-v2.sh
#    Expect exactly ONE matching process. Two or more = StartInterval was not
#    removed; re-check 1d.

# 6. The daemon is writing fresh heartbeat rows to its DB:
sqlite3 ~/bin/heartbeat-v2.db \
  "SELECT timestamp, agent, external_status, classification_method
   FROM heartbeats_v2 ORDER BY id DESC LIMIT 8;"
#    Expect rows with a timestamp from the last ~5 minutes.
```

### Rollback
If verification fails or v2 misbehaves, restore the pre-Step-1 state. The stub
is a harmless no-op, so reverting fully neutralises v2 without touching v1.
```bash
PLIST=~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist

# 1. Stop the (possibly misbehaving) v2 job:
launchctl bootout gui/$(id -u)/com.threadwork.heartbeat-v2 2>/dev/null || true

# 2. Restore the original plist from the backup taken in 1a:
cp ~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist.bak-pre-step1 "$PLIST"

# 3. (Optional) reload the restored stub-pointing plist, or leave it unloaded:
launchctl bootstrap gui/$(id -u) "$PLIST"

# 4. Confirm rollback — job points at the stub again, no real-daemon process:
/usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PLIST"   # expect ~/bin path
pgrep -fl heartbeat-daemon-v2.sh || echo "no v2 daemon running — rolled back"
```
v1 (`com.threadwork.heartbeat`) is never touched by Step 1, so it keeps running
throughout — there is no monitoring gap during a Step 1 rollback.

---

## 2. Daemon-side boot-recovery fallback

**Executed by:** harness **Sprint 2** (task #1269) — a code change to
`bin/heartbeat-daemon-v2.sh`. This section stages the requirement; the code
lands in Sprint 2.

### File paths
- Code change target: `~/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh`
- Source of the requirement: task **#843** (root-cause analysis), task #842.

### Commands
No operator commands for this step — it is implemented and tested inside the
harness Sprint 2. After Sprint 2 merges, the corrected daemon is what Step 1's
`ProgramArguments` already points at (same path), so no re-pointing is needed;
a reload picks up the new code:
```bash
launchctl bootout  gui/$(id -u)/com.threadwork.heartbeat-v2 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist
```

### The problem (fix (b) for the #842/#843 soak bug)
Per §0's soak-bug cross-reference: Claude Code loads `emit-state.sh` hooks only
at SessionStart. An agent session running before the hooks were installed emits
no fresh declarations, so its `agent_sessions` row goes stale. Today the v2
daemon's deterministic-hung check (`heartbeat-daemon-v2.sh` lines 343–350) can
fire a **false STUCK** on a stale `TOOL_IN_FLIGHT`/`SUBAGENT_RUNNING` row even
though the agent is healthy.

### Required fallback behaviour (Sprint 2 acceptance)
When a declaration is **stale or absent**, the daemon must classify from OS
facts instead of false-positiving:
- PID alive (`kill -0` on `claude_pid`),
- child/sub-agent PID alive,
- recent task progress (`last_seen_at` / last task update).

Only when OS facts are *also* ambiguous may it fall back to the LLM. The Sprint
2 change must also prove **v1 behaviour is not regressed** (the daemon files are
separate, but the shared `tasks.db.agent_sessions` table must not be written in
a way that breaks v1's reads).

### Verification
Verification commands are defined by the Sprint 2 contract (unit/integration
tests over the fallback path). At the runbook level, the post-Sprint-2 smoke
check is: a stale `TOOL_IN_FLIGHT` row for a *live* PID must classify `ALIVE`
via an `os-facts`-style method, not STUCK:
```bash
sqlite3 ~/bin/heartbeat-v2.db \
  "SELECT agent, declared_state, state_age_sec, external_status, classification_method
   FROM heartbeats_v2 ORDER BY id DESC LIMIT 12;"
#    Expect: rows with a large state_age_sec but a live agent show
#    external_status='ALIVE' with an OS-facts-based method — NOT 'STUCK'.
```

### Rollback
Sprint 2 is a git-tracked code change to a single file. Rollback = revert the
Sprint 2 commit(s) and reload:
```bash
cd ~/.claude/mcp-servers/task-board
git log --oneline -- bin/heartbeat-daemon-v2.sh        # find the Sprint 2 commit SHA
SPRINT2_SHA="REPLACE_WITH_SPRINT2_COMMIT_SHA"
git revert "$SPRINT2_SHA"   # or: git checkout <prev-sha> -- bin/heartbeat-daemon-v2.sh
launchctl bootout  gui/$(id -u)/com.threadwork.heartbeat-v2 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist
```

---

## 3. 48-hour v1/v2 parallel soak  — **STAGED (do not run without GweiSprayer greenlight)**

**Executed by:** Boss, only after an explicit GweiSprayer greenlight. The
harness does **not** run the soak.
**Goal:** prove v2 is at least twice as accurate as v1 before flipping.

### Pass criterion
**v2 passes the soak iff its false-positive rate over the 48h window is
≤ 50% of v1's false-positive rate** over the same window. A "false positive" is
a STUCK (or CRASHED) classification for an agent that was in fact healthy
(verified against task progress / pane state at that timestamp).

### File paths
- v1 data: `~/bin/heartbeat.db` (table `heartbeats`), `~/bin/heartbeat.log`
- v2 data: `~/bin/heartbeat-v2.db` (table `heartbeats_v2`), `~/bin/heartbeat-v2.log`
- Soak window record (operator-created): `~/.threadwork/soak/v2-soak-window.txt`

### Commands

**3a. Pre-soak — eliminate the #842/#843 stale-declaration artefact (fix (a)).**
Existing agent sessions must `/clear` or restart so `emit-state.sh` loads and
they emit fresh declarations. Otherwise the soak data is polluted by false
STUCKs that are a session-boundary artefact, not a real v2 defect.
```bash
# Confirm the emit-state hooks are registered in settings.json:
grep -n 'emit-state' ~/.claude/settings.json
#    Expect PreToolUse / PostToolUse / SessionStart / Stop entries.

# For each running agent, inject /clear so the new session loads the hooks
# (Snoopy's recycle pipeline does this routinely):
for a in boss steve sadie kiera; do
  /Users/coachstokes/.local/bin/tmux send-keys -t "claude-$a" '/clear' Enter
done

# Verify each agent now emits a FRESH declaration (small state_age, src=hook/mcp):
sqlite3 ~/.claude/mcp-servers/task-board/tasks.db \
  "SELECT agent, state, state_source, state_changed_at FROM agent_sessions;"
```

**3b. Record the soak start time.**
```bash
mkdir -p ~/.threadwork/soak
date -u '+%Y-%m-%dT%H:%M:%SZ' | tee ~/.threadwork/soak/v2-soak-window.txt
#    Soak ends 48h after this timestamp.
```

**3c. Run both daemons in parallel for 48h.** After Step 1, v2 is already
running and `heartbeat_v2_enabled=1`. v1 (`com.threadwork.heartbeat`) is still
running. No further action — let both collect data for 48h.
```bash
# Confirm BOTH jobs are alive at soak start:
launchctl list | grep -E 'com.threadwork.heartbeat(\b|-v2)'
#    Expect both com.threadwork.heartbeat and com.threadwork.heartbeat-v2
#    with live PIDs.
```

### Verification — compute the false-positive rates at T+48h
```bash
SOAK_START=$(cat ~/.threadwork/soak/v2-soak-window.txt)

# v1 STUCK/CRASHED count in the window:
sqlite3 ~/bin/heartbeat.db \
  "SELECT COUNT(*) FROM heartbeats
   WHERE status IN ('STUCK','CRASHED') AND timestamp >= '$SOAK_START';"

# v1 total classifications in the window (denominator):
sqlite3 ~/bin/heartbeat.db \
  "SELECT COUNT(*) FROM heartbeats WHERE timestamp >= '$SOAK_START';"

# v2 STUCK/CRASHED count in the window:
sqlite3 ~/bin/heartbeat-v2.db \
  "SELECT COUNT(*) FROM heartbeats_v2
   WHERE external_status IN ('STUCK','CRASHED') AND timestamp >= '$SOAK_START';"

# v2 total classifications in the window (denominator):
sqlite3 ~/bin/heartbeat-v2.db \
  "SELECT COUNT(*) FROM heartbeats_v2 WHERE timestamp >= '$SOAK_START';"

# v2 STUCK/CRASHED rows WITH detail, for manual true/false-positive triage:
sqlite3 -header -column ~/bin/heartbeat-v2.db \
  "SELECT timestamp, agent, external_status, classification_method, reason
   FROM heartbeats_v2
   WHERE external_status IN ('STUCK','CRASHED') AND timestamp >= '$SOAK_START'
   ORDER BY timestamp;"
```
For each STUCK/CRASHED row, mark it true- or false-positive by cross-checking
the agent's task progress and pane state at that timestamp. The **false-positive
rate** = false positives ÷ total classifications, computed per daemon.

**PASS gate:** `v2_fp_rate <= 0.5 * v1_fp_rate`. If v2 fails, do **not** proceed
to Step 4 — return to Step 2 analysis or escalate to GweiSprayer.

### Rollback
The soak is observation-only — both daemons already run; nothing is mutated. To
abort the soak early:
```bash
# Stop v2 (v1 keeps monitoring — no coverage gap):
launchctl bootout gui/$(id -u)/com.threadwork.heartbeat-v2 2>/dev/null || true

# Optionally disable the v2 feature flag so a reload won't resume monitoring:
sqlite3 ~/.claude/mcp-servers/task-board/tasks.db \
  "UPDATE feature_flags SET enabled=0 WHERE flag_name='heartbeat_v2_enabled';"

# Discard the soak window marker:
rm -f ~/.threadwork/soak/v2-soak-window.txt
```
Aborting the soak leaves v1 fully in charge — the system is never unmonitored.

---

## 4. Cutover flip + 14-day v1 decommission  — **STAGED (do not run without GweiSprayer greenlight)**

**Executed by:** Boss, only after Step 3 PASSES *and* GweiSprayer greenlights
the flip. The harness does **not** run the flip.
**Goal:** make v2 the sole heartbeat, collapse its data into the canonical path,
and decommission v1 on a 14-day timer with a rollback path intact the whole time.

### File paths
- v1 plist (disabled, **retained 14 days**): `~/Library/LaunchAgents/com.threadwork.heartbeat.plist`
- v1 plist archive after day 14: `~/.threadwork/decommissioned/com.threadwork.heartbeat.plist`
- v2 plist (now primary): `~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist`
- Canonical heartbeat DB: `~/bin/heartbeat.db` (v1's path — v2 data is collapsed here)
- v2 DB snapshot before collapse: `~/bin/heartbeat-v2.db.bak-pre-collapse`
- v1 DB snapshot before collapse: `~/bin/heartbeat.db.bak-pre-collapse`
- Decommission deadline marker: `~/.threadwork/decommissioned/v1-decommission-deadline.txt`

### Commands

**4a. Snapshot both DBs before any collapse.**
```bash
cp ~/bin/heartbeat-v2.db ~/bin/heartbeat-v2.db.bak-pre-collapse
cp ~/bin/heartbeat.db    ~/bin/heartbeat.db.bak-pre-collapse
```

**4b. Flip — turn v1 off, leave v2 on.**
```bash
# Stop the v1 daemon (do NOT delete the plist yet — 14-day rollback window):
launchctl bootout gui/$(id -u)/com.threadwork.heartbeat 2>/dev/null || true

# Confirm v2 is still the only heartbeat running:
launchctl list | grep -E 'com.threadwork.heartbeat(\b|-v2)'
#    Expect: com.threadwork.heartbeat-v2 with a live PID; com.threadwork.heartbeat
#    absent or with no PID.
pgrep -fl heartbeat-daemon-v2.sh   # expect exactly one
pgrep -fl heartbeat-daemon.sh      # expect nothing
```

**4c. Collapse the v2 DB into the canonical v1 path.** v1's `heartbeats` table
and v2's `heartbeats_v2` table have different schemas, so the collapse copies
v2 rows into a v2-named table inside the canonical DB file (preserving full v2
detail) rather than forcing a lossy column mapping.
```bash
# Attach the v2 DB and copy its table into the canonical heartbeat.db:
sqlite3 ~/bin/heartbeat.db <<'SQL'
ATTACH DATABASE '/Users/coachstokes/bin/heartbeat-v2.db' AS v2;
CREATE TABLE IF NOT EXISTS heartbeats_v2 AS SELECT * FROM v2.heartbeats_v2 WHERE 0;
INSERT INTO heartbeats_v2 SELECT * FROM v2.heartbeats_v2;
DETACH DATABASE v2;
SQL

# Verify the row counts match:
echo "v2 source rows:"; sqlite3 ~/bin/heartbeat-v2.db "SELECT COUNT(*) FROM heartbeats_v2;"
echo "collapsed rows:"; sqlite3 ~/bin/heartbeat.db    "SELECT COUNT(*) FROM heartbeats_v2;"
```
> If a future v2 daemon revision is updated to write directly to
> `~/bin/heartbeat.db`, repoint `HEARTBEAT_DB_PATH` in `heartbeat-daemon-v2.sh`
> accordingly and reload. As shipped, the daemon writes to `~/bin/heartbeat-v2.db`
> (`heartbeat-daemon-v2.sh` line 16); the collapse above keeps the canonical
> file complete without requiring that code change during the flip.

**4d. Start the 14-day v1 decommission timer.**
```bash
mkdir -p ~/.threadwork/decommissioned
python3 -c "import datetime; \
print((datetime.datetime.utcnow()+datetime.timedelta(days=14)).strftime('%Y-%m-%dT%H:%M:%SZ'))" \
  | tee ~/.threadwork/decommissioned/v1-decommission-deadline.txt
#    Until this date, the v1 plist stays on disk (disabled) for instant rollback.
```

**4e. Day 14 — final v1 decommission (only if v2 has been stable for 14 days).**
```bash
# Archive (do not destroy) the v1 plist:
mv ~/Library/LaunchAgents/com.threadwork.heartbeat.plist \
   ~/.threadwork/decommissioned/com.threadwork.heartbeat.plist

# v1 daemon script and DB may also be archived once confident:
#   mv ~/bin/heartbeat-daemon.sh ~/.threadwork/decommissioned/
#   mv ~/bin/heartbeat.db        ~/.threadwork/decommissioned/
```

### Verification
```bash
# 1. v2 is the sole live heartbeat:
launchctl list | grep -i heartbeat
#    Expect com.threadwork.heartbeat-v2 with a PID; no live com.threadwork.heartbeat.

# 2. v2 is still classifying after the flip:
sqlite3 ~/bin/heartbeat-v2.db \
  "SELECT timestamp, agent, external_status FROM heartbeats_v2 ORDER BY id DESC LIMIT 8;"
#    Expect rows from the last ~5 minutes.

# 3. The collapse is complete — counts match (see 4c output).

# 4. The decommission deadline is recorded:
cat ~/.threadwork/decommissioned/v1-decommission-deadline.txt

# 5. (Day 14) the v1 plist is archived, not present in LaunchAgents:
test -e ~/Library/LaunchAgents/com.threadwork.heartbeat.plist \
  && echo "v1 plist STILL PRESENT" || echo "v1 plist archived — decommission complete"
```

### Rollback
The flip is reversible for the entire 14-day window because the v1 plist is
retained on disk.
```bash
# 1. Re-enable v1:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.threadwork.heartbeat.plist

# 2. Stop v2 and disable its feature flag so it stays down:
launchctl bootout gui/$(id -u)/com.threadwork.heartbeat-v2 2>/dev/null || true
sqlite3 ~/.claude/mcp-servers/task-board/tasks.db \
  "UPDATE feature_flags SET enabled=0 WHERE flag_name='heartbeat_v2_enabled';"

# 3. If the DB collapse needs reverting, restore the pre-collapse snapshots:
cp ~/bin/heartbeat.db.bak-pre-collapse    ~/bin/heartbeat.db
cp ~/bin/heartbeat-v2.db.bak-pre-collapse ~/bin/heartbeat-v2.db

# 4. Confirm v1 is back in charge:
launchctl list | grep com.threadwork.heartbeat
pgrep -fl heartbeat-daemon.sh   # expect one v1 process
```
**After day 14**, once the v1 plist has been archived (4e), full rollback
requires moving the plist back from `~/.threadwork/decommissioned/` before the
`launchctl bootstrap` above — at which point the cutover is considered
permanent and any reversion should be treated as a fresh decision.

---

## Appendix — quick reference

| Artifact | Path |
|----------|------|
| Real v2 daemon | `~/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh` |
| v2 stub (replace in Step 1) | `~/bin/heartbeat-daemon-v2.sh` |
| v1 daemon | `~/bin/heartbeat-daemon.sh` |
| v2 launchd plist | `~/Library/LaunchAgents/com.threadwork.heartbeat-v2.plist` |
| v1 launchd plist | `~/Library/LaunchAgents/com.threadwork.heartbeat.plist` |
| v2 DB / log | `~/bin/heartbeat-v2.db` / `~/bin/heartbeat-v2.log` |
| v1 DB / log | `~/bin/heartbeat.db` / `~/bin/heartbeat.log` |
| Feature flag DB | `~/.claude/mcp-servers/task-board/tasks.db` (`feature_flags.heartbeat_v2_enabled`) |

**launchctl cheat-sheet (Darwin 25):** modern `bootout gui/$(id -u)/<label>` /
`bootstrap gui/$(id -u) <plist>`; legacy fallback `unload <plist>` /
`load <plist>`. `launchctl print gui/$(id -u)/<label>` shows the loaded job's
resolved `ProgramArguments`.
