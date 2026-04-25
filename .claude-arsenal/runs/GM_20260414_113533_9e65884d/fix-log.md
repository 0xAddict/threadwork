# Phase 5 FIX Log — GM_20260414_113533_9e65884d

Run: GM_20260414_113533_9e65884d
Date: 2026-04-14
Source findings: AV_20260414_0902_99325da (/alpha-verify Phase 4)
Target tree: /Users/xavierandre/the-arsenal/plugin/skills/

## Summary

| Severity | Total in plan | Applied | Verified-correct (no fix) | Skipped |
|----------|---------------|---------|---------------------------|---------|
| HIGH     | 5             | 4       | 0                         | 1 (H3, file does not exist) |
| MEDIUM   | 5             | 4       | 1 (M2)                    | 0       |
| LOW      | 5             | 4       | 1 (L5, already correct)   | 0       |

Both deterministic test suites still PASS after fixes:
- `bash _shared/tests/test-repo-compare.sh` -> PASS
- `bash _shared/tests/test-landscape-compare.sh` -> PASS

---

## HIGH

### H1 — `--skip-prompt` flag now parsed in compare-verify.sh
File: `repo-compare/scripts/compare-verify.sh`
- Added `SKIP_PROMPT=0` initializer.
- Added `--skip-prompt) SKIP_PROMPT=1; shift;;` case.
- Added `elif [ "$SKIP_PROMPT" = "1" ]; then ... ;` branch in production-mode prompt block, which logs and falls through to consolidation instead of printing the "stop and wait" prompt.
- Smoke check: `bash compare-verify.sh --skip-prompt ...` no longer errors with "unknown arg".

### H2 — `INSERT OR REPLACE` in landscape-compare consolidator's `insert_gap`
File: `landscape-compare/scripts/consolidator.sh:129`
- Changed `INSERT INTO gaps` -> `INSERT OR REPLACE INTO gaps`.
- Phase re-runs no longer hit `UNIQUE(candidate, capability_id)` violations that would be counted as rejections (and could trip the 20% halt).

### H3 — `shell-commands.sh` 16-vs-12 scanner mismatch
File: `landscape-compare/references/shell-commands.sh`
- File does not exist (the entire `references/` directory is absent under `landscape-compare/`).
- Per finding instructions: "If the file doesn't exist, skip this finding." -> SKIPPED.

### H4 — "5 SQL gates" -> "8 SQL gates" in two places
- `landscape-compare/SKILL.md` line 135: "5 SQL gates" -> "8 SQL gates".
- `landscape-compare/scripts/stop-hook.sh` line 6: "5 SQL gates" -> "8 SQL gates".
- Implementation in stop-hook.sh has Gates 1-8; documentation now matches.

### H5 — Removed bare `raise` in compare-verify.sh compare-phase
File: `repo-compare/scripts/compare-verify.sh` ~line 403
- Removed the trailing `raise` after `reject(obj, ...)` in the compare-insert exception handler.
- A single FK/CHECK error now records a rejection and continues to the next row, matching the verify-phase loop's behaviour. Prevents one bad row from aborting the entire consolidation.

---

## MEDIUM

### M1 — Removed duplicated `context.*window` taxonomy pattern
File: `_shared/default-taxonomy.yaml`
- Removed `"context.*window"` from `session_state.grep_patterns`.
- Pattern remains in `context_management.grep_patterns` (kept there as the more semantically accurate home).

### M2 — Verified: grep fallback in `index.sh` DOES apply exclusions
File: `repo-compare/scripts/index.sh:131-156`
- Read confirmed: when the ripgrep branch is not used, the script runs `grep -rnEI` and then post-processes each line with a `case "$rel"` block (lines 152-156) that excludes `test/`, `tests/`, `__tests__/`, `examples/`, `docs/`, `vendor/`, `node_modules/`, `generated/`, `.git/`, plus `*.test.*`, `*.spec.*`, `*.d.ts`.
- Status: scanner-5's "false positive" call is correct. **No code change needed.**

