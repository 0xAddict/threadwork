# P0 — Retrieval Frontier-Alignment Spec

| Field | Value |
|-------|-------|
| Spec | P0 "retrieval" frontier-alignment |
| Task | #10060788 |
| Parent umbrella | #10060787 (align threadwork to 2026 frontier best-practices) |
| Date | 2026-06-26 |
| Author | kiera (build sub-agent) |
| Stage | STAGE 1 — spec-lock (design only, no implementation) |
| Status | DRAFT — awaiting Boss/Gwei spec-lock review (FIRST gate) |

---

## 1. Benchmark statement (READ-THIS-FIRST — guardrail)

**Benchmarked against the actual REMOTE `origin/main`, not a local working copy.**

- Canonical repo on disk: `/Users/coachstokes/.claude/mcp-servers/task-board`
  (remote `origin` = `https://github.com/0xAddict/threadwork.git`).
- `git fetch origin` was run before any current-state claim below.
- **Resolved `origin/main` HEAD = `7bf465b341b50cc3d1051d66aa2ac6edca3b2f92`** (`7bf465b`).
- **This is NOT `93c40fc`.** `origin/main` has **moved one commit PAST** the umbrella
  benchmark `93c40fc`. The extra commit is the retrieval work itself:

```
$ git log --oneline 93c40fc..origin/main
7bf465b feat(memory): BM25 + query/task-aware recall and boot briefing (#10060784)

$ git merge-base --is-ancestor 93c40fc origin/main && echo ancestor
ancestor                         # 93c40fc IS an ancestor of origin/main

$ git rev-parse origin/main
7bf465b341b50cc3d1051d66aa2ac6edca3b2f92
```

**Why this matters (this is the v1 trap):** v1 of this work read a ~60-commit-stale
LOCAL copy and shipped 5 wrong current-state verdicts. The *source brief itself*
(`brief-v2-threadwork.md`, run `dr-20260624-115611-46384`) was written benchmarking
`origin/main @ 93c40fc`, where retrieval was still keyword `LIKE %token%` + a query-blind
boot briefing. **Commit `#10060784` has since landed on `origin/main` and already closed
the BM25 + query/task-aware-boot portion of P0.** Therefore the brief's "current state"
description is now STALE, and this spec corrects it against `7bf465b`. All current-state
claims in §4 cite `git show origin/main:<file>` line numbers, NOT the working tree.

> Working-tree note: local `HEAD` == `7bf465b` == `origin/main` (clean except two unrelated
> `.harness/sprints/*/status.txt` edits). `specs/` does not yet exist at `origin/main`; this
> file creates it. No `.gitignore` rule excludes `specs/`.

---

## 2. Frontier target (what 2026 best-practice for "retrieval" is)

**Sources:** `brief-v2-threadwork.md` (deep-research run `dr-20260624-115611-46384`) and its
deployed rendering at https://frontier-catchup-am8.netlify.app (the site is a React SPA whose
body bundle `/assets/index-BKT9VGF_.js` carries the brief's findings verbatim). Both agree.

### 2.1 The headline (frontier-catchup site, section "Memory Architecture — the TF-IDF Cargo-Cult and What Replaces It")

> **"Hybrid BM25 + Dense + Reranker is the validated standard."**

Recommended P0 retrieval pipeline (brief, verbatim):

> "BM25 (immediate, pure-Python, no GPU) over the memories table → BGE-small dense →
> cross-encoder reranker, fused via RRF. AND make `get_boot_briefing` query/task-aware
> instead of returning the same top-5. threadwork `memory.ts:195–268`."
>
> Phasing: "Add BM25 over threadwork.memories (pure-Python) AND make `get_boot_briefing`
> query/task-aware. **Benchmark recall vs the current LIKE baseline.**" → then "Add BGE-small
> dense + reranker (RRF) to memory."

### 2.2 Supporting evidence cited by the brief/site

- BM25 R@5 = 0.644 vs Dense R@5 = 0.587 — **dense ALONE is worse than BM25** (so lexical-first
  is correct; dense is additive, not a replacement).
