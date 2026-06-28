# P3 — Curated Delegation Briefs Frontier-Alignment Spec

| Field | Value |
|-------|-------|
| Spec | P3 "curated delegation briefs" frontier-alignment |
| Task | #10060822 (Stage-1 spec child) |
| Parent umbrella | #10060787 (align threadwork to 2026 frontier best-practices) |
| Prior sibling | P0 retrieval (#10060788) — CLOSED (GAP-1..5 shipped; GAP-3 reranker closed-not-built, GAP-5 auto-closed) |
| Date | 2026-06-28 |
| Author | kiera (build sub-agent) |
| Stage | STAGE 1 — spec-lock (design only, no implementation) |
| Status | DRAFT — awaiting Boss/Gwei spec-lock review (FIRST gate) |

---

## 1. Benchmark statement (READ-THIS-FIRST — guardrail)

**Benchmarked against the actual REMOTE `origin/main`, not a local working copy.**

- Canonical repo on disk: `/Users/coachstokes/.claude/mcp-servers/task-board`
  (remote `origin` = `https://github.com/0xAddict/threadwork.git`).
- `git fetch --all` was run before any current-state claim below.
- **Resolved `origin/main` HEAD = `10929bd024ea731a64d51a000d5491816c53721e` (`10929bd`)** — exactly the
  SHA Boss expected (the P0 retrieval work was pushed today). This run the local working tree is ALSO
  clean at `10929bd` (not stale), but **every current-state verdict in §4 is still cited from REMOTE**
  via `git show origin/main:<file>` line numbers, NOT the working tree.

**Why this matters (the v1 trap):** v1 of the umbrella's spec work read a ~60-commit-stale LOCAL copy
and shipped 5 wrong current-state verdicts. The *source brief itself* (`brief-v2-threadwork.md`, run
`dr-20260624-115611-46384`) benchmarked `origin/main @ 93c40fc`. Since then `#10060784` (BM25 + query-aware
boot) and the full P0 hybrid-retrieval workstream have landed and `origin/main` advanced to `10929bd`.
**This spec re-verified the brief's P3 premise against `10929bd` and it STILL HOLDS** (see §4): `delegate_task`
still ships only a free-text `description` string — the delegation-brief gap is real and unclosed at current
remote, not a stale-state artifact.

> Working-tree note: `specs/` exists at `origin/main` and already contains
> `specs/P0-retrieval-frontier-alignment.md` and `specs/GAP-4-recall-precision-benchmark.md`. This file
> (`specs/P3-delegation-briefs-frontier-alignment.md`) is NEW and left uncommitted on disk for the human
> spec-lock gate. No `.gitignore` rule excludes `specs/`.

---

## 2. Frontier target (what 2026 best-practice for "delegation context" is)

**Sources:** `brief-v2-threadwork.md` (deep-research run `dr-20260624-115611-46384`) and its deployed
rendering at https://frontier-catchup-am8.netlify.app (React SPA; the brief findings ship verbatim in the
body bundle `/assets/index-BKT9VGF_.js`). Both agree.

### 2.1 The brief's P3 recommendation (bundle, verbatim)

> **id: P3 · axis: orchestration · verdict: ADD · effort: S**
> **title:** "Curated delegation briefs (not full-context inheritance)"
> **evidence:** "Full-context inheritance (84%) is empirically WORSE than no context (86%); curated/filtered
> context reaches 96%. Passing the Boss's whole context window to a sector owner actively hurts."
> **implementation:** "Boss generates a task-specific filtered brief before delegation — a subset of
> relevant facts, not the full context dump. Bookend the critical content (start/end), never bury it."
> **source:** "arXiv:2602.03786 (AOrchestra)"

Supporting brief lines (bundle, verbatim):
> "curated delegation briefs (delegate_task ships only a free-text string)" — listed under REAL REMAINING
> GAPS, code-confirmed on the remote.
> "briefs — the delegator passes a filtered brief, not just a free-text task string."
> "briefs must bookend critical content, never bury it." (anti "lost-in-the-middle")

### 2.2 Honesty caveat carried from the brief

The 84% / 86% / 96% figures come from **AOrchestra (arXiv:2602.03786)**, a different orchestration system.
The brief itself flags: *"the domain-transfer claim is an extrapolation, numbers are real."* So the
**direction** (curated/filtered > free-text-thin, and curated >> full-context-dump) is the validated target;
the **exact uplift on threadwork is not guaranteed** and motivates a measure-first stance (see §6 PC-6, §9 OQ-3).

