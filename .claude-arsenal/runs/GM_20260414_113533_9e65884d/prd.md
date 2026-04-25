# PRD — Codebase Comparison Skills

## Problem Statement

When evaluating a codebase against open-source alternatives, two failure modes dominate:

1. **README hallucination**: agents summarize marketing copy and present it as fact, leading to overstated capability claims (e.g., attributing a "learning loop" to one framework when it's a common pattern).
2. **Asymmetric depth**: the user's own codebase is read at the source level, while competitors are summarized from docs, producing biased gap analysis.

The current Threadwork comparison was built ad-hoc through 5 review cycles and is hardcoded to that one project. We need reusable, project-agnostic tooling.

## Core Functionality

Two skills with the same output contract but different approaches:

### `/landscape-compare` — Heavyweight (when you don't know what to compare against)

8-phase pipeline: discovery → clone → triage → deep-dive → synthesis → verification → review → cleanup.
Uses `/deep-research` to find candidates, scanner agents to triage, Opus agents to deep-dive.
Heavy governance (stop hooks, JSONL consolidation, sentinel rows, retry paths).
Suitable for: open-ended research, competitive landscape audits, capability mapping.

### `/repo-compare` — Lightweight (when you have a curated candidate list)

3-stage pipeline: index → compare → verify.
Reads a candidates.yaml that the user maintains manually (URLs, commit SHAs, monorepo paths).
Deterministic indexing via tree-sitter or ripgrep with structured output.
Two agents total: one comparison, one verifier.
Suitable for: targeted gap analysis, pre-known competitor list, fast iteration.

Both skills share:
- Default capability taxonomy (25 categories, overridable via config)
- Output contract: `gap-analysis.md` with `[code-verified: file:line]` or `[absent]` tags on every claim
- Same target_repo input convention
- Same SQLite findings schema (subset for /repo-compare)

## User Stories

### US-1: Run landscape comparison on any project
**As** a developer evaluating my codebase against the open-source landscape,
**I want** to invoke `/landscape-compare --target /path/to/my/repo --domain "multi-agent frameworks"`,
**So that** I get a code-verified gap analysis without manually curating competitors.

**Acceptance criteria:**
- Skill accepts `--target`, `--domain`, `--capabilities`, `--output` flags
- No Threadwork-specific paths or names in any skill file
- Discovery phase produces 8+ candidates from the web
- Output includes file:line citations for every claim
- Test fixture proves end-to-end execution

### US-2: Run targeted comparison with known candidates
**As** a developer who already knows the 5 frameworks I want to compare against,
**I want** to populate a candidates.yaml and invoke `/repo-compare`,
**So that** I skip discovery overhead and get results in <30 minutes.

**Acceptance criteria:**
- Skill reads candidates.yaml with name/url/commit/project_path entries
- Indexing uses a deterministic script (no LLM agent in the index step)
- Comparison agent produces structured table; verifier reads every citation
- Failed verifications drop the row, don't include in report
- Test fixture proves end-to-end execution

### US-3: Both skills produce identical output format
**As** a user who may run both,
**I want** the gap-analysis.md format to be identical regardless of which skill I used,
**So that** outputs are interchangeable and comparable across runs.

**Acceptance criteria:**
- Both skills write to `--output` path with the same markdown structure
- Both use `[code-verified: file:line]` and `[absent: searched]` tags identically
- Both use the same 25-capability taxonomy by default
- Both record commit SHA of target_repo for reproducibility

### US-4: Default taxonomy is overridable
**As** a user comparing in a different domain (e.g., not multi-agent frameworks),
**I want** to pass `--capabilities path/to/my-taxonomy.yaml`,
**So that** the skills aren't locked to one domain.

**Acceptance criteria:**
- Default taxonomy lives in `references/default-taxonomy.yaml` shared by both skills
- `--capabilities` flag accepts a custom taxonomy file
- Custom taxonomy validated against schema before use

### US-5: Tests prove skills execute end-to-end
**As** the maintainer,
**I want** test fixtures that exercise both skills against small synthetic repos,
**So that** I can verify the skills work without burning tokens on real comparisons.

**Acceptance criteria:**
- Test fixture under `tests/` includes 3 mock candidate repos (small, e.g. <100 lines each)
- Test runs `/repo-compare` against the fixture and asserts gap-analysis.md is produced with expected citations
- Test runs `/landscape-compare` in `--skip-discovery` mode against the same fixture
- Tests pass deterministically (same input → same output)

## Scope Boundaries

### In scope
- Two skills under `/Users/xavierandre/the-arsenal/plugin/skills/`
- Shared default taxonomy
- SKILL.md, scripts/, references/ for each
- Test fixtures with synthetic repos
- macOS-compatible bash (no `du -sb`, no `timeout`)
- SQLite schema for findings (with the v5 fixes: structured evidence, FK constraints, etc.)
- Stop hook for `/landscape-compare` (state-conditional)

### Out of scope
- Discovery-mode for `/repo-compare` (it requires manual curation by design)
- Real-world Threadwork comparison run (separate task)
- UI / dashboard for results
- Cross-skill state sharing (each run is independent)
- Multi-language indexer support beyond TypeScript/JavaScript/Python (extensions later)

## Technical Constraints

- macOS Darwin compatibility (no GNU-only flags)
- Bash + sqlite3 + jq + git as the only required system tools
- Optional: ripgrep for indexing speed
- No external API keys required (uses Claude Code agent infrastructure)
- Output paths default to `/tmp/landscape-compare/` and `/tmp/repo-compare/` (overridable)
- Skills must work without OpenRouter/Codex (those are optional gates)

## Acceptance Verification (gates the close phase)

- All 5 user stories have at least one passing test
- `/alpha-verify` returns PASS verdict from contract.json
- Both skill directories exist with SKILL.md, scripts/, references/
- Test fixture run produces deterministic gap-analysis.md
- No references to "Threadwork" or "/Users/xavierandre/threadwork" in any skill file

