---
name: harness-contract
description: |
  Run an autonomous Generator + Verifier harness against a sprint contract with hard ≥98% spec gate, file-based handoff,
  cron auto-unstick, Monitor on status.txt, read-only approved contracts, session-scoped Stop gate, optional Codex adversarial
  verification, and CronDelete-self on PASS. Use when the user says "sprint contract", "spec gate", "hard spec gate",
  "TDD-driven harness", "Generator + Verifier", "auto-unstick", "go end to end don't ask", "harness this", or
  "multi-task autonomous build". Triggers strongly when the request bundles ≥3 deliverables and wants measurable must_pass
  criteria, no further questions, and self-termination when the contract is met.
compatibility: Requires Claude Code/Cowork-style tools for background agents, cron/monitor, and project Stop hooks. Optional --codex-verify requires a configured Codex MCP server available to Claude.
---

# Harness-Contract — Autonomous Generator + Verifier with Hard Spec Gate

A specialisation of the base `/harness` Generator-Verifier pattern (which assumes one open-ended app build). This skill is for **bounded, multi-deliverable work** where:

- You can write a closed set of must_pass acceptance criteria
- Each criterion has a literal shell command that proves PASS/FAIL
- The contract is locked before spawning agents (no scope negotiation mid-flight)
- The work terminates *itself* on contract completion (no human checkpoints)
- The approved contract is made read-only and hash-checked before agents start
- A session-scoped Stop hook blocks final stop until terminal PASS evidence is real

The output is a sprint that runs to PASS or escalates cleanly at a tick budget — no infinite loops, no ambiguous "done".

## Mode flags

- `--codex-verify` (alias `--codex`): add a third **red-team** gate using Codex MCP before terminal completion. The Codex agent is not a neutral second opinion — it is told its job is to **make the spec gate fail**: find any deliverable that doesn't truly work, any fabricated evidence, any hollow PASS. The Stop hook does not call MCP itself; it blocks stop until `{SPRINT_DIR}/codex-adversarial-report.md` exists and contains `ADVERSARIAL PASS` (the verdict Codex is only allowed to write when it tried to break the build and genuinely could not).

## When to use vs when to skip

**Use** when the user wants:
- 2+ coordinated deliverables (e.g. config edit + memory file + HTML report)
- Each deliverable can be objectively verified by a script
- The session can run autonomously while they do something else
- TDD on at least one piece (test-fail-implement-pass evidence trail)

**Skip** when:
- The work is one quick edit (just do it inline)
- Acceptance is subjective (writing tone, design taste — those need human review, not a verifier shell command)
- The user wants to be in the loop on every decision (use TaskCreate + inline work instead)

## The contract — your central artefact

A sprint contract is a markdown file at `<project>/.harness/sprints/sprint-N/approved-contract.md`. It locks four things:

1. **Acceptance criteria table** — every row has `ID | Description | verifier_check shell command | must_pass (bool)`.
2. **Hard gate** — explicit threshold (default ≥98% of must_pass = TRUE; phrase as `≥ <N>/<M>` for clarity).
3. **Tick budget** — max cron iterations before escalation (default 6 ticks × 3 min = 18 min wall).
4. **Out-of-scope list** — explicit things the Generator must NOT touch (prevents drift).

Plus TDD discipline where applicable: each TDD'd deliverable requires a `FAIL ts=... → PASS ts=...` line in `evidence/tdd-log.txt`. The Verifier reads that file and confirms the FAIL line predates the PASS line.

See `assets/templates/approved-contract.md` for the canonical template.

Never collapse the acceptance criteria into prose or a short "gate" list. Every sprint contract must contain an `Acceptance criteria` table with 8-15 criterion IDs using the `C<number>.<number>` format (`C1.1`, `C1.2`, etc.), a `verifier_check` shell command for each must-pass row, and a `must_pass` boolean. Do not use alternate ID schemes like `AC-01`, `G1`, or `H1.1`; downstream graders and cron prompts look for `C...` IDs. This applies even for dry-run/eval artifact preparation. If the user asks for static artifacts only, still write the same contract shape and mark hooks/cron/MCP as prepared snippets rather than live actions.

Always include hardening evidence in the artifact set:

