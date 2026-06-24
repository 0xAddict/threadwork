# Generator-Verifier Pattern

Two-agent harness for long-running build work. Generator (Opus) writes code sprint-by-sprint; Verifier (Sonnet) independently grades against a contract. File-based handoff means agents survive context resets.

## Roles

| Agent | Model | Responsibility |
|-------|-------|----------------|
| Generator | opus | Proposes contracts, implements features, writes implementation logs |
| Verifier | sonnet | Reads contract + implementation, runs tests, writes scored evaluation report |
| Monitor (the harness loop) | — | Polls status, unsticks idle agents, advances pipeline state |

## Pipeline States

`status.txt` is the single source of truth for sprint state. Valid values:

- `negotiating` — Generator wrote `proposed-contract.md`, awaiting boss approval
- `approved` — boss wrote `approved-contract.md`, Generator may begin
- `implementing` — Generator is writing code; logs to `implementation-log.md`
- `ready_for_evaluation` — Generator finished; Verifier may grade
- `evaluating` — Verifier is running tests; will write `verifier-report.md`
- `passed` — sprint cleared all thresholds; advance to next
- `failed` — sprint missed thresholds; check pivot rule

## Spawn Commands

```
Agent(
  name: "generator",
  model: opus,
  prompt: <read ~/.claude/agents/harness/generator.md, inject PROJECT_PATH and roadmap>,
  run_in_background: true
)

Agent(
  name: "verifier",
  model: sonnet,
  prompt: <read ~/.claude/agents/harness/verifier.md, inject PROJECT_PATH>,
  run_in_background: true
)
```

## File Layout

```
{project}/
  .harness/
    roadmap.md
    decision-log.md
    sprints/
      sprint-1/
        proposed-contract.md   # Generator
        approved-contract.md   # boss (or auto-approve mode)
        implementation-log.md  # Generator
        verifier-report.md     # Verifier
        status.txt             # state machine
        evidence/              # screenshots, logs, test output
```

## Monitor Loop

`/loop 1m` ticks check:

1. Read `status.txt`; determine current state
2. Read `implementation-log.md` mtime; if `implementing` and stale ≥ 10 min → nudge Generator
3. If `negotiating` and stale ≥ 5 min → check for deadlock; surface to boss
4. If `ready_for_evaluation` and no `verifier-report.md` after 5 min → nudge Verifier
5. On `passed`: log decision, dispatch sprint N+1, or finalize if last sprint
6. On `failed`: increment consecutive-failure counter; if ≥ 2 → pivot

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Opus for Generator | Complex implementation requires strongest reasoning |
| Sonnet for Verifier | Fast evaluation passes, consistent grading |
| File-based handoff | No shared memory — agents survive context resets |
| Hard threshold (Func ≥ 9) | Functionality is non-negotiable |
| Few-shot calibration | Prevents Verifier from talking itself into approving |
| /loop 1m monitor | Auto-unsticks without user intervention |
| Sprint contracts | Prevents scope creep and misalignment |
