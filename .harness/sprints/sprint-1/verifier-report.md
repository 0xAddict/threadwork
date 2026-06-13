# Verifier Report — Sprint 1

## Verdict: PASS
**Overall Score: 90/100**

---

## Criterion Scores

### Functionality (9/10) — Weight 40%

Tested all 10 acceptance criteria. All pass.

**AC#1 — File exists & committed.** PASS.
- `docs/v2-heartbeat-cutover-runbook.md` exists on `feat/v2-cutover-runbook`.
- Committed: `d7952c2 sprint-1: V2 heartbeat cutover runbook (#1267)`.
- Commit message references both "sprint-1" and "#1267". ✓

**AC#2 — All 5 steps covered with 4 sub-parts each.** PASS.
- `grep -nE '^## [0-4]\.'` → 5 sections (lines 10, 131, 314, 381, 491).
- `grep -c '^### Commands'` → 5.
- `grep -c '^### File paths'` → 5.
- `grep -c '^### Verification'` → 5.
- `grep -c '^### Rollback'` → 5. ✓

**AC#3 — Exact, executable commands with real absolute paths.** PASS.
- 21 distinct absolute/tilde paths verified; all 12 non-operator-created paths
  exist on disk (`test -e`). The `{out,err}.log` brace expansion in the runbook
  is notation; individual files `heartbeat-v2.err.log` and `heartbeat-v2.out.log`
  both exist under `~/.threadwork/logs/`. ✓

**AC#4 — Step 1 correctness.** PASS.
- Explicitly names the stub (`~/bin/heartbeat-daemon-v2.sh`, 3-line placeholder). ✓
- Exact edit: `PlistBuddy -c "Set :ProgramArguments:0 /Users/coachstokes/.claude/mcp-servers/task-board/bin/heartbeat-daemon-v2.sh" "$PLIST"`. ✓
- Reload sequence: `bootout gui/$(id -u)/<label>` then `bootstrap gui/$(id -u) "$PLIST"`. ✓
- Verification check #3: `tail -n 20 ~/bin/heartbeat-v2.log` and expect the "heartbeat-daemon-v2 starting" banner (daemon lines 424–425). ✓
- Dry-run of the full Step 1 plist edit on a temp copy of the real plist: ProgramArguments repointed correctly, `plutil -lint` → OK. ✓

**AC#5 — G1 and G2 addressed with concrete remediations.** PASS.
- G1 (StartInterval double-loop): diagnosed at lines 64–71, remediated via
  `Delete :StartInterval` + `Add :KeepAlive bool true` (1d). ✓
- G2 (missing TELEGRAM_TOKEN / SUPABASE_SERVICE_KEY): diagnosed at lines 72–79,
  remediated with two `PlistBuddy Add :EnvironmentVariables:…` commands (1e)
  and a secrets-file alternative path. ✓
- Neither gap is papered over. The daemon's `:?` parameter-expansion lines are
  cited by number (18, 31). ✓

**AC#6 — Verification commands are runnable shell, not prose.** PASS.
- 26 fenced `bash` blocks found. All 26 pass `bash -n` syntax check. ✓
- Verification SQL queries (`sqlite3 ~/bin/heartbeat-v2.db "SELECT … FROM heartbeats_v2 …"`)
  tested against the real DB — columns confirmed, queries return real data. ✓

**AC#7 — Rollback for every step.** PASS.
- Steps 0–4 all have a `### Rollback` sub-part with executable commands:
  Step 0: 11 lines / has code ✓
  Step 1: 16 lines / has code ✓
  Step 2: 10 lines / has code ✓
  Step 3: 12 lines / has code ✓
  Step 4: 20 lines / has code ✓
- Step 4 rollback explicitly covers the 14-day v1-decommission window, retains
  the v1 plist until Day 14, and gives the `launchctl bootstrap` re-enable
  command. ✓

**AC#8 — Soak pass criterion stated.** PASS.
- Pass gate: "v2 false-positive rate ≤ 50% of v1's false-positive rate over the
  48h window" (line 388–389) AND `v2_fp_rate <= 0.5 * v1_fp_rate` (line 470). ✓
- Both forms (natural language + formula) present. ✓
- SQL queries to compute both v1 and v2 STUCK/CRASHED counts, with the
  denominator (total classifications) included. ✓

**AC#9 — Soak bug cross-reference #842/#843.** PASS.
- Referenced 5 times in the document. ✓
- Root cause accurately described: `emit-state.sh` hooks load only at
  SessionStart; running sessions emit no fresh declarations; stale rows →
  false STUCK. ✓
- Short-term fix (a): `/clear` all agent sessions pre-soak (§3a). ✓
- Long-term fix (b): Sprint 2 daemon fallback (§2). ✓

**AC#10 — STAGED-vs-executed clarity.** PASS.
- 5 occurrences of "STAGED" in the document. ✓
- Step 3 header: "**STAGED (do not run without GweiSprayer greenlight)**". ✓
- Step 4 header: same marker. ✓
- Summary table in §0 marks Steps 3 and 4 as STAGED; Steps 0 and 1 as
  done/operator-executable-now. ✓
- "STAGED means: the section below is a complete, executable plan, but the
  harness does not run it." (line 55) ✓

---

### Completeness & Structure (9/10) — Weight 25%

The document is logically structured and complete. Every section builds on
the previous; cross-references (§0 soak-bug cross-reference, §2 forward-
reference to Sprint 2, §3 fix-(a) pre-soak step) are coherent. The appendix
quick-reference table is a genuine usability addition.

