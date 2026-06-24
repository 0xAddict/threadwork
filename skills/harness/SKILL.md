---
name: harness
description: "Launch the Generator-Verifier harness for long-running app development. Spawns Opus Generator and Sonnet Verifier with sprint contracts, file-based handoff, and /loop 1m auto-unsticking monitor."
user_invocable: true
triggers:
  - "harness"
  - "generator verifier"
  - "long-running build"
  - "/harness"
---

# Harness — Generator + Verifier Pipeline

Launches a two-agent development harness based on Anthropic's engineering pattern for long-running applications. The Generator (Opus) builds features sprint-by-sprint while the Verifier (Sonnet) independently tests and grades the output with hard thresholds.

## Usage

```
/harness Build a task management app with drag-and-drop, real-time sync, and dark mode
/harness --sprints 5 Build a DAW with multi-track audio editing
/harness --project-path /path/to/project Continue building from existing codebase
```

## Arguments
- First argument: Natural language description of what to build (required)
- `--project-path PATH`: Project directory (default: current working directory)
- `--sprints N`: Target number of sprints (default: 3)
- `--app-url URL`: URL of running app for browser testing (Verifier will start the app if not provided)

## How It Works

### Step 1: Initialize Harness Directory

Create `.harness/` in the project root:
```bash
mkdir -p .harness/sprints
```

Write `.harness/roadmap.md` from the user's task description — break it into sprint-sized features.

Write `.harness/decision-log.md` with initial setup notes.

### Step 2: Spawn Generator Agent

```
Agent(
  name: "generator",
  model: opus,
  prompt: <read ~/.claude/agents/harness/generator.md, inject PROJECT_PATH and roadmap>,
  run_in_background: true
)
```

The Generator reads the roadmap, proposes its first sprint contract, and begins implementing.

### Step 3: Spawn Verifier Agent

```
Agent(
  name: "verifier",
  model: sonnet,
  prompt: <read ~/.claude/agents/harness/verifier.md, inject PROJECT_PATH>,
  run_in_background: true
)
```

The Verifier watches for contract proposals and `ready_for_evaluation` status, then tests and grades.

### Step 4: Start Monitor Loop

Start a `/loop 1m` monitoring loop that:

1. Reads `.harness/sprints/sprint-{current}/status.txt` to track pipeline state
2. Reads `implementation-log.md` for Generator activity
3. Reads `verifier-report.md` for evaluation results
4. Detects stuck states:
   - `implementing` with no log updates for 10+ minutes → nudge Generator
   - `negotiating` for 5+ minutes → check for deadlock
   - `ready_for_evaluation` with no report for 5+ minutes → nudge Verifier
5. On sprint completion (PASS), sends message to Generator to start next sprint
6. On sprint failure, checks consecutive failure count for pivot recommendation
7. On all sprints complete, reports final summary

### Monitor Loop Script

Each tick of the `/loop 1m` should:

```
1. Read status.txt → determine current state
2. Read implementation-log.md → check last update timestamp
3. If stuck detected:
   a. SendMessage(to="generator", ...) or SendMessage(to="verifier", ...)
   b. Include specific guidance about what seems stuck
4. If sprint passed:
   a. Log to decision-log.md
   b. If more sprints remain: SendMessage(to="generator", "Start sprint {N+1}")
   c. If all sprints done: Report completion
5. If pivot recommended:
   a. Log pivot to decision-log.md
   b. SendMessage(to="generator", "Pivot required — see verifier report")
```

### Step 5: Report Results

When all sprints pass (or max iterations reached), generate a summary:
- Sprints completed / attempted
- Features delivered
- Pivot count
- Final Verifier scores
- Git log of all sprint commits

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Opus for Generator | Complex implementation requires strongest reasoning |
| Sonnet for Verifier | Fast evaluation passes, consistent grading |
| File-based handoff | No shared memory — agents survive context resets |
| Hard threshold (Func >= 9) | Functionality is non-negotiable |
| Pivot at score < 72 x2 | Prevents polishing a flawed foundation |
| Few-shot calibration | Prevents Verifier from talking itself into approving |
| /loop 1m monitor | Auto-unsticks without user intervention |
| Sprint contracts | Prevents scope creep and misalignment |

## File Layout

```
{project}/
  .harness/
    roadmap.md
    decision-log.md
    sprints/
      sprint-1/
        proposed-contract.md
        approved-contract.md
        implementation-log.md
        verifier-report.md
        status.txt
        evidence/
      sprint-2/
        ...
```
