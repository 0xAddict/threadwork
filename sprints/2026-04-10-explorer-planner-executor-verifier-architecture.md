# Explorer -> Planner -> Executor -> Verifier Architecture

**Date:** 2026-04-10
**Task:** #264 (sadie)
**Author:** sadie-agent (Sonnet 4.6, 1M ctx)
**Status:** DRAFT — pending Opus + Codex review (Phase 4)

## 0. TL;DR

A four-stage, file-gated pipeline for long-running app development that upgrades
today's single Generator + single Verifier harness into a parallelized Generator-
Verifier mesh. Work flows:

1. **Explorers** (N parallel Haiku/Sonnet) map the work surface in read-only mode
2. **Planner** (1 Opus) turns explorer findings into a signed sprint contract
3. **Executors** (N parallel Sonnet 4.6) implement against the contract in lanes
4. **Verifiers** (N parallel Opus) grade each lane independently
5. **spec_gate.sh** is the physical hard gate between phases — exit code 0 passes,
   any non-zero blocks. It is NOT bypassable by agents; it is wired into the
   PreToolUse hook on `mcp__task-board__complete_task`.

The contract is a machine-readable JSON document so `spec_gate.sh` can validate it
with `jq`. Every phase transition requires a green gate run, and the gate log is
append-only evidence that the contract was honored.

## 1. Why the Current Harness Is Not Enough

From Phase 1 exploration:

| Current | Problem |
|---|---|
| 1 Generator (Opus) + 1 Verifier (Sonnet) | No parallelism — sprints serialize |
| Contracts are free-form markdown | Cannot be validated by a script |
| `spec-gate` skill is discipline-based | An agent can simply not run it |
| No explorer role | Planning happens without evidence about the codebase |
| Verifier is Sonnet, Generator is Opus | Weaker judge than builder = talked into approving |
| Gate lives inside the agent's context | Context resets can bypass it |

The user's ask inverts the model strengths (**executors Sonnet, verifiers Opus**) so
the judge is stronger than the builder, and puts the enforcement in shell (`spec_gate.sh`)
where no prompt can talk it out of blocking.

## 2. Roles

### 2.1 Explorer (Sonnet 4.6, read-only, 3-6 parallel)

- **Purpose:** produce a factual map of the work surface before any planning
- **Tools:** Read, Glob, Grep, Bash (read-only commands only — enforced by allowlist)
- **Forbidden:** Write, Edit, shell commands that mutate state
- **Output:** `explorer-{id}.md` in `.harness/sprints/sprint-N/exploration/`
- **Word cap:** 400 words per explorer (keeps planner context small)
- **Handoff:** writes `exploration/done.txt` when finished

Explorers run in parallel via the Task/Agent tool. Each gets a tightly scoped
prompt — one reads the frontend tree, another reads the API layer, a third reads
tests, a fourth reads recent git history. No explorer overlaps another's territory.

### 2.2 Planner (Opus, single instance)

- **Purpose:** consume all explorer outputs and emit the sprint contract
- **Input:** `exploration/*.md` + `roadmap.md` + `decision-log.md`
- **Output:** `contract.json` (machine-readable) + `contract.md` (human-readable)
- **Responsibilities:**
  1. Identify atomic work units that can run in parallel (no shared files)
  2. Assign each unit to a numbered **lane** (lane-1, lane-2, ...)
  3. Write acceptance criteria per lane (>=3 testable per lane)
  4. Write the test command for each criterion
  5. Sign the contract (hash) so the gate detects tampering

The planner is Opus because contract design is the load-bearing decision; a weak
planner produces unverifiable contracts.

### 2.3 Executor (Sonnet 4.6, N parallel — one per lane)

- **Purpose:** implement exactly one lane from the contract
- **Tools:** full write access scoped to that lane's `allowed_paths`
- **Scope enforcement:** `spec_gate.sh lane-scope` validates that changed files are
  inside the lane's `allowed_paths` glob — any file outside = hard fail
- **Output:** commits + `lane-{id}/implementation-log.md`
- **Handoff:** sets `lane-{id}/status.txt = ready_for_evaluation`