- `evidence/approved-contract.sha256` exactly; do not rename it to `contract-checksum.txt`, `checksum.txt`, or prose-only evidence.
- `.harness/active-session.json`
- `.claude/settings.local.json` or a disabled snippet named exactly `settings.local.json.disabled`
- `.harness/hooks/harness-stop-gate.py`

For `--codex-verify`, always include:

- `codex-adversarial-report.md` placeholder or packet
- `AWAITING_CODEX_VERIFY` state in the cron/status plan
- `ADVERSARIAL PASS` as the exact required terminal phrase

### Contract hardening

After the user approves the contract and before spawning agents:

1. Run `scripts/harden-contract.sh <contract_path> <sprint_dir>`.
2. Confirm `evidence/approved-contract.sha256` exists.
3. Confirm the contract has no owner/group/world write bits.
4. Do not let Generator or Verifier chmod the contract back to writable.

If a spec defect requires amendment, the orchestrator must explicitly unlock, amend, re-harden, and log the decision:

```bash
chmod u+w "$CONTRACT_PATH"
# append amendment block only; never rewrite prior criteria
scripts/harden-contract.sh "$CONTRACT_PATH" "$SPRINT_DIR"
```

Append the unlock/amend/re-harden action to `.harness/decision-log.md`.

## File layout

```
<project>/
├── .harness/
│   ├── roadmap.md                                   # one-pager of goal + work items + boundaries
│   ├── decision-log.md                              # ts + decision lines, append-only
│   └── sprints/
│       └── sprint-1/
│           ├── approved-contract.md                 # the locked spec
│           ├── status.txt                           # ONE word/phrase. State machine.
│           ├── implementation-log.md                # Generator's append-only journal
│           ├── verifier-report.md                   # Verifier's grading output
│           ├── codex-adversarial-report.md          # only when --codex-verify is enabled
│           └── evidence/
│               ├── approved-contract.sha256         # hash of locked contract
│               ├── tdd-log.txt                      # FAIL ts=... \n PASS ts=...
│               └── <other proof files as needed>
├── hooks/
│   └── harness-stop-gate.py                         # copied from this skill
└── .claude/
    └── settings.local.json                          # project/session-scoped Stop hook
```

`status.txt` is the single source of truth for the state machine. Values:
- `implementing` — Generator is working
- `ready_for_evaluation` — Generator declares done, waiting for Verifier
- `PASS <n>/<total>` — Verifier graded, sprint passed (n ≥ ceil(0.98 × total))
- `FAIL <n>/<total>` — Verifier graded, sprint failed; Generator loops in to fix
- `AWAITING_CODEX_VERIFY` — normal Verifier passed, `--codex-verify` gate still pending

`<project>` is a fresh dir (e.g. `~/<topic>-harness/`). Don't reuse an existing repo's `.harness/` — keep each harness run isolated so cleanup is `rm -rf`.

## The three moving parts

### 1. Contract — write before spawning agents

Adapt `assets/templates/approved-contract.md`. For each deliverable, write a verifier_check that exits 0 on PASS, non-zero on FAIL. Examples:

| Deliverable | verifier_check shape |
|---|---|
| YAML has a key with specific value | `grep -A2 'OpenAI OpCo' ~/tax/config/vendor-categories.yml \| grep -q 'NonEU-RC'` |
| New pytest test passes | `cd ~/tax && pytest tests/test_openai.py -q` |
| Existing tests still pass (no regression) | `cd ~/tax && pytest tests/test_config.py -q` |
| File exists with specific content | `test -f path && grep -q 'pattern' path` |
| HTML is valid + has search wiring | `grep -q 'type="search"' file && grep -q 'addEventListener' file` |
| TDD evidence is real | check tdd-log.txt has FAIL line ts predating PASS line ts |
| Contract is read-only | `test ! -w <contract_path>` |
| Contract hash exists with exact filename | `test -f <sprint_dir>/evidence/approved-contract.sha256` |
| Stop hook installed/prepared | `test -f <project>/.harness/hooks/harness-stop-gate.py && test -f <project>/.claude/settings.local.json` |
| Codex gate evidence exists | `grep -q 'ADVERSARIAL PASS' <sprint_dir>/codex-adversarial-report.md` |

If you can't write a verifier_check for a criterion, that criterion is *subjective* and doesn't belong here. Either drop it, or move it to "recommended" (not must_pass).

### 2. Spawn the Generator at launch; spawn the Verifier EVENT-DRIVEN on `ready_for_evaluation`

