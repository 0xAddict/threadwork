# Implementation Plan

## Surface area: SKILLS (no DB, no UI, no API)
Project type: Bash + Python skill files in a Claude Code plugin directory.
Target path: `/Users/xavierandre/the-arsenal/plugin/skills/`

## Execution mode: SEQUENTIAL
Reason: 4 tasks, single surface area. No cross-deps requiring parallelization.

---

## Epic 1: Shared infrastructure (foundation for both skills)

### Task 1.1 — Default capability taxonomy [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/_shared/default-taxonomy.yaml`
**Description:** YAML file with 25 capabilities for multi-agent framework comparison. Schema: `id, category, description, grep_patterns`. Pre-seeded with the 25 from DESIGN.md v5.
**Acceptance:** Valid YAML, all 25 categories present, each has at least 3 grep patterns.
**Dependencies:** None.

### Task 1.2 — Shared bash helpers [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/_shared/lib.sh`
**Description:** macOS-compatible helpers: `du_bytes()` (uses `du -sk * 1024`), `with_timeout()` (perl alarm wrapper), `git_clone_pinned()` (clone + checkout commit), `validate_yaml()`. Sourced by both skills.
**Acceptance:** All functions tested with sample inputs. No GNU-only flags.
**Dependencies:** None.

### Task 1.3 — Shared SQLite schema [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/_shared/schema.sql`
**Description:** Findings DB schema from DESIGN.md v5 with all the v5 fixes: structured evidence (path/start_line/end_line), CHECK constraints, FK on verification_checks, UNIQUE on gaps(candidate, capability_id), capability_taxonomy table seeded from default-taxonomy.yaml.
**Acceptance:** `sqlite3 :memory: < schema.sql` succeeds.
**Dependencies:** Task 1.1 (taxonomy IDs must match).

---

## Epic 2: /repo-compare skill (lightweight, simpler — build first)

### Task 2.1 — Skill scaffold [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/repo-compare/SKILL.md`
**Description:** SKILL.md with frontmatter (description, triggers, arguments). Body explains the 3-stage pipeline: index, compare+verify, output. Explicit reference to `_shared/` for taxonomy and lib.sh.
**Acceptance:** Frontmatter valid, all required sections present.
**Dependencies:** Task 1.1, 1.2, 1.3.

### Task 2.2 — Indexing script [M]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/repo-compare/scripts/index.sh`
**Description:** Reads candidates.yaml, clones each repo (shallow, pinned to commit), runs ripgrep against each capability's grep patterns, writes results to a CSV per repo: `repo,capability_id,file,line,snippet`. Excludes test/docs/vendor patterns. Also indexes the target_repo.
**Acceptance:** Given 3 mock repos + a taxonomy, produces 4 CSVs (3 candidates + target). Each CSV has rows for matched capabilities only.
**Dependencies:** Task 1.2, 1.3.

### Task 2.3 — Compare+verify script [M]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/repo-compare/scripts/compare-verify.sh`
**Description:** Orchestrates two agent calls: (1) Comparison agent reads all CSVs + the actual code at cited lines, produces JSONL gap rows. (2) Verifier agent reads each cited file:line, confirms claim. Writes verified rows to SQLite via consolidator. Drops unverified rows.
**Acceptance:** Runs against test fixture, produces gap-analysis.md with citations.
**Dependencies:** Task 2.2.

### Task 2.4 — Candidates.yaml template [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/repo-compare/references/candidates-template.yaml`
**Description:** Annotated template showing required fields (name, url, commit, project_path) with examples. Documents how to find commit SHAs.
**Acceptance:** Valid YAML, parseable by the indexing script.
**Dependencies:** None.

---

## Epic 3: /landscape-compare skill (heavyweight — build second, reuses Epic 1+2 components)

### Task 3.1 — Skill scaffold [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/landscape-compare/SKILL.md`
**Description:** SKILL.md with frontmatter and full 8-phase pipeline description from DESIGN.md v5, generalized: replace `~/threadwork/` with `{target_repo}` parameter, add `--domain`, `--target`, `--capabilities` flags. Explicit reference to `_shared/`.
**Acceptance:** No "Threadwork" or hardcoded paths. All 8 phases documented.
**Dependencies:** Task 1.1, 1.2, 1.3.

### Task 3.2 — Init script [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/landscape-compare/scripts/init.sh`
**Description:** Creates `/tmp/landscape-compare/{run_id}/`, runs `git init` for Codex compatibility, writes state.json with absolute target_repo path, records target_repo commit SHA. macOS-compatible.
**Acceptance:** Run twice produces two distinct run_ids, state.json valid.
**Dependencies:** Task 1.2.

### Task 3.3 — Consolidator script [M]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/landscape-compare/scripts/consolidator.sh`
**Description:** Reads JSONL files from agent-output/{phase}/, validates against schema (CHECK constraints, FK refs), imports valid rows via INSERT OR REPLACE, logs rejected to .rejected.jsonl. Halts pipeline if rejection rate >20%.
**Acceptance:** Given valid JSONL imports correctly. Given invalid JSONL rejects with reason logged.
**Dependencies:** Task 1.3.