Sonnet 4.6 is used because executors are doing well-specified work. The intelligence
budget goes into the planner and verifiers, not the builders. This is the user's
insight: "smart plan, cheap build, smart check" beats "smart build, cheap check."

### 2.4 Verifier (Opus, N parallel — one per lane)

- **Purpose:** grade one lane against its contract acceptance criteria
- **Tools:** Read, Bash (test commands), Playwright/CDP, Grep
- **Forbidden:** Write, Edit (cannot touch executor code)
- **Output:** `lane-{id}/verifier-report.json` + `verifier-report.md`
- **Rubric:** unchanged from existing harness-verifier (Func >= 9, overall >= 78)
- **Why Opus:** the judge must be strictly stronger than the builder or it will be
  talked into approving. Inversion is intentional.

## 3. The Contract Format

The sprint contract is a single JSON document validated by `spec_gate.sh`. Markdown
prose lives in a parallel `contract.md` for human reading; the gate only trusts JSON.

```json
{
  "schema_version": "1.0",
  "sprint_id": "sprint-7",
  "created_at": "2026-04-10T17:30:00Z",
  "planner": "opus",
  "roadmap_ref": ".harness/roadmap.md#sprint-7",
  "lanes": [
    {
      "lane_id": "lane-1",
      "goal": "Add Postgres-backed session store to /api/auth",
      "executor_model": "sonnet-4.6",
      "verifier_model": "opus",
      "allowed_paths": [
        "api/auth/**",
        "db/migrations/**",
        "tests/auth/**"
      ],
      "forbidden_paths": [
        "api/billing/**",
        "frontend/**"
      ],
      "acceptance_criteria": [
        {
          "id": "AC-1",
          "statement": "POST /api/auth/login issues a session token",
          "test_command": "curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/api/auth/login -d '{\"u\":\"x\"}'",
          "expected": "200"
        },
        {
          "id": "AC-2",
          "statement": "Sessions persist across server restart",
          "test_command": "bash tests/auth/persist.sh",
          "expected": "PASS"
        },
        {
          "id": "AC-3",
          "statement": "No type errors",
          "test_command": "npx tsc --noEmit",
          "expected": "0"
        }
      ],
      "definition_of_done": "All 3 ACs pass AND no files outside allowed_paths changed AND verifier verdict = PASS",
      "max_retries": 3
    }
  ],
  "global_gates": [
    {
      "id": "G-1",
      "name": "lint",
      "command": "npx biome check .",
      "expected_exit_code": 0
    },
    {
      "id": "G-2",
      "name": "typecheck",
      "command": "npx tsc --noEmit",
      "expected_exit_code": 0
    }
  ],
  "signature": {
    "algo": "sha256",
    "hash": "<sha256 of canonical JSON without this field>",
    "signed_at": "2026-04-10T17:30:05Z"
  }
}
```

### Why JSON, not YAML or markdown
- `jq` is everywhere; `yq` and markdown parsers are not
- SHA-256 canonicalization is well-defined for JSON
- Every field is greppable by `spec_gate.sh` without a parser
- Tampering is detectable (hash mismatch)

## 4. spec_gate.sh — The Hard Gate

`/Users/coachstokes/threadwork/scripts/spec_gate.sh` is the single enforcement
point. It has four subcommands, each returning non-zero on failure:

| Subcommand | Purpose |
|---|---|
| `spec_gate.sh contract-sign <contract.json>` | Planner stage. Canonicalizes + hashes, writes signature back. |
| `spec_gate.sh contract-verify <contract.json>` | Executors + verifiers re-check the signature before acting. |
| `spec_gate.sh lane-scope <contract.json> <lane_id>` | After executor commits, diffs HEAD vs parent and rejects any file outside `allowed_paths`. |
| `spec_gate.sh lane-verify <contract.json> <lane_id> <report.json>` | Runs every AC test command and compares output to `expected`. Fails if any AC fails OR verifier JSON verdict != PASS. |
| `spec_gate.sh sprint-close <contract.json>` | Terminal gate. Runs every lane-verify + every global gate. Only exit 0 here clears `complete_task`. |

### Hook wiring (settings.json PreToolUse)