The Generator (sonnet, fast iteration) is spawned in background at launch. The Verifier (opus, rigorous grading) is **NOT** spawned at launch — it is spawned **only when `status.txt` flips to `ready_for_evaluation`**, by the Cron (branch d) or the orchestrator reacting to the Monitor transition. When spawned, the Verifier grades **immediately** (status is already `ready_for_evaluation`) and exits — no poll loop.

> **Why event-driven, not a polling verifier (root cause, learned 2026-05-29 sprint-15):** the old design spawned the Verifier upfront with a persistent inline `while true; sleep 30; done` poll loop "until status flips". That is unsound because **the Bash tool caps at 600s (10 min) per call** — a single blocking poll cannot outlast a generator that runs longer than ~10 min. When the poll call timed out with status still `implementing`, the model got control back and **rationalized ending its turn** ("I'll wait for the Monitor event") — but subagents do NOT receive Monitor events, so it died without grading. A short generator (<10 min) masked the bug by finishing inside one poll window. The fix removes the exposure entirely: spawn the Verifier at the moment there is something to grade, so it never polls and never hits the timeout. The cron's branch (d) was already the de-facto recovery path; it is now the **primary** spawn path.

Both prompts must include:
- Absolute path to the contract
- Absolute path to status.txt + implementation-log.md + verifier-report.md
- "Do NOT ask the user questions" (this is autonomous mode)
- For Generator: TDD discipline rules
- For Verifier: "status is ALREADY `ready_for_evaluation` — grade NOW, do not poll" + "no leniency, quote exact command output" + "re-run every verifier_check yourself, do not trust the Generator's log"

### 3. Monitor + Cron — the watchdog pair (v2, hardened post iter-2)

**Monitor** (one-shot, exits on terminal state) — streams `status.txt` transitions. v2 stall threshold raised 360→600s and poll 30→60s to free REPL slots for the Cron. See `references/monitor-recipe.sh` v2. Emits:
- `STATUS_CHANGED prev=... cur=... ts=...`
- `STALL_implementing log_age=...s` (>10 min, then every 5 min)
- `STALL_awaiting_verifier ticks_no_change=...`
- `TERMINAL pass|fail|blocked|timeout|amendment cur=...` — then exits

**Cron** (recurring, every 3 min) — unstick + termination. See `references/cron-tick-prompt.md` v2. Each tick:
1. Reads `status.txt`
2. **PASS ≥ threshold** → CronDelete self, append to decision-log, Telegram-notify + in-chat one-liner
3. **FAIL** → diff artifacts on disk vs criteria. If artifact correct but verifier_check buggy → status=AWAITING_AMENDMENT + Telegram-alert orchestrator. Else SendMessage Generator (or re-spawn if dead via TaskList check)
4. **implementing + log_age > 8 min** → diff artifacts, send DIRECTIVE message naming the highest-weight unstarted criterion (not generic "write a status line")
5. **ready_for_evaluation + no report** → TaskList check Verifier liveness; SendMessage if alive, re-spawn fresh if dead
6. **AWAITING_AMENDMENT** → wait for orchestrator amendment; budget-exhaust per (7)
7. Tick budget exhausted → CronDelete self + Telegram escalate

The Cron is the only thing that fires CronDelete.

**REPL-idle coupling (critical):** Cron jobs only fire while REPL is idle. A chatty Monitor (events every 30s) starves the cron. For sprints >15 min, raise Monitor stall threshold to 600s+ (v2 default), or skip Monitor entirely and let the cron be the sole observer.

**Telegram escalation (v2):** All terminal events and inline-input requests fire `mcp__claude_ai_Telegram__Telegram_Execute_Tool` to reach Xavier on mobile even if asleep. Routine in-conversation events stay in the chat.

**Spec-defect amendment workflow (v2):** Verifier may flag a criterion `SPEC_DEFECT_SUSPECTED` when the artifact is correct but the verifier_check command is buggy (markdown-pipe-escape leakage, wrong path, etc.). Cron writes status=AWAITING_AMENDMENT instead of FAIL→Generator-retry. Orchestrator amends contract in a fenced code block + decision-log entry, then flips status back. See `assets/templates/approved-contract.md` amendment workflow section.

### 4. Session-scoped Stop gate

