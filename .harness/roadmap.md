# V2 Heartbeat Cutover — Harness Roadmap

## IMPORTANT: This is NOT a web-app project
This harness builds threadwork INFRASTRUCTURE, not an app. There is no running
web app, no browser, no UI. Deliverables are (1) a documentation runbook and
(2) a bash daemon-script change. The Verifier evaluates by reading docs,
running shell/script tests, and inspecting code — NOT browser automation.
Rubric adaptation is in decision-log.md.

## Project
PROJECT_PATH: /Users/coachstokes/.claude/mcp-servers/task-board
Goal: migrate the threadwork heartbeat/watchdog from v1 (LLM pane-text
guessing — idle-park blind spot, escalation storms) to the already-built v2
"state-contracts" system (agents declare state; daemon reads + verifies vs OS
facts), then decommission v1. The real v2 daemon already exists at
`bin/heartbeat-daemon-v2.sh` (489 lines, ground-truth source). Epic: task #1266.
Phase A of the epic = Sprint 1 + an interleaved ops step + Sprint 2.

## Sprint 1 — V2 Cutover Runbook (task #1267)
Write a durable, executable cutover runbook to disk at
`docs/v2-heartbeat-cutover-runbook.md`. Reconstruct the design from:
- the real `bin/heartbeat-daemon-v2.sh` (primary, ground truth)
- task-board task bodies #826 (state-contracts spec), #842/#843 (soak bug),
  #829/#830 (harness build that produced v2) — via list_tasks if available
The runbook must cover ALL 5 cutover steps with exact commands, file paths,
verification checks, and rollback for each:
  Step 0: this runbook itself.
  Step 1: repoint launchd `com.threadwork.heartbeat-v2` from the empty stub
          `~/bin/heartbeat-daemon-v2.sh` (3-line placeholder) to the real
          `bin/heartbeat-daemon-v2.sh`; reload; verify it runs real code.
  Step 2b: daemon-side boot-recovery fallback (see Sprint 2).
  Step 3: 48h v1/v2 parallel soak; pass = v2 false-positive rate <= 50% of v1.
  Step 4: cutover flip (v1 off, v2 on), DB collapse, 14-day v1 decommission
          with rollback path.
Deliverable = the runbook file, committed to git.

## Interleaved ops (task #1268 — NOT a harness sprint)
Between Sprint 1 and Sprint 2, Boss executes Step 1 (repoint launchd) per the
runbook. The harness does NOT do this — Boss handles it directly.

## Sprint 2 — Daemon-side boot-recovery fallback (task #1269)
Implement the fallback described in task #843: Claude Code loads emit-state
hooks only at SessionStart, so already-running agents emit no state
declarations. The v2 daemon must NOT false-positive on missing/stale
declarations — it must fall back to OS facts (PID alive, child PID, last task
progress) when a declaration is stale or absent. Modify
`bin/heartbeat-daemon-v2.sh`. Deliverable = the code change + tests proving the
fallback works AND v1 behaviour is not regressed. Commit to git.

## Out of scope for the harness
Steps 3 and 4 (tasks #1270/#1271) are STAGED only — their runbook sections are
written in Sprint 1, but the 48h soak and the cutover flip are NOT executed by
this harness. After Sprint 2 the harness reports done; Boss hard-stops for
GweiSprayer's greenlight before Step 3.