```json
{
  "matcher": "mcp__task-board__complete_task",
  "hooks": [{
    "type": "command",
    "command": "/Users/coachstokes/threadwork/scripts/spec_gate.sh sprint-close $CLAUDE_PROJECT_ROOT/.harness/sprints/$(cat $CLAUDE_PROJECT_ROOT/.harness/current-sprint)/contract.json || echo '{\"decision\":\"block\",\"reason\":\"spec_gate.sh sprint-close failed. See .harness/sprints/*/gate.log for details.\"}'"
  }]
}
```

When `spec_gate.sh sprint-close` exits non-zero, the hook emits the
`{"decision":"block","reason":"..."}` JSON that the harness recognizes as a
Ralph Loop stop-hook. The agent **cannot** call `complete_task` until the gate
passes. This is the non-bypassable property the user asked for.

### Append-only gate log

Every invocation appends to `.harness/sprints/sprint-N/gate.log` with:
- timestamp
- subcommand + args
- exit code
- full stdout/stderr

The log is the audit trail. Even if the agent lies in its status update, the
gate log tells the truth.

## 5. Handoff State Machine

```
EXPLORING -> PLANNING -> IMPLEMENTING -> VERIFYING -> GATING -> DONE
                           ^                                      |
                           |                                      |
                           +----- FAILED (retry up to max) <------+
```

File markers (single source of truth):

| From | To | Trigger file | Gate command |
|---|---|---|---|
| EXPLORING | PLANNING | `exploration/done.txt` exists for every explorer | none |
| PLANNING | IMPLEMENTING | `contract.json` exists with valid signature | `spec_gate.sh contract-verify` |
| IMPLEMENTING | VERIFYING | every `lane-*/status.txt == ready_for_evaluation` | `spec_gate.sh lane-scope` per lane |
| VERIFYING | GATING | every `lane-*/verifier-report.json` exists | `spec_gate.sh lane-verify` per lane |
| GATING | DONE | all lanes PASS + all global gates pass | `spec_gate.sh sprint-close` |

## 6. Gaps vs Current Threadwork

| Gap | Fix |
|---|---|
| No `spec_gate.sh` script | **Ship it** — see `/Users/coachstokes/threadwork/scripts/spec_gate.sh` |
| Harness contracts are markdown, not JSON | Dual-write — keep markdown for humans, emit JSON for gate |
| No explorer role defined | Add `~/.claude/agents/harness/explorer.md` (Sonnet, read-only) |
| No lane-scoped executor role | Add `~/.claude/agents/harness/executor.md` (Sonnet 4.6) |
| Verifier is Sonnet | Rewrite `harness/verifier.md` frontmatter to `model: opus` |
| Planner does not exist as a distinct role | Add `~/.claude/agents/harness/planner.md` (Opus) |
| Settings.json PreToolUse matcher is null | Add a matcher block for `mcp__task-board__complete_task` pointing at `spec_gate.sh sprint-close` |
| No parallelism primitive in `/harness` skill | Update skill to spawn N executors with `Agent(...)` in parallel, tracked via `spawn_subagent` |
| Lane overlap undetected | `spec_gate.sh contract-sign` rejects contracts where any two lanes share an `allowed_paths` glob |
| Verifier can be bribed by "I tried hard" prose | Verifier only reads `contract.json` + test output, never `implementation-log.md` |

## 7. Framework Diagram

See `/Users/coachstokes/threadwork/diagrams/architecture-2026-04-10.mmd` (Mermaid source)
and `/Users/coachstokes/threadwork/diagrams/architecture-2026-04-10.svg` (rendered).

High-level flow:

