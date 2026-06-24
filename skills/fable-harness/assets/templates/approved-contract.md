# Sprint N — Approved Contract (locked)

**Sprint name**: {SHORT_KEBAB_NAME}
**Generator model**: opus (Opus 4.8, thinking high)
**Verifier model**: fable (Fable 5)
**Hard gate**: ≥ 98% of must_pass criteria PASS (i.e. ≥ {N}/{M} must_pass)
**Contract immutability**: approved contract is hashed to `evidence/approved-contract.sha256` and `chmod a-w` before agents start
**Stop gate**: session-scoped Stop hook blocks completion unless contract hash, read-only mode, verifier PASS, and optional Codex evidence are present
**Codex red-team gate**: {enabled|disabled}; if enabled (`--codex`), the normal PASS is non-terminal until a hostile Codex adversary — mandate: break the build — writes `codex-adversarial-report.md` containing `ADVERSARIAL PASS` (its "I could not break it" verdict)
**Max iterations (monitor unsticks)**: 5
**Tick budget**: scale to sprint workload
- ≤4 deliverables: 6 × 3 min = 18 min wall
- 5–6 deliverables: 8 × 3 min = 24 min wall
- 7+ deliverables: 12 × 3 min = 36 min wall
**Verifier poll pattern**: persistent (`while true`, exits on terminal status) — NOT fixed-iteration. See `references/cron-tick-prompt.md` v2 and `assets/templates/verifier-prompt.md` v2.

## Acceptance criteria

> Every row's verifier_check is a literal shell command. Exit code 0 = PASS, anything else = FAIL.
> The Verifier executes these commands itself — don't paraphrase, don't abbreviate.
>
> **CRITICAL — Markdown table escape leakage**: if your command needs `|` (ERE alternation, `||` shell OR, command-substitution pipes), DO NOT put it in the table cell directly. Markdown table cells escape `|` to `\|`, which leaks into the shell as a literal escaped pipe (e.g. under `grep -E`, `\|` is a literal pipe character, NOT alternation). Put pipe-bearing commands in a fenced code block BELOW the table and reference the block from the cell. See "Amendment example" further down.

| ID | Description | verifier_check | must_pass |
|----|-------------|----------------|-----------|
| C1.1 | {what} | `<exact shell command, no pipes>` | true |
| C1.2 | {what} | `<exact shell command>` | true |
| C2.1 | {what} | see "C2.1 command" code block below | true |
| C3.1 | {what} | `<exact shell command>` | true |
| C4.1 | Approved contract is no longer writable | `test ! -w {CONTRACT_PATH}` | true |
| C4.2 | Approved contract checksum exists with exact filename | `test -f {SPRINT_DIR}/evidence/approved-contract.sha256` | true |
| C4.3 | Stop hook script is prepared | `test -f {PROJECT_DIR}/.harness/hooks/harness-stop-gate.py` | true |
| C4.4 | Session-scoped hook marker exists | `test -f {PROJECT_DIR}/.harness/active-session.json` | true |
| C4.5 | Project hook config or disabled dry-run snippet exists | `test -f {PROJECT_DIR}/.claude/settings.local.json -o -f {PROJECT_DIR}/.claude/settings.local.json.disabled` | true |

```bash
# C2.1 command (referenced from table)
test -f /path/to/artifact && grep -qiE 'a|b|c' /path/to/artifact
```

Aim for 8–15 criteria. Fewer than 8 means the contract is too loose; more than 15 means you're confusing acceptance with implementation steps. Include the harness-infrastructure criteria too: read-only contract, checksum evidence, Stop hook marker/config, and, when enabled, Codex adversarial evidence.

Minimum infrastructure rows to adapt into every contract. Keep the IDs in `C<number>.<number>` format:

| ID | Description | verifier_check | must_pass |
|----|-------------|----------------|-----------|
| C4.1 | Approved contract is no longer writable | `test ! -w {CONTRACT_PATH}` | true |
| C4.2 | Approved contract checksum exists with exact filename | `test -f {SPRINT_DIR}/evidence/approved-contract.sha256` | true |
| C4.3 | Stop hook script is prepared | `test -f {PROJECT_DIR}/.harness/hooks/harness-stop-gate.py` | true |
| C4.4 | Session-scoped hook marker exists | `test -f {PROJECT_DIR}/.harness/active-session.json` | true |
| C4.5 | Project hook config or disabled dry-run snippet exists | `test -f {PROJECT_DIR}/.claude/settings.local.json -o -f {PROJECT_DIR}/.claude/settings.local.json.disabled` | true |

When `--codex` (the red-team gate) is enabled, add:

```bash
# C5.1 Codex red-team survived (adversary could not break the build)
test -f {SPRINT_DIR}/codex-adversarial-report.md && grep -q 'ADVERSARIAL PASS' {SPRINT_DIR}/codex-adversarial-report.md
```