Install a deterministic Stop hook for each sprint. The hook reads `.harness/active-session.json`, checks that the hook `session_id` matches, and exits inertly for every other session. For the active session it blocks stopping unless:

- `approved-contract.md` has no write bits.
- `evidence/approved-contract.sha256` matches the current contract.
- `status.txt` is `PASS X/M` with `X >= threshold`.
- `verifier-report.md` exists and contains the terminal score.
- When `--codex-verify` is enabled, `codex-adversarial-report.md` exists and contains `ADVERSARIAL PASS`.

Create `<project>/.claude/settings.local.json` with:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .harness/hooks/harness-stop-gate.py",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Create `<project>/.harness/active-session.json` after launch with:

```json
{
  "session_id": "<hook input session_id or empty until known>",
  "sprint_dir": "<absolute sprint dir>",
  "contract_path": "<absolute approved-contract.md>",
  "threshold_n": 10,
  "threshold_m": 10,
  "codex_verify": false
}
```

If the current `session_id` is not known at setup time, keep the marker empty only for a dry run, capture the first hook input session id, then update the marker before relying on the gate. Do not leave the marker broad for production harness runs.

### 5. Optional Codex red-team adversary (`--codex-verify`)

When the user requests `--codex-verify`, add a third gate — a **hostile red team, not a neutral second opinion**. Codex is told its job is to **make the spec gate fail**: actively hunt for any deliverable that doesn't truly work, any fabricated TDD evidence, any criterion that passes its shell check but fails its intent, any integration that's green on a static grep but broken at runtime. The build only survives if Codex tries hard to break it and genuinely cannot.

1. Copy `assets/templates/codex-adversarial-prompt.md` into the sprint plan with paths substituted (it carries the break-the-build mandate).
2. After the normal Verifier writes `PASS X/M`, call the Codex MCP tool with that prompt.
3. Require Codex to write `{SPRINT_DIR}/codex-adversarial-report.md`. Codex writes `ADVERSARIAL FAIL` the moment it finds a way to break the build (with the exact failing criterion + reproduction); it writes `ADVERSARIAL PASS` only when it could not.
4. Keep `status.txt` at `AWAITING_CODEX_VERIFY` until that report contains `ADVERSARIAL PASS`.
5. Only then restore `status.txt` to `PASS X/M` so Cron can CronDelete and the Stop hook can approve. If the report says `ADVERSARIAL FAIL`, the Cron bounces the findings back to the Generator (status → `implementing`) — a red-team failure is treated exactly like a Verifier FAIL.

Do not implement Codex MCP invocation inside a command hook. Hooks should be deterministic and fast; the cron/orchestrator performs MCP calls, and the Stop hook only verifies the resulting evidence file.

## Procedure (run in order)

```
1. mkdir -p ~/<topic>-harness/.harness/sprints/sprint-1/evidence ~/<topic>-harness/.harness/hooks ~/<topic>-harness/.claude
2. Write .harness/roadmap.md         (use assets/templates/roadmap.md as scaffold)
3. Write .harness/sprints/sprint-1/approved-contract.md  (use assets/templates/approved-contract.md)
4. Run scripts/harden-contract.sh against approved-contract.md and sprint dir
5. Copy scripts/harness-stop-gate.py to .harness/hooks/harness-stop-gate.py
6. Write .claude/settings.local.json with the Stop hook snippet above
7. Write .harness/active-session.json with sprint paths, threshold, and codex_verify flag
8. Write .harness/sprints/sprint-1/status.txt with the literal word "implementing"
9. Write .harness/decision-log.md with a launch line and contract-hardening line
10. Spawn Generator (model: sonnet, run_in_background: true) with the prompt from assets/templates/generator-prompt.md, inject paths
11. Do NOT spawn the Verifier yet. It is spawned event-driven when status flips to `ready_for_evaluation` (by the Cron branch d, or by the orchestrator reacting to the Monitor transition). It grades immediately — no poll loop. See moving-part #2.
12. If --codex-verify: prepare assets/templates/codex-adversarial-prompt.md for cron use after normal PASS
13. Load tools: ToolSearch select:CronCreate,CronDelete,Monitor
14. Start Monitor (timeout 3600000ms, persistent:false) with the recipe in references/monitor-recipe.sh
15. CronCreate */3 * * * * with the tick prompt in references/cron-tick-prompt.md
16. Tell the user: "Harness live. Generator in background, Stop gate installed, Monitor + 3-min Cron watching. Verifier spawns on ready_for_evaluation. Will report on terminal state."
17. End your turn. Don't poll. When the Monitor signals `ready_for_evaluation`, spawn a grade-now Verifier (or let the Cron do it). The Cron auto-CronDeletes on PASS.
```