- Cross-encoder reranker on a **hybrid BM25+dense RRF** fusion: **+17.2pp MRR@3** (0.433 → 0.605).
- Mem0 multi-signal: LoCoMo 92.5 / LongMemEval 94.4; +29.6pp temporal, +23.1pp multi-hop over
  keyword-only (arXiv:2604.01733).
- MemTier (arXiv:2605.03675): the binding constraint is **retrieval quality, not window size** —
  BM25 R@2 = 0.038 for multi-session queries → 96% of correct answers are not in the top-2.
- Oracle injection raises accuracy 0.180 → 0.550 → **+57% accuracy headroom attributable to
  retrieval architecture.**
- **HyDE is counterproductive** for agent memory (explicitly do not add it).
- "Papers unanimously require dense retrieval" — dense is a required channel, not optional.
- Ceiling nuance: "0.180 is a fundamental limit even with perfect memory" — retrieval cannot fix
  questions whose answer was never stored; this bounds the expected uplift and motivates an
  honest eval baseline rather than a hill-climb to 1.0.

### 2.3 Frontier target, distilled

A three-channel hybrid retrieval stack behind the existing `recall()` interface:
1. **Lexical** — BM25 (✅ already shipped as FTS5).
2. **Dense** — BGE-small embeddings over memory content, ANN/cosine candidate generation.
3. **Fusion** — Reciprocal Rank Fusion (RRF) of lexical + dense candidate lists.
4. **Rerank** — cross-encoder reranker over the fused candidate window (final ordering).
5. **Query/task-aware boot** — `get_boot_briefing` selects memories by relevance to the active
   task/query (✅ already shipped, currently lexical-only).
6. **Eval** — a recall-quality benchmark proving hybrid > BM25 > LIKE on the threadwork memory corpus.

---

## 3. Scope

**In scope (P0):** dense retrieval channel, RRF fusion, cross-encoder reranker, a recall-quality
benchmark vs the LIKE/BM25 baselines, and routing the query-aware boot briefing through the
upgraded hybrid stack.

**Explicitly OUT of scope for P0** (separate umbrella children — do not build here):
- Semantic-shift-triggered mid-session consolidation → **P2** (semantic-consolidation).
- Pre-summarization sanitization / anti memory-laundering → **P4** (sanitization).
- Memory-type taxonomy (working/episodic/semantic/procedural) namespace tagging → future.
- Per-agent namespace scoping / write-queue serialization (cross-agent contamination) → DG-family.

---

## 4. Current state at `origin/main` (`7bf465b`) — evidence-based, file:line cited