### 2.3 Frontier target, distilled

At delegation time, the delegator hands the delegatee a **task-specific, curated, filtered brief** — a
bounded subset of the relevant facts (relevant memories, parent/sibling task context, hard constraints) —
**bookended** (most-critical content at the start AND end, never buried mid-stream). It is:
1. **Curated/filtered**, NOT a full-context dump (full-context inheritance is empirically worse than nothing).
2. **NOT** merely the current thin free-text `description` string.
3. **Bookended** to defeat lost-in-the-middle.
4. **Built on P0's already-shipped `recall()`** (BM25 hybrid) as the relevance primitive that selects the subset.

---

## 3. Scope

**In scope (P3):** a curated/filtered delegation-brief mechanism on the `delegate_task` path — brief
assembly (relevance-filtered subset selection), bookended structure, a size/budget cap, persistence, and
surfacing of the brief to the delegatee, plus the anti-full-context-dump guard. Backward-compatible and
additive behind the existing `delegate_task` tool.

**Explicitly OUT of scope for P3** (separate umbrella children — do not build here):
- Semantic-shift-triggered mid-session consolidation → **P2** (semantic-consolidation).
- Pre-summarization sanitization / anti memory-laundering → **P4** (sanitization).
- Concurrent-write ordering + directed messaging → **P5** (provenance already exists).
- Typed failure classification / cross-family critique / ternary rewards → **P6/P7/P8** (verification axis).
- The "DG1 gate-the-critic" / "DG2 mask-recycle" defense items (work-order shorthand) → their own children.
- Retrieval-stack changes — **P0 is CLOSED**; P3 *consumes* `recall()`, it does not modify it.

---

## 4. Current state at `origin/main` (`10929bd`) — evidence-based, file:line cited

| # | Capability | Current state at `10929bd` | Evidence (`git show origin/main:<file>`) |
|---|-----------|----------------------------|------------------------------------------|
| C1 | `delegate_task` tool surface | Inputs: `to`, `description`, `priority`, `parent_task_id`, `heartbeat_timeout_sec`, `progress_timeout_sec`. Required: `[to, description]`. **No brief / facts / context field.** | `server.ts:122-135` |
| C2 | `delegate_task` handler | Reads only `to/description/priority/parent/timeouts`; passes the bare `description` to `db.delegateTask`; nudges the delegatee `"You have a new delegated task (#id) from X. Run list_tasks(filter='mine') for details."` — **no curated facts handed over.** | `server.ts:734-790` |
| C3 | `db.delegateTask` persistence | `INSERT INTO tasks (from_agent, to_agent, description, priority, supervisor_agent, kind, parent_task_id, …timeouts, next_check_at)`. **Stores the `description` string only; no brief/relevant-facts column.** | `db.ts:1105-1149` |
| C4 | What the delegatee actually gets | The free-text `description` via `list_tasks`, plus their OWN `get_boot_briefing` (query/task-aware post-P0). That is the **delegatee re-deriving context from its own memories**, NOT a delegator-curated brief. | `server.ts:1044-1096`; `getBootBriefing` `memory.ts:430-519` |
| C5 | Adjacent "brief"-named systems (NOT delegation briefs) | (a) `get_boot_briefing` = boot context. (b) `get_decision_brief` = council positions/critiques for an OPEN decision (`decision.ts`). (c) `debrief.ts` / `forceDebrief` = POST-HOC session summary of *completed* tasks → memory (Gather/Solicit/Synthesize/Persist). **None curates a pre-delegation filtered brief for the delegatee.** | `server.ts:249,489,513`; `debrief.ts:1-6`; `decision.ts` |
| C6 | Relevance primitive available (P0, SHIPPED) | `recall()` BM25 hybrid retrieval + query/task-aware boot landed in P0 (`#10060784` and the GAP-1..5 workstream). This is the selection primitive a delegation brief should USE to pick the relevant subset. | `memory.ts` `recall` (`:263`), `recallBm25` (`:310`) |

**Bottom line on current state:** the brief's P3 premise — *"delegate_task ships only a free-text string"* —
is **STILL TRUE at `10929bd`**. There is no delegator-curated, relevance-filtered, bookended brief on the
delegation path. The delegatee gets a thin string and is left to re-derive its own context. P3 is **0% closed**.
P0's `recall()` (C6) is the one piece P3 can lean on.

---

## 5. Gap analysis (delta: frontier target §2 vs current state §4)