```
          +-------------------+
          |    Boss/User      |
          +---------+---------+
                    |
                    v
          +-------------------+
          |  /harness <goal>  |
          +---------+---------+
                    |
           spawn (parallel)
                    |
     +------+-------+-------+------+
     v      v       v       v      v
  [EXP1] [EXP2]  [EXP3]  [EXP4] [EXPn]     <- Sonnet, read-only
     |      |       |       |      |
     +------+---+---+-------+------+
                |
                v exploration/*.md
          +-----+------+
          |   PLANNER  |                    <- Opus
          +-----+------+
                |
                v contract.json + sign
          +-----+------+
          | spec_gate  |  contract-verify
          +-----+------+
                |
        split by lane
                |
     +------+---+---+---+------+
     v      v       v       v      v
  [EX1]  [EX2]   [EX3]   [EX4]  [EXn]      <- Sonnet 4.6, write-scoped
     |      |       |       |      |
  lane-scope gate (one per lane)
     |      |       |       |      |
     v      v       v       v      v
  [VER1] [VER2]  [VER3]  [VER4] [VERn]     <- Opus, read-only
     |      |       |       |      |
  lane-verify gate (one per lane)
     +------+---+---+-------+------+
                |
                v
          +-----+------+
          | sprint-close |  <- HARD GATE
          +-----+------+
                |
                v
            complete_task
```

## 8. Deliverables Produced by This Task

| File | Purpose |
|---|---|
| `/Users/coachstokes/threadwork/sprints/2026-04-10-explorer-planner-executor-verifier-architecture.md` | This document |
| `/Users/coachstokes/threadwork/scripts/spec_gate.sh` | The hard gate script |
| `/Users/coachstokes/threadwork/diagrams/architecture-2026-04-10.mmd` | Mermaid source |
| `/Users/coachstokes/threadwork/diagrams/architecture-2026-04-10.svg` | Rendered SVG |
| `/Users/coachstokes/threadwork/sprints/contract-schema-example.json` | Canonical contract example |

## 9. Open Questions for User

1. Should the planner also be allowed to **reject** a roadmap item ("this sprint is unsafe to parallelize, run serial")?
2. How many explorers should we cap at? I propose **4** — beyond that, context explodes.
3. Should the gate log be append-only to a separate file, or cryptographically chained (hash-linked)?
4. When a lane fails and retries, does the executor get a **fresh context** or does it keep its implementation-log? (I recommend fresh — carried context is how builders rationalize broken work.)
5. Do we want the verifier to also emit a **confidence score** so we can route low-confidence verdicts to a second verifier?

---

## Appendix A — Opus Review (Phase 4)

> **Provenance caveat — READ THIS FIRST.** The plan called for this review to
> come from the LLM Council skill (`/Users/coachstokes/bin/llm-council.py`),
> which routes to four frontier models (Grok 4.20, GPT-5.4-pro, Gemini 2.5 Pro,
> Llama 4 Maverick) with GPT-5.4-pro as chairman. **The council call failed at
> runtime:** the script could not fetch the OpenRouter API key from Supabase
> (`ERROR: No OpenRouter API key found. Provide --key, OPENROUTER_API_KEY env
> var, or ensure Supabase access.`). No network/Supabase auth path was
> available from this sub-agent session. This appendix is therefore a
> structured **self-critique by sadie-agent** (Sonnet 4.6, 1M ctx) playing the
> adversary role — explicitly labeled so the user weights it accordingly.
> **Action item:** re-run this review with a working Opus/Council call before
> adopting this pattern.

### A.1 Structural flaws

1. **The gate defends the wrong boundary.** `spec_gate.sh` only blocks
   `mcp__task-board__complete_task`. An executor can ship broken code, mutate
   the contract, edit `spec_gate.sh` itself (nothing mounts it read-only), forge
   `verifier-report.json`, rewrite `.harness/current-sprint`, or simply never
   call `complete_task`. The gate is a boundary check, not an enforcement of
   the invariant it claims to enforce.
2. **SHA-256 without a secret is not a signature.** Any agent can
   `jq -Sc 'del(.signature)' | sha256sum` and re-sign. It catches accidental
   drift, not adversarial tampering. A real signature needs either (a) an HMAC
   with a secret the executor cannot read, (b) a detached signature file owned
   by root, or (c) the signing op living in a privileged path outside the
   agent's reach.
3. **Glob-prefix overlap detection is not sound.** `globs_overlap()` compares
   literal prefixes of `allowed_paths`. False negatives on case-insensitive
   HFS+/APFS, symlinks, relative-path normalization (`./`, `../`), generated
   files, lockfiles, and any shared top-level config. False positives on
   `**`-leading globs. This is a heuristic advertised as a safety property.