> Trap: if you pre-seed `codex-adversarial-report.md` as a placeholder, it must NOT contain the literal string `ADVERSARIAL PASS` anywhere (not even in a sentence describing what the file will say later) — the `grep -q` above would match it and open the gate before Codex ever runs. Use a broken token like `ADVERSARIAL_PENDING` in the placeholder, or write no placeholder at all.

### Upper-bound discipline (NEW — iter-2 retrospective)

Every `≥N` extension criterion must pair with an upper bound. Open-ended `≥N` lets the Generator over-polish past the spec and miss later work items. Use one of:

| Bad | Better |
|---|---|
| `"≥6 pages with ≥1000 words each"` | `"exactly 6 pages with ≥1000 words each"` |
| `"≥17 marketing_tasks live"` | `"exactly 17 marketing_tasks live"` |
| `"≥3 supplier quotes documented"` | `"3-5 supplier quotes documented"` |

Implement upper bound in the verifier_check itself:
```bash
# Good
python3 -c "import glob; n=sum(1 for p in glob.glob('/path/*.md') if len(open(p).read().split())>=1000); assert 6 <= n <= 10, f'{n} not in [6,10]'"
```

## TDD discipline (applies to any deliverable that touches shipping code)

For TDD-flagged work items, the Generator MUST:

1. Write a failing test that asserts the post-state.
2. Run the test → confirm fail. Append `FAIL ts=<ISO8601> reason=<msg>` to `evidence/tdd-log.txt`.
3. Implement the change.
4. Re-run the test → confirm pass. Append `PASS ts=<ISO8601>` to the same log.

Verifier check for TDD evidence: read `evidence/tdd-log.txt`, confirm the FAIL line timestamp predates the PASS line, both lines exist. If the FAIL is missing or its timestamp is later than the PASS, the criterion fails.

For non-TDD deliverables (docs, HTML reports, config-only edits), a smoke check of the produced artifact is sufficient.

## Amendment workflow (NEW — iter-2 retrospective)

Sometimes the contract has a spec defect (e.g. verifier_check command has a bug, path is wrong, regex syntax is broken) and the artifact is actually correct. The Verifier will FAIL the criterion in that case. To resolve without retrying Generator:

1. Verifier flags the criterion `SPEC_DEFECT_SUSPECTED` in its report.
2. Orchestrator inspects, confirms artifact is correct, writes an amendment.
3. Orchestrator unlocks the contract explicitly with `chmod u+w approved-contract.md`.
4. Amendment goes in a `## <ID> amended command` section in THIS contract file (not the table). Includes: amended command in a fenced code block, timestamp, rationale.
5. Re-run `scripts/harden-contract.sh approved-contract.md <sprint_dir>` to refresh the checksum and remove write bits.
6. Append to `.harness/decision-log.md`: "Tick T: contract amendment for <ID>, rationale: <X>; contract re-hardened".
7. Set status.txt back to a regrade-triggering state and re-spawn or message Verifier.

Example amendment block (post-iter-2):

```markdown
## C2.1 amended command (2026-05-20T17:05Z)

Original used `\|` in markdown table cell; under `grep -E` this is literal escaped pipe, not alternation. Amended command:

\`\`\`bash
test -f /path/plan.html && grep -qiE 'f4e4bc|manila|#e8d8b0' /path/plan.html
\`\`\`

Rationale: spec defect, artifact correct.
```

## Out-of-scope (DO NOT)

- {explicit thing the Generator must not touch}
- {another}
- {another}

These exist to prevent scope drift. Anything not on the in-scope deliverable list above must not be modified.

## Termination

- Verifier writes `PASS <n>/<total>` to `status.txt` when pass_rate ≥ 0.98 (≥ {N}/{M} must_pass).
- The Cron tick reads that and CronDeletes itself. The Monitor sees TERMINAL pass and exits.
- On FAIL, the Cron messages the Generator with the score + verifier-report.md path; Generator fixes and rewrites `ready_for_evaluation`. Verifier re-grades. Loop bounded by the tick budget.
- On `SPEC_DEFECT_SUSPECTED`, cron writes status.txt=AWAITING_AMENDMENT and Telegram-alerts orchestrator. Cron does NOT CronDelete — waits for amendment or budget exhaustion.
- With Codex adversarial gate enabled, normal Verifier PASS is not terminal. Cron writes `AWAITING_CODEX_VERIFY`, calls Codex MCP with the adversarial prompt, and only restores `PASS X/M` after `codex-adversarial-report.md` contains `ADVERSARIAL PASS`.
- At tick budget without PASS: escalate to user via Telegram + CronDelete self. No infinite loops.

## Telegram escalation routes (NEW)

All terminal events (PASS, FAIL, BLOCKED, TIMEOUT, AWAITING_AMENDMENT) and inline-input requests fire `mcp__claude_ai_Telegram__Telegram_Execute_Tool` to reach Xavier on mobile. Routine in-conversation events stay in the chat — Telegram is for "Xavier needs to know now even if asleep" moments.