| Gap | Frontier wants (§2) | Current (§4) | Severity |
|-----|---------------------|--------------|----------|
| **GAP-1 No brief at delegate time** | Delegator hands over a task-specific curated brief. | Bare `description` string + delegatee self-derives boot context (C1-C4). | P3 — core |
| **GAP-2 No curation/filtering logic** | "A subset of relevant facts, not the full context dump." | Nothing selects the relevant subset for a delegation. | P3 — core (consumes P0 `recall()`) |
| **GAP-3 No bookending structure** | "Bookend the critical content (start/end), never bury it." | N/A — there is no brief to structure. | P3 |
| **GAP-4 No persistence/surfacing** | Brief travels with the task and is visible to the delegatee at claim/boot. | No brief column/finding; `list_tasks` shows only `description` (C3). | P3 |
| **GAP-5 Anti-pattern guard** | Curated/filtered ONLY — full-context inheritance is empirically WORSE (84% < 86%). | No guard (nothing stops a future "dump my whole context" impl). | P3 — guardrail |
| **GAP-6 No measure on threadwork** | Validate the curated > thin (and curated >> full-dump) direction holds here. | AOrchestra numbers are an extrapolation (§2.2). | P3 — measure-first (see OQ-3) |

(6 gaps; GAP-6 is a measure/verification gap, not a build item — it gates how heavily GAP-1..5 are built.)

---

## 6. Proposed changes (design only — no implementation in Stage 1)

Design principle: **additive and backward-compatible behind the existing `delegate_task` tool and
`db.delegateTask` method.** A delegation with no brief must behave byte-for-byte as it does at `10929bd`.
Reuse P0's `recall()` as the relevance seam; do NOT modify the retrieval stack.

- **PC-1 (→GAP-2,GAP-3) Brief assembly.**
  - New `assembleDelegationBrief(from, to, taskDescription, parentTaskId?)` → a curated, bookended brief
    string. Source material: (a) P0 `recall()` keyed on the task description → top-N relevant memories
    (filtered by relevance + a hard count/byte cap); (b) parent-task context (parent `description`/`result`
    + sibling findings via `read_findings`) when `parent_task_id` is set; (c) explicit hard constraints/DO-NOTs.
  - **Bookend:** emit the most-critical facts at BOTH the head and tail of the brief; lower-salience facts in
    the middle (anti lost-in-the-middle).

- **PC-2 (→GAP-1) `delegate_task` surface.**
  - Add an OPTIONAL `brief` input (delegator-supplied curated facts) AND/OR auto-assemble via PC-1 when not
    supplied (behind a default-OFF feature flag until GAP-6 measures it). `description` stays required;
    `brief` is purely additive. Decision on auto-vs-explicit → OQ-1.