4. **Concurrency ignores the filesystem.** Parallel executors in a single
   checkout race on `node_modules`, `dist/`, codegen outputs, `.env`, test DB
   fixtures, and lockfiles. Even when allowed_paths are disjoint, the *side
   effects* aren't. The design has no worktree isolation.
5. **Cross-lane regressions are invisible until sprint-close.** `lane-verify`
   runs each lane's ACs, but no step runs the *other* lanes' tests against
   your lane's diff. Two lanes can each pass their own ACs and break each
   other — first integration test is at the very end.

### A.2 Process flaws

6. **No retry budget honored by the gate.** `max_retries: 3` lives in the
   contract but `spec_gate.sh` never reads it. A failing lane can loop at the
   delegator layer forever.
7. **The verifier still writes its own verdict.** Making the verifier Opus and
   the executor Sonnet 4.6 reduces — does not eliminate — "I've tested it,
   it's fine." The gate re-runs ACs (good), but still trusts agent-generated
   `functionality`/`overall` score fields.
8. **`implementation-log.md` is visible to the verifier by default.** The spec
   says it shouldn't be, but neither the agent prompt nor the gate enforces
   the separation.
9. **`current-sprint` marker has no integrity.** The hook reads
   `.harness/current-sprint` to find which contract to close. An agent can
   write any sprint name there and close a different sprint.
10. **No positive proof-of-run.** The hook emits `decision:block` on failure,
    but nothing proves `sprint-close` actually ran on pass. An agent can claim
    a sprint closed without the gate ever executing.

### A.3 Single-biggest fix

Run each lane in an **isolated git worktree** (`git worktree add`). The
contract-signing key lives at `~/.config/threadwork/gate.key` (mode 0400). The
hook additionally writes a close token
`HMAC(sprint_id + git_head + timestamp)` that the task-board server verifies
before closing the task row — turning the gate from client-side discipline
into a server-enforced invariant.

### A.4 What the design gets right

- Dual-format contract (JSON for gate, markdown for humans) is correct.
- Inverting judge/builder strength is the right direction even if not
  sufficient.
- File-based handoff with an append-only `gate.log` is the right audit primitive.
- Lane parallelism is where the real speedups live.
- Putting the gate in bash — outside the agent's prompt surface — is the
  correct instinct even if the current boundary is wrong.

## Appendix B — Codex Review (Phase 4)

**Provenance:** produced by `codex exec` (OpenAI Codex CLI v0.118.0, logged in
via ChatGPT, GPT-5.4-class backing model) against the architecture spec on
2026-04-10. Raw output, lightly reformatted for quoting, not edited for content.

### B.1 Codex review #1 — architecture (verbatim)

> **1. Real workloads: this will bottleneck and fail late.** Parallel executors
> in one checkout will fight over lockfiles, generated code, migrations,
> caches, and shared test fixtures. Per-lane verification plus global gates
> multiplies `tsc`/lint/integration cost badly. Cross-lane regressions are
> mostly invisible until `sprint-close`, so you pay parallelism cost and still
> discover integration failures at the end.
>
> **2. Biggest unenforced seam: your "hard gate" only sits on
> `mcp__task-board__complete_task`.** An agent can still write code, mutate
> the contract, edit `spec_gate.sh`, forge verifier reports, change
> `current-sprint`, or just never call `complete_task`. Also, SHA-256 without
> a secret is not a signature. It detects accidental drift, not adversarial
> tampering, because any agent can recompute it.
>
> **3. Lane overlap detection via prefix/glob match is not sound.** False
> negatives: symlinks, case-insensitive FS, `../` normalization, generated
> files outside lane paths, shared config files, lockfiles, codegen outputs,
> and semantic overlap where two lanes touch different files in the same
> logical subsystem. False positives also occur with broad globs. Path
> overlap is a weak proxy for interference.
>
> **4. "Stronger verifier than executor" does not solve verifier
> self-approval; it relocates the failure mode into spec quality and test
> coverage.** If the planner underspecifies, or ACs are gameable, Opus will
> confidently approve bad work. A stronger judge helps only if the contract
> and evidence are robust; otherwise it just rationalizes a better-looking
> mistake.
>
> **5. One concrete improvement: run each lane in its own isolated
> worktree/container with an immutable contract ID and merge only through a
> gated integration queue.** That removes most filesystem races, makes scope
> enforcement real, and forces cross-lane verification before the task can
> close.