> Authoritative runtime file is the **top-level** `memory.ts` (server.ts:27 `import { MemoryDB }
> from './memory'`). A near-duplicate `mcp-servers/task-board/memory.ts` exists as the
> `system/` namespace backup capture (#10060759); the two DIFFER, so the nested copy is a parity
> artifact, NOT the running code — all citations below are the top-level file at `origin/main`.

| # | Capability | Current state at `7bf465b` | Evidence (`git show origin/main:<file>`) |
|---|-----------|----------------------------|------------------------------------------|
| C1 | Retrieval interface | `recall()` is a swappable router: FTS5 BM25 path when a sanitized MATCH expr + `memories_fts` exist, else LIKE fallback. | `memory.ts:263-287` (`recall`), alias `recallMemories` `memory.ts:289-291` |
| C2 | **Lexical / BM25 (SHIPPED)** | FTS5 BM25 retrieval with a 4-signal blend re-rank. | `memory.ts:310-372` (`recallBm25`); weights `memory.ts:67-72` `{bm25:0.6, quality:0.2, importance:0.15, recency:0.05}` |
| C3 | FTS index | `memories_fts` FTS5 external-content vtable (`tokenize='unicode61 remove_diacritics 2'`) + AI/AD/AU sync triggers + one-time backfill. | `db.ts:919-970` (Migration 0014); parity doc `migrations/0014_memory_fts.sql` |
| C4 | Query sanitization | `sanitizeFtsQuery()` double-quotes tokens to survive tag/ID-heavy content. | `memory.ts:228` |
| C5 | LIKE fallback (pre-0014) | `LIKE %token%` ranked `quality DESC, importance DESC, last_accessed DESC`; used for category-only/empty-MATCH/pre-0014 DBs. | `memory.ts:374-401` (`recallLike`) |
| C6 | **Query/task-aware boot (SHIPPED)** | `getBootBriefing(agent, taskDb, query?)`: explicit query → active-task description → `agent_sessions.current_task_id`; fills `relevantMemories` (RELEVANT_LIMIT=5) via `recall()`; byte-for-byte backward-compatible `[]` when no query. | `memory.ts:430-519`; tool wiring `server.ts:145,337-338` |
| C7 | `recall_memories` tool | Exposed; routes through `recall()`. | `server.ts:236, 1009-1014` |
| C8 | **Dense embeddings** | **ABSENT.** No BGE/embedding/vector/cosine/ANN code. | `git grep -iE 'dense\|bge\|embedding\|cosine\|vector\|onnx\|sentence-transformer' origin/main -- '*.ts' '*.sql'` → **empty** |
| C9 | **Cross-encoder reranker** | **ABSENT.** | `git grep -iE 'rerank\|cross-?encoder' origin/main` → **empty** |
| C10 | **RRF fusion** | **ABSENT.** Single-channel only. | `git grep -iE 'RRF\|reciprocal' origin/main` → **empty** |
| C11 | Recall-quality benchmark | **ABSENT.** No eval harness comparing LIKE vs BM25 vs hybrid on the memory corpus. | no `*recall*bench*` / eval target in `git ls-files`; `tests/memory.test.ts` covers correctness, not retrieval quality |

**Bottom line on current state:** The brief's premise ("recall is `LIKE %token%`, boot is
query-blind") was true at `93c40fc` but is **STALE at `7bf465b`**. P0 is **already ~50% closed**:
the lexical (BM25) channel and the query/task-aware boot both shipped in `#10060784`. What remains
is the **dense + fusion + rerank** half of the frontier "hybrid" target, plus the benchmark the
brief explicitly demands.

---

## 5. Gap analysis (delta: frontier target §2 vs current state §4)

| Gap | Frontier wants (§2) | Current (§4) | Severity |
|-----|---------------------|--------------|----------|
| **GAP-1 Dense channel** | BGE-small dense retrieval over memory content (required, not optional). | None (C8). | P0 — core of the "hybrid" target |
| **GAP-2 RRF fusion** | RRF fusion of lexical + dense candidate lists. | Single lexical channel only (C10). | P0 — prerequisite for the +17.2pp reranker gain |
| **GAP-3 Cross-encoder reranker** | Cross-encoder rerank of the fused window (the +17.2pp MRR@3 driver). | None (C9). | P0 |
| **GAP-4 Recall benchmark** | "Benchmark recall vs the current LIKE baseline" — measurable proof hybrid > BM25 > LIKE. | None (C11). | P0 — gates whether GAP-1..3 actually help vs the 0.180 ceiling |
| **GAP-5 Boot on hybrid** | Query-aware boot selecting via the *hybrid* stack. | Boot is query-aware but relevance runs on **BM25-only** `recall()` (C6). | P1 — auto-closes once GAP-1..3 land behind `recall()` |

(5 gaps; GAP-5 is partial/derivative — it inherits the upgrade for free once the hybrid stack
lives behind the existing `recall()` interface.)

---

## 6. Proposed changes (design only — no implementation in Stage 1)

Design principle: **keep the existing `recall()` router (`memory.ts:263`) as the single seam.**
Everything is additive behind it, mirroring how `#10060784` slotted BM25 in with a LIKE fallback.
No external GPU/service dependency; degrade gracefully to today's BM25 path when embeddings/model
are unavailable (same try/catch-to-fallback pattern as `recall()` today).

- **PC-1 (→GAP-1) Dense channel.**
  - New `migrations/0015_memory_embeddings.sql` + `db.ts::migrate()` guarded block: a
    `memory_embeddings` table (`memory_id` FK, `vec` BLOB, `model` text, `dim` int, `updated_at`),
    kept in sync by the same AI/AD/AU trigger discipline as `memories_fts`, plus one-time backfill.
  - Embedding provider: **BGE-small** via a pure-CPU local runtime (e.g. ONNX/`fastembed`-class,
    no GPU) so it runs in the bun MCP process. Pin model id + dim; record both per row for
    re-embed safety. Candidate generation by cosine over the stored vectors (brute-force is fine
    at threadwork's memory-row scale; ANN only if row count demands it — flag as open question).
  - New private `recallDense(db, agent, filter, limit)` returning a ranked candidate list, same
    agent/shared/state filters as `recallBm25`.

- **PC-2 (→GAP-2) RRF fusion.**
  - New private `fuseRrf(lexicalList, denseList, k=60)` implementing standard RRF
    (`score = Σ 1/(k + rank_i)`). `recall()` gains a `hybrid` path: run `recallBm25` (candidate
    window) + `recallDense` (candidate window), fuse, then hand the fused window to PC-3.
  - Preserve current behavior exactly when dense is unavailable (fall back to BM25-only, then LIKE).

- **PC-3 (→GAP-3) Cross-encoder reranker.**
  - New private `rerankCrossEncoder(query, candidates, limit)` scoring each (query, content) pair
    with a small CPU cross-encoder; final ordering = reranker score. Reranker operates only on the
    fused top-N window (e.g. N=50, matching the existing `candidateWindow = max(limit*5,50)` at
    `memory.ts` recallBm25) to bound cost. Bypass + log-and-fall-back to the RRF order on any model
    error (same defensive pattern as the BM25→LIKE degrade).
  - Net `recall()` order of preference: **hybrid(rerank(RRF(BM25, dense)))** → RRF(BM25,dense) →
    BM25 → LIKE.

- **PC-4 (→GAP-4) Recall-quality benchmark.**
  - New `scripts/recall_bench.ts` (or `tests/recall_bench.test.ts`) building a small labeled
    query→expected-memory set from the live `memories` corpus, reporting **R@2/R@5 and MRR@3**
    for LIKE, BM25-blend, and hybrid+rerank, written to `artifacts/` and mirrored to the dashboard.
    Acceptance is a *relative* improvement (hybrid ≥ BM25 ≥ LIKE), acknowledging the 0.180
    perfect-memory ceiling rather than chasing an absolute number.

- **PC-5 (→GAP-5) Boot inherits hybrid.**
  - No code change beyond PC-1..3: `getBootBriefing` already calls `recall()` (`memory.ts:~497`),
    so the hybrid upgrade flows through automatically. Add one boot-briefing benchmark row to PC-4
    to prove the boot `relevantMemories` improved.

- **PC-6 Parity.**
  - Decide & document whether the `system/` backup copy `mcp-servers/task-board/memory.ts` must be
    re-synced (open question OQ-4).

**Do NOT add:** HyDE (brief: counterproductive for agent memory); semantic-shift consolidation
(P2); sanitization (P4).

---

## 7. Acceptance criteria / full-checklist verification

A later builder may mark P0 complete only when ALL of the following are evidence-checked:

- [ ] **AC-1** `git fetch origin` re-run; current-state re-confirmed against the then-current
      `origin/main` SHA (re-verify it has not moved past `7bf465b` in a way that changes §4).
- [ ] **AC-2** Dense channel: `memory_embeddings` table + migration `0015` + guarded `db.ts`
      block + sync triggers + backfill exist and apply idempotently on a fresh and an existing DB.
- [ ] **AC-3** `recallDense()` returns correct agent/shared/state-filtered candidates; verified by test.
- [ ] **AC-4** `fuseRrf()` implements standard RRF; unit test on a hand-checked fixture.
- [ ] **AC-5** `rerankCrossEncoder()` reorders the fused window; bypasses + logs on model error
      without failing `recall()`.
- [ ] **AC-6** `recall()` preference chain proven by test: hybrid → RRF → BM25 → LIKE, each
      degrade path exercised (dense unavailable, FTS unavailable, empty/category-only query).
- [ ] **AC-7** Backward-compat: with dense/model disabled, `recall()` and `getBootBriefing()`
      output is byte-for-byte identical to `7bf465b` (the `#10060784` guarantee is preserved).
- [ ] **AC-8** Benchmark (PC-4) run on the live memory corpus shows **hybrid ≥ BM25 ≥ LIKE** on
      R@2/R@5/MRR@3; numbers written to `artifacts/` and mirrored to the dashboard.
- [ ] **AC-9** Boot briefing `relevantMemories` benchmark row shows improvement vs BM25-only.
- [ ] **AC-10** No GPU/external-service hard dependency; cold start works on the MCP host CPU; the
      MCP server still boots if the embedding model is absent.
- [ ] **AC-11** No new HyDE / consolidation / sanitization code crept in (scope guard).
- [ ] **AC-12** `system/`-namespace `memory.ts` parity resolved per OQ-4.
- [ ] **AC-13** Board + dashboard updated; spec referenced from the umbrella; PR opened only at the
      pre-deploy gate (§8).

---

## 8. Run-config to honor

- **Execution model:** Stage-and-Gate. This document is **Stage 1 (spec-lock)** output only.
- **Verification:** full-checklist (§7), not spot-check.
- **Persistence:** board writes + dashboard mirror for all progress and benchmark artifacts.
- **Specs location:** `/specs` (this file: `specs/P0-retrieval-frontier-alignment.md`).
- **Budget:** unlimited.
- **Human checkpoints — two Boss-gated gates:**
  1. **Spec-lock (FIRST / current gate):** Boss + Gwei review and lock THIS spec before any build.
  2. **Pre-deploy (SECOND gate):** Boss-only gate before shipping (Boss holds the Netlify/Vercel/
     Shopify deploy perms). No deploy without it.
- **Ownership:** kiera = builder/driver (writes spec to `/specs`, builds staged-and-gated). Boss =
  umbrella #10060787 owner + both human-checkpoint gates.
- **Commit discipline:** Stage 1 leaves this spec uncommitted on disk (repo does not auto-track
  `specs/`); Boss decides commit/PR at spec-lock.

---

## 9. Open questions for Boss/Gwei spec-lock review

- **OQ-1 (benchmark divergence):** The umbrella benchmark is `93c40fc`, but real `origin/main` is
  `7bf465b` and **already contains the BM25 + query-aware-boot half of P0**. Confirm P0's remaining
  scope is the **dense + RRF + reranker + benchmark** half (this spec assumes yes). Should the
  umbrella benchmark pointer be advanced to `7bf465b` to stop other children re-deriving stale
  "system lacks BM25" verdicts?
- **OQ-2 (dense runtime):** Approve a pure-CPU local embedding runtime (ONNX/fastembed-class
  BGE-small) inside the bun MCP process? Any objection to adding that dependency vs the current
  zero-ML-dep footprint? Hard constraint that the server must still boot with the model absent?
- **OQ-3 (reranker cost):** Cross-encoder rerank adds per-recall latency. Acceptable on the hot
  `recall_memories` / boot path, or should rerank be gated to boot-briefing + explicit recalls only?
- **OQ-4 (parity):** Is the `system/`-namespace `mcp-servers/task-board/memory.ts` a live mirror
  that must be kept in sync, or a frozen backup artifact we can ignore?
- **OQ-5 (ANN threshold):** At current memory-row counts brute-force cosine is fine. Set a row-count
  threshold above which we add an ANN index (e.g. sqlite-vec / faiss-class), or defer entirely?
- **OQ-6 (eval ceiling):** Accept *relative* (hybrid ≥ BM25 ≥ LIKE) acceptance given the documented
  0.180 perfect-memory ceiling, rather than an absolute R@k target?

---

*End of P0 retrieval frontier-alignment spec — Stage 1 (spec-lock). No implementation performed.*