### Task 3.4 — Stop hook [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/landscape-compare/scripts/stop-hook.sh`
**Description:** Reads state.json directly (NOT env var). Allows exit if status != 'running'. Otherwise checks 5 SQL gates from DESIGN.md v5 (with the fixes: requires file_exists=1 AND content_matches_claim=1, status IN ('triaged', 'deep-dive', 'eliminated'), etc.). Exit 0 to allow, exit 2 to block.
**Acceptance:** Runs against synthetic state files, behaves correctly for each phase combination.
**Dependencies:** Task 1.3.

### Task 3.5 — Repo-compare reuse [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/landscape-compare/scripts/index.sh` (symlink or wrapper)
**Description:** Landscape-compare's triage and deep-dive phases reuse repo-compare's index.sh. Either symlink or thin wrapper. Avoid duplication.
**Acceptance:** Symlink resolves, or wrapper exec's the original.
**Dependencies:** Task 2.2.

---

## Epic 4: Tests and verification

### Task 4.1 — Test fixture (3 mock repos) [M]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/_shared/tests/fixtures/`
**Description:** 3 small synthetic "framework" repos:
- `mock-alpha/` — has memory_system + task_coordination, missing rest
- `mock-beta/` — has decision_making + agent_lifecycle, missing rest
- `mock-gamma/` — has only one capability (memory_system) — should be eliminated in landscape-compare triage
Plus a `mock-target/` — has memory_system + decisions but missing task_coordination, used as "your repo".
Each repo: 1 .ts file with clear, grep-detectable implementations of its capabilities.
**Acceptance:** Each repo has a README.md describing what it has. Files are <100 lines each.
**Dependencies:** Task 1.1 (capability IDs must match).

### Task 4.2 — Test for /repo-compare [M]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/_shared/tests/test-repo-compare.sh`
**Description:** Bash test that:
1. Generates a candidates.yaml referencing the 3 fixture repos (using local file paths, not URLs)
2. Runs `/repo-compare --target mock-target/ --candidates ./candidates.yaml --output /tmp/test-output.md`
3. Asserts output file exists
4. Asserts output contains expected gap claims (target missing task_coordination, mock-alpha has it)
5. Asserts every claim has a `[code-verified: file:line]` tag
**Acceptance:** Test passes. Re-running produces identical output.
**Dependencies:** Task 2.3, 4.1.

### Task 4.3 — Test for /landscape-compare [M]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/_shared/tests/test-landscape-compare.sh`
**Description:** Bash test that:
1. Runs `/landscape-compare --target mock-target/ --skip-discovery --candidates ./candidates.yaml --output /tmp/test-landscape.md`
2. Asserts mock-gamma was eliminated in triage (capability count <= 1)
3. Asserts output contains gaps from mock-alpha and mock-beta only
4. Asserts stop hook would correctly block exit until verification passes
**Acceptance:** Test passes. Stop hook gates work correctly.
**Dependencies:** Task 3.4, 3.5, 4.1.

### Task 4.4 — README for the skills [S]
**Surface:** SKILLS
**Output:** `/Users/xavierandre/the-arsenal/plugin/skills/_shared/README.md`
**Description:** Brief README explaining: what the two skills do, when to use which, how to invoke each, where the shared taxonomy lives, how to run the tests.
**Acceptance:** Covers all 4 user stories from PRD.
**Dependencies:** Tasks 2-3 complete.

---

## Dependency Graph

```
1.1 ─┬──> 1.3 ─┬──> 2.1 ─> 2.2 ─> 2.3
     │        │
     │        ├──> 3.1 ─> 3.2
     │        │      ├──> 3.3
     │        │      └──> 3.4
     │        │
1.2 ─┘        ├──> 3.5 (depends on 2.2)
              │
              └──> 4.1 ─┬──> 4.2 (depends on 2.3, 4.1)
                       │
                       └──> 4.3 (depends on 3.4, 3.5, 4.1)
                              │
2.4 ──> (independent, doc only)
                              │
                              └──> 4.4 (depends on 2-3 done)
```

## Execution Order (topological sort)

1. Task 1.1 — taxonomy (foundation)
2. Task 1.2 — bash helpers (foundation)
3. Task 1.3 — SQL schema (depends on 1.1)
4. Task 2.4 — candidates template (independent doc)
5. Task 2.1 — repo-compare scaffold
6. Task 2.2 — index.sh (used by both skills)
7. Task 2.3 — compare-verify.sh
8. Task 3.1 — landscape-compare scaffold
9. Task 3.2 — init.sh
10. Task 3.3 — consolidator.sh
11. Task 3.4 — stop-hook.sh
12. Task 3.5 — index.sh symlink
13. Task 4.1 — test fixtures
14. Task 4.2 — test-repo-compare
15. Task 4.3 — test-landscape-compare
16. Task 4.4 — README

## Total: 4 epics, 15 tasks (1 doc, 8 small, 6 medium)