### B.2 Codex review #2 — spec_gate.sh security (TIMED OUT)

Attempted at 12:55 UTC. Codex CLI exited with
`Auth(TokenRefreshFailed("Failed to parse server response"))` — the ChatGPT
auth token could not be refreshed and no review was produced. A retry after
`codex login` is recommended. Lines of investigation the targeted review was
meant to cover (to run when auth is restored):
- bash injection via unquoted `$cmd` inside `bash -c "$cmd"` in `lane-verify`
  (test_command is attacker-controlled JSON)
- `path_matches_any` correctness against `..` traversal
- hook bypass via `spec_gate.sh` being on the executor's writable path
- race conditions between `contract-sign` writing the tmp file and a parallel
  read
- PreToolUse hook matcher string — does it actually match the MCP tool name?

### B.3 Convergent findings (A vs B)

| Finding | Appendix A (self) | Appendix B (Codex) |
|---|---|---|
| Gate defends wrong boundary | A.1 #1 | B.1 #2 |
| SHA-256 w/o secret is not a signature | A.1 #2 | B.1 #2 |
| Glob-prefix overlap is unsound | A.1 #3 | B.1 #3 |
| Filesystem race without worktree isolation | A.1 #4 | B.1 #1 |
| Cross-lane regressions invisible until sprint-close | A.1 #5 | B.1 #1 |
| "Stronger judge" necessary but not sufficient | A.2 #7 | B.1 #4 |
| Fix: isolated per-lane worktrees + real signatures | A.3 | B.1 #5 |

Two independent reviewers converge on the same core fixes. **This pattern
should NOT ship as-is.** The architecture direction is correct; the
enforcement mechanics need a v2 before any real sprint runs through it.

## Appendix C — Recommended v2 deltas (from reviews)

1. **Per-lane `git worktree` isolation.** Every executor gets its own checkout
   at `.harness/sprints/sprint-N/lane-K/worktree/`. The final `sprint-close`
   merges lanes into a dedicated integration branch and runs the full test
   suite once against the merged tree.
2. **HMAC signing with a file-owned secret.** Replace SHA-256 canonicalization
   with `openssl dgst -sha256 -hmac "$(cat ~/.config/threadwork/gate.key)"`.
   Key is mode 0400 owned by the user, re-read on every sign/verify.
3. **Server-side close token.** `spec_gate.sh sprint-close` writes
   `HMAC(sprint_id + git_head + ts) -> .harness/sprints/sprint-N/close.token`.
   The task-board server verifies this token before closing the row — the
   gate becomes server-enforced, not just hook-enforced.
4. **Drop glob-prefix overlap; replace with concrete-path pre-declaration.**
   Planner must list *exact* git-tracked paths per lane. Gate fails on any
   path in two lanes, or on any symlink in a lane's file set.
5. **Cross-lane smoke before sprint-close.** After all lane-verifies pass,
   merge lanes into a sandbox branch and re-run every lane's AC suite against
   the merged tree. Fail sprint-close on any regression.
6. **Verifier input lockdown.** Hard-scope verifier tools: Read only the
   contract + `lane-K/verifier-inputs/` (pre-staged by the gate). No
   `implementation-log.md`, no commit messages, no executor prose.
7. **Retry budget enforced by the gate.** `spec_gate.sh` maintains
   `lane-K/attempts.counter` and refuses the Nth sign after `max_retries`
   failures.
8. **Append-only chained gate log.** Each entry includes `prev_hash`, making
   the log a hash chain. Tampering with an old entry breaks every subsequent
   hash.
9. **Bash-injection audit in `lane-verify`.** `test_command` is executed via
   `bash -c "$cmd"` where `$cmd` comes from the contract JSON. Add an allowlist
   of shell primitives, or run each command in a restricted sandbox
   (`sandbox-exec`, `firejail`, or a disposable container).
10. **Retry the Opus/Council review.** Without an independent Opus opinion,
    this document has only one real external reviewer (Codex). Re-run the
    council once OpenRouter auth is fixed.