- **PC-3 (→GAP-4) Persistence.**
  - Persist the brief so it is durable and auditable: either a new nullable `tasks.delegation_brief` column
    (migration + guarded `db.ts` block, same discipline as P0's migrations) OR a linked finding/artifact on
    the task. Shape → OQ-4.

- **PC-4 (→GAP-4) Surfacing to the delegatee.**
  - The delegatee sees the brief at `claim_task` / `list_tasks` / boot, rendered bookended. Extend the
    delegation nudge and/or `list_tasks` detail to include (or point to) the brief instead of only
    `"Run list_tasks for details."`

- **PC-5 (→GAP-5) Anti-full-dump guard.**
  - Enforce a size/relevance cap and an explicit code-level guard + test that the brief is a *filtered subset*,
    never the delegator's full context window. Full-context inheritance is explicitly forbidden.

- **PC-6 (→GAP-6) Measure-first verdict (lightweight).**
  - Before (or alongside) productionizing PC-1..5, run a small, out-of-tree measurement of whether a curated
    brief improves delegatee outcomes vs free-text-only vs full-dump on a threadwork delegation sample —
    mirroring the P0/GAP-4 measure-first precedent (council #10060795). If the threadwork signal is immaterial,
    recommend the *minimal* slice (explicit-`brief` param only, no auto-assembly). Scope of this measure → OQ-3.

**Do NOT add:** semantic-shift consolidation (P2); sanitization (P4); write-ordering/messaging (P5); any
change to `recall()` / the retrieval stack (P0 is closed).

---

## 7. Acceptance criteria / full-checklist verification

A later builder may mark P3 complete only when ALL of the following are evidence-checked:

- [ ] **AC-1** `git fetch origin` re-run; current-state re-confirmed against the then-current `origin/main`
      SHA (re-verify `delegate_task` has not gained a brief field since `10929bd` in a way that changes §4).
- [ ] **AC-2** `assembleDelegationBrief()` returns a **filtered subset** (count + byte capped), NOT a full dump; verified by test.
- [ ] **AC-3** Brief relevance selection routes through P0 `recall()` (no new/duplicate retrieval path); verified by test.
- [ ] **AC-4** Bookending verified: most-critical facts appear at head AND tail of the rendered brief.
- [ ] **AC-5** Backward-compat: `delegate_task` with no `brief` (and auto-assembly OFF) produces byte-for-byte
      identical task rows + nudge as `10929bd`.
- [ ] **AC-6** Delegatee surfacing: a delegated task's brief is visible to the delegatee at claim/list/boot; verified end-to-end.
- [ ] **AC-7** Persistence + audit: the brief is stored durably (column or linked finding) and audit-logged.
- [ ] **AC-8** Anti-full-dump guard test: an attempt to pass the delegator's full context is rejected/capped.
- [ ] **AC-9** Scope guard: no P2/P4/P5/P6-P8 code and no `recall()`/retrieval changes crept in.
- [ ] **AC-10** Board + dashboard updated; spec referenced from the umbrella; PR opened only at the pre-deploy gate (§8).
- [ ] **AC-11** GAP-6 measure-first verdict delivered (curated vs thin vs full-dump on a threadwork sample),
      with the build-scope recommendation it implies (minimal vs full auto-assembly).

---

## 8. Run-config to honor

- **Execution model:** Stage-and-Gate. This document is **Stage 1 (spec-lock)** output only.
- **Verification:** full-checklist (§7), not spot-check.
- **Persistence:** board writes + dashboard mirror for all progress and any measurement artifacts.
- **Specs location:** `/specs` (this file: `specs/P3-delegation-briefs-frontier-alignment.md`).
- **Budget:** unlimited.
- **Human checkpoints — two Boss-gated gates:**
  1. **Spec-lock (FIRST / current gate):** Boss + Gwei review and lock THIS spec before any build.
  2. **Pre-deploy (SECOND gate):** Boss-only gate before shipping (Boss holds the deploy perms). No deploy without it.
- **Ownership:** kiera = builder/driver (writes spec to `/specs`, builds staged-and-gated). Boss = umbrella
  #10060787 owner + both human-checkpoint gates.
- **Commit discipline:** Stage 1 leaves this spec uncommitted on disk; Boss decides commit/PR at spec-lock.

---

## 9. Open questions for Boss/Gwei spec-lock review

- **OQ-1 (auto vs explicit brief):** Should the brief be (a) an OPTIONAL delegator-supplied `brief` param,
  (b) auto-assembled via PC-1, or (c) both with auto-assembly behind a default-OFF flag? (This spec assumes
  (c), defaulting to safe/minimal until GAP-6 measures the threadwork uplift.)
- **OQ-2 (who curates):** The brief says *"Boss generates"* the brief. threadwork delegations are mostly
  Boss→worker, but workers also delegate one-shot sub-agents. Apply P3 to all delegators, or Boss-path first?
- **OQ-3 (measure-first scope):** The 84/86/96 numbers are AOrchestra (arXiv:2602.03786), an
  acknowledged domain-transfer extrapolation (§2.2). Run a small measure-first study (curated vs free-text vs
  full-dump on a threadwork delegation sample) BEFORE the full build, per the P0/GAP-4 precedent and council
  #10060795? Or accept the directional evidence and build the minimal slice directly?
- **OQ-4 (storage shape):** New nullable `tasks.delegation_brief` column vs a linked finding/artifact on the task?
- **OQ-5 (budget/format):** Token/byte budget and exact bookended layout for the brief (head-critical /
  middle-context / tail-critical)?
- **OQ-6 (overlap with P0 boot):** The delegatee already gets a query/task-aware boot briefing (P0). Is the
  delegation brief purely additive, or does it partly overlap boot-briefing memory injection (risking
  double-injection)? Define the boundary.
- **OQ-7 (sequencing + benchmark pointer):** The brief lists P2 (consolidation) before P3 and has no P1, but
  the work order intentionally sequences P3 next after P0 (Gwei TG 7395: "move through the GAP implementation
  plan"). Confirm P3-first is intended. And — echoing P0 OQ-1 — should the umbrella benchmark pointer be
  advanced to `10929bd` so later children stop re-deriving stale current-state verdicts?

---

*End of P3 delegation-briefs frontier-alignment spec — Stage 1 (spec-lock). No implementation performed.*