## What the user sees

- Live transition events from the Monitor (`STATUS_CHANGED implementing → ready_for_evaluation → PASS 11/11`)
- A "Verifier spawned to grade" note on the `ready_for_evaluation` transition
- Stall warnings if the Generator hangs
- A one-line completion summary when the Cron auto-deletes itself
- All evidence at `<project>/.harness/sprints/sprint-1/` (contract, status, report, tdd-log)

## Anti-patterns (caught the hard way)

- **Verifying with the same agent that implemented.** Always two agents, different models, file-based handoff. The Verifier must re-run the shell commands, not trust the Generator's log claims.
- **Soft acceptance ("ish", "approximately").** Every must_pass needs a literal command that exits 0 or non-zero. If you can't write one, the criterion is subjective — exclude it.
- **Letting the cron run forever.** Always set a tick budget. The default 6 ticks × 3 min = 18 min wall is right for one-sprint work; tune up for genuinely multi-hour builds.
- **Mid-flight scope changes.** Once the contract is locked + the agents are spawned, the contract is immutable for that sprint. If new scope appears, queue it as sprint-2.
- **Monitor and Cron both firing CronDelete.** Only the Cron deletes. The Monitor observes and emits.
- **All-static verifier_checks on integration code (hollow PASS).** If every criterion is a `grep` / `node --check` / pure-function unit test, the gate can hit 100% while the real integration is broken in production. (2026-06-08: a contact-form sprint graded 14/14 PASS but the Netlify Blobs capture didn't work at all in prod — missing `connectLambda(event)` — because no check exercised the live runtime.) For any criterion covering an external integration (Blobs/DB/HTTP/3rd-party SDK), include at least one verifier_check that does a real round-trip against the deployed thing, not just static/unit checks.
- **Locking the contract on an unverified root cause.** Reproduce the actual failure and confirm the mechanism with live evidence BEFORE writing the PRD + contract. A flawless sprint that fixes the wrong defect is wasted (and a green gate makes it look done).
- **A placeholder that contains the verdict phrase the gate greps for.** The `--codex-verify` gate's C5.1 check is `grep -q 'ADVERSARIAL PASS' codex-adversarial-report.md`. If you pre-create that report as a placeholder, NEVER let the placeholder contain the literal string `ADVERSARIAL PASS` (even in explanatory prose like "this file will say ADVERSARIAL PASS when Codex passes") — the grep matches it and the gate opens before Codex has run, so the Stop hook approves a build the red team never actually attacked. Either create no placeholder, or write the placeholder with the phrase deliberately broken (e.g. `ADVERSARIAL_PENDING`). The same trap applies to any verifier_check that greps a status/report file for its own success token.

## Reference: the canonical run

`~/coa-harness/` — 2026-05-15. Three deliverables (vendor-categories YAML + memory pointer + searchable HTML), 11 must_pass criteria, 1 TDD'd item (W1 — extending VendorRule with vat_mechanism + entity fields), gated at ≥98%. Monitor + Cron drove it to PASS without further input. Use it as the template you adapt from.

## Files in this skill

| Path | Purpose |
|---|---|
| `assets/templates/approved-contract.md` | The contract scaffold — criteria table, hard gate, TDD rules, out-of-scope |
| `assets/templates/roadmap.md` | One-pager goal + work items + boundaries |
| `assets/templates/generator-prompt.md` | Sonnet Generator spawn body (with TDD discipline) |
| `assets/templates/verifier-prompt.md` | Opus Verifier spawn body (no leniency, exact commands) |
| `assets/templates/codex-adversarial-prompt.md` | Optional Codex MCP red-team prompt (mandate: break the build) for `--codex-verify` |
| `references/monitor-recipe.sh` | The status.txt watcher with stall detection |
| `references/cron-tick-prompt.md` | The */3 cron prompt body with auto-unstick + CronDelete |
| `scripts/harden-contract.sh` | Hash and chmod the approved contract after approval |
| `scripts/harness-stop-gate.py` | Deterministic Stop hook that blocks stop without immutable PASS evidence |