### M3 — Enforced `expected_op` for each table in landscape consolidator
File: `landscape-compare/scripts/consolidator.sh` (after the existing `expected_op = SUPPORTED[tbl][0]` line)
- Added a check: when `op != expected_op`, reject the row with reason `invalid operation for table: <tbl> expects '<expected>', got '<op>'`.
- Removes the dead-code smell and turns the `SUPPORTED` table's per-table operation into actually-enforced policy (e.g., `gaps` is `insert`-only, never `upsert`).

### M4 — landscape-compare phase count consistency
File: `landscape-compare/SKILL.md`
- Heading "## Pipeline (8 phases)" -> "## Pipeline (8 phases, plus init and clone subphase)".
- Acknowledges that phase numbering 0, 1, 1.5, 2-7 yields 9 logical steps while keeping the canonical "8 phases" framing the rest of the doc uses.

### M5 — `validate_yaml` is now a hard gate when PyYAML is missing
File: `_shared/lib.sh`
- The PyYAML `ImportError` branch now prints "validate_yaml: pyyaml not installed; install with `pip3 install pyyaml`" and `sys.exit(1)`.
- Previously exited 0 with a warning, silently passing per-skill validation despite README documenting it as a hard gate.

---

## LOW

### L1 — Removed hardcoded absolute path in candidates template
File: `repo-compare/references/candidates-template.yaml` line 17
- `See /Users/xavierandre/the-arsenal/plugin/skills/_shared/README.md` -> `See ../../_shared/README.md`.

### L2 — Added commit SHA placeholder warning in candidates template
File: `repo-compare/references/candidates-template.yaml`
- Added two-line note under the `commit` field documentation: "Replace the all-zeros placeholders below with real commit SHAs before running (e.g., `git ls-remote ...`)".

### L3 — Documented `--clone-dir` in repo-compare SKILL.md
File: `repo-compare/SKILL.md`
- Added `--clone-dir` entry to the `arguments:` frontmatter:
  - "Directory where candidate repos are cloned. Defaults to a sibling of --index-dir named 'repos'."

### L4 — Cross-skill reference now explained in landscape-compare SKILL.md
File: `landscape-compare/SKILL.md` line ~206
- Appended to the `candidates-template.yaml` reference bullet:
  "This skill reuses repo-compare's candidate schema when `--skip-discovery` is used."

### L5 — User-story count already correct
File: `_shared/README.md`
- Section "## User story coverage" already lists US-1 through US-5 (5 user stories). No "4 user stories" reference exists anywhere under `_shared/`. **No change needed.**

---

## Test results (post-fix)

### `bash _shared/tests/test-repo-compare.sh`
```
test-repo-compare: PASS
  output:          /tmp/test-repo-compare/gap-analysis.md
  candidates csv:  /tmp/test-repo-compare/index/mock-alpha.csv etc.
```
- 16 rows consolidated, 0 rejected, 0 dropped gaps.
- Determinism re-run also produced identical output.

### `bash _shared/tests/test-landscape-compare.sh`
```
test-landscape-compare: PASS
  run_dir:      /tmp/test-landscape-compare/lc_20260414_094158_atxh1x
  gamma status: eliminated (correctly eliminated)
  alpha/beta:   survived to deep-dive
```
- 8 discovery rows, 75 triage rows, 0 rejected.
- Stop-hook correctly BLOCKED while incomplete and ALLOWED after all gates met.

---

## Files modified

- `repo-compare/scripts/compare-verify.sh` (H1, H5)
- `repo-compare/SKILL.md` (L3)
- `repo-compare/references/candidates-template.yaml` (L1, L2)
- `landscape-compare/scripts/consolidator.sh` (H2, M3)
- `landscape-compare/scripts/stop-hook.sh` (H4)
- `landscape-compare/SKILL.md` (H4, M4, L4)
- `_shared/default-taxonomy.yaml` (M1)
- `_shared/lib.sh` (M5)

## Notes for next run

- H3 should be revisited only if `landscape-compare/references/shell-commands.sh` is reintroduced.
- M5's hard-gate change may surface previously-silent CI environments that lack PyYAML; install via `pip3 install pyyaml` if the gate trips.
- M3's stricter op enforcement may reject legacy JSONL that used `upsert` for `gaps` rows; this is intentional but worth flagging if older fixtures break.