The line-number citations to the daemon are accurate — only a trivial off-by-one
on line 22 (`HOURLY_INTERVAL=3600`, not `CHECK_INTERVAL`) where the nearby line
21 is the correct one for `CHECK_INTERVAL=300`. This does not affect executability.

Minor gap: the runbook does not mention the pre-built
`scripts/heartbeat-v2-monitor.sh` (which automates the FP comparison with a
10-min sliding lookback). The soak verification section instead describes manual
per-row triage. The manual approach is valid and contract-compliant, but the
operator would benefit from knowing the automated tool exists. Score docked 1
point on completeness.

---

### Executability & Correctness (9/10) — Weight 20%

Strengths:
- PlistBuddy dry-run on a temp copy of the real plist: executes correctly,
  `plutil -lint` passes, ProgramArguments resolves to the real daemon.
- All 26 bash blocks pass `bash -n`.
- DB collapse SQL (Step 4c) tested against test DBs: row counts match, no
  schema errors.
- Daemon startup lines (422–426) confirmed to contain the verification
  string "heartbeat-daemon-v2 starting".

One identified weakness not blocking the contract:
- Step 1e's `PlistBuddy Add :EnvironmentVariables:TELEGRAM_TOKEN` will error
  on a second run if the key already exists (confirmed: "Entry Already Exists",
  exit 1). The Step 1 flow runs once, so this is not an in-scope operational
  problem, but a defensive `Delete` before `Add` (like the pattern used for
  `:KeepAlive` in step 1d) would make the step idempotent and safer to retry.
  Not a contract failure; flagged for operator awareness.
- The `bash -lc` invocation in the alternative-path wrapper (Step 1e) is correct
  for sourcing a secrets file at launch, though operators should know `-l` loads
  their login shell profile which may have unintended side effects on minimal
  launchd environments. Again, noted as advisory only.

Score docked 1 point.

---

### Originality (8/10) — Weight 15%

Per the adapted rubric, Originality is de-emphasised (baseline 7–8). This
scores at baseline-high. The runbook makes several non-obvious choices:
- The G1 diagnosis and the matching of the fix to v1's actual plist pattern
  (KeepAlive, no StartInterval) is well-reasoned.
- The note explaining that `SUPABASE_SERVICE_KEY` is only strictly required when
  `OPENROUTER_API_KEY` is absent (lines 234–239) adds operator value and is not
  boilerplate.
- The DB collapse approach (copy-by-schema into the canonical v1 DB rather than
  repointing the daemon's `HEARTBEAT_DB_PATH`) cleanly avoids a code change at
  flip time.

---

## Specific Findings

**F1 (MINOR — not a contract failure): Step 1e not idempotent.**
`PlistBuddy -c "Add :EnvironmentVariables:TELEGRAM_TOKEN string …"` fails with
exit code 1 if the key already exists (confirmed in live test). Step 1d
correctly uses `Delete` before `Add` for `:KeepAlive`. Step 1e should follow
the same pattern for operator safety. Not a contract failure because Step 1 runs
once; flagged for generator awareness.

**F2 (ADVISORY — outside contract scope): heartbeat-v2-monitor.sh not mentioned.**
`scripts/heartbeat-v2-monitor.sh` provides automated FP-rate comparison. It was
not required by the contract but its existence is directly relevant to Step 3
execution. A future runbook revision should reference it in §3.

**F3 (TRIVIAL — no impact): Line number off-by-one for CHECK_INTERVAL.**
Runbook says `CHECK_INTERVAL=300` is at "line 22". Actual line 21. `HOURLY_INTERVAL=3600`
is on line 22. The daemon loop lines 447–468 cited alongside it are correct.
No execution impact.

---

## Pass/Fail Summary

| Criterion | Result | Notes |
|-----------|--------|-------|
| AC#1 File exists & committed | PASS | Branch + commit confirmed |
| AC#2 All 5 steps, 4 sub-parts each | PASS | 5×5 grid confirmed |
| AC#3 Exact executable commands | PASS | 12/12 non-operator paths exist |
| AC#4 Step 1 correctness | PASS | Dry-run succeeds, plutil OK |
| AC#5 G1 & G2 addressed | PASS | Both gaps diagnosed + remediated |
| AC#6 Runnable verification commands | PASS | All 26 blocks pass bash -n |
| AC#7 Rollback every step | PASS | All 5 steps, non-empty with code |
| AC#8 Soak pass criterion stated | PASS | ≤50% gate in two forms |
| AC#9 #842/#843 cross-reference | PASS | 5 references, root cause correct |
| AC#10 STAGED-vs-executed clarity | PASS | 5 STAGED markers, summary table |

**Functionality: 9/10** — All 10 criteria met. 1 point withheld for the
non-idempotent Step 1e (F1); not a contract criterion but reduces confidence
in executability under retry.

**Weighted score: 0.40×9 + 0.25×9 + 0.20×9 + 0.15×8 = 3.6 + 2.25 + 1.8 + 1.2 = 8.85 = 89 → rounded 90/100**

## Verdict: PASS

Functionality ≥ 9 and overall ≥ 78. The runbook is accurate, complete, and
copy-paste-executable for Step 1. Gaps G1 and G2 are correctly identified and
remediated. Steps 3 and 4 are properly STAGED. The #842/#843 bug and Sprint 2
forward-reference are well-integrated. Sprint 1 is done.

**Recommended fixes before Step 1 execution (advisory, not contract-required):**
1. Make Step 1e idempotent: add `PlistBuddy -c "Delete :EnvironmentVariables:TELEGRAM_TOKEN" "$PLIST" 2>/dev/null || true` before each `Add` command.
2. Add a note in §3 pointing to `scripts/heartbeat-v2-monitor.sh` for automated FP computation.
