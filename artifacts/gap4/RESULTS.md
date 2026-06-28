# GAP-4 — Recall + Precision Benchmark & k / Reranker Decision

**Task:** #10060821 (under #10060810; the #10060818 precision-eval lane) · **Repo:** `task-board`
**Date:** 2026-06-28 · **Status of verdicts below:** see "Independent verify" section (Codex gate).

## TL;DR (verdicts)

- **(a) Recommended RRF k:** the measured recall/precision Pareto frontier is **k=5** (recall-optimal) and **k≈20** (precision-optimal). **k=10 is weakly dominated by k=5** — equal near-miss FPR (0.157) and equal debrief-FPR (0), but higher recall and MRR — so the data gives k=10 **no metric advantage** beyond incumbency. Raising k *monotonically lowers recall* and only *marginally* lowers near-miss FPR, which plateaus at k≈20 (so k=30/60 are dominated by k=20). The canonical false-positive class (Session-Debrief aggregates) is **already fully suppressed at every k** (debrief-FPR = 0) by the shipped Phase-1 demote — k is **not** load-bearing for the precision that matters. **Recommendation: use k=5 for a recall-weighted memory surface (recommended); use k≈15–20 only if minimizing semantically-near distractors is explicitly prioritized; abandon k=60.** k=10 is *acceptable* (current interim) but not data-preferred.
- **(b) GAP-3 cross-encoder reranker:** **NOT needed → recommend CLOSE GAP-3.** Shipped dense+RRF already reaches recall@10 ≈ 0.95–1.00 and MRR@3 ≈ 0.74–0.76 on the real recall path. The residual to the pinned rerank ceiling (MRR@3 0.8667 / recall@10 0.9714, #10060805) is **~+0.07–0.10 MRR@3 ranking-only** and the reranker **lowers recall@10** while adding **~130× latency** + a 2nd permanent ONNX model. The +17pp headroom that originally justified the reranker was vs BM25 — and dense+RRF (already live) captures the bulk of it.

---

## Method (objective-grading)

- **Live-DB copy, zero mutation:** `VACUUM INTO` snapshot of the live `tasks.db` (read-only on source; `mode=ro`). sha256 `2c26d788…`. 419 memories (all non-superseded), 393 vectors, 28 Session-Debrief aggregates. Live board never written.
- **Real recall path:** every arm calls `MemoryDB.recallAugmented(agent, {query, limit:10})` — the `recall_memories` entrypoint — NOT a reimplementation. Arms are selected only via the production env knobs that `dense.ts` reads (`isDenseEnabled` / `denseMode` / `denseRrfK`). `denseRrfK()`/`denseMode()`/`isDenseEnabled()` are logged **per run** to prove the config under test.
- **Determinism:** each (arm,query) runs against its **own fresh APFS copy-on-write clone** of the pristine snapshot, so `recall()`'s `touchRecalled` side-effect (`importance+1`, a BM25 ranking input) can never contaminate another query/arm. ONNX int8 embedding is deterministic; all recall sorts use `(-score,id)` tiebreaks. Re-running the full sweep reproduces byte-identical top-10 lists (see "Reproducibility").
- **Harness parity:** the harness **exactly reproduces the #10060820 canary** — gold #1382 at rank 8 @k=10 (canary's GO result), falls out of top-10 @k=60; keyword controls rank-1 at both k.

### Arms (8)
| arm | how it maps to the real path |
|---|---|
| LIKE | dense OFF + `memories_fts` dropped on the clone *after* construction → `recall()` falls back to `recallLike` (shipped pre-FTS degrade path) |
| BM25 | dense OFF, FTS present → `recall()` = `recallBm25` (shipped default base) |
| dense-only | dense ON, `mode=dense` → pure cosine ranking |
| rrf@{5,10,20,30,60} | dense ON, `mode=rrf`, `TASKBOARD_DENSE_RRF_K` swept (BM25∪dense union-fusion, K_bm=K_d=50) |

### Eval set (57 queries, 4 strata) — `artifacts/gap4/evalset.json`
| stratum | n | purpose | source |
|---|---|---|---|
| `semantic-paraphrase` | 36 | recall stress (low-lexical-overlap paraphrases) | Kiera Stage-2a frozen (verbatim) |
| `brand-bearing` | 7 | realism — proper nouns restored (Stage-2b flagged scrubbing inflated the headline) | Kiera Stage-2b brand variants (gh/launchd/Smartlead/Netlify/Gmail) |
| `keyword-exact` | 7 | keyword anchoring (gold must stay top-3) | authored exact-keyword controls |
| `adversarial-distractor` | 7 | **precision / false-positive** — queries + KNOWN-IRRELEVANT hard negatives | authored; distractors validated dense-near via mining + per-distractor irrelevance justification (`distractor_justification` in evalset.json) |

### Metric definitions
- `gold_rank` = min 1-based position of any gold id in top-10, else miss.
- **recall@10 / recall@3** = weighted fraction with gold_rank ≤ 10 / ≤ 3.
- **MRR@3** = weighted mean of `1/gold_rank` when ≤ 3, else 0.
- **FPR@10** (precision) = fraction of top-10 that are this query's *labeled* hard-negative distractors (LOWER = better). `precision@10` = gold-hits / (gold-hits + distractor-hits) among judged items.
- **debrief-FPR@10** = fraction of top-10 that are the 28 Session-Debrief aggregates (canonical query-independent irrelevant class), over ALL queries.
- Weights: Kiera's 545-dual queries (SP-A08+SP-B09) carry 0.5 each so memory 545 contributes 1.0.

---

## Results

### Per-stratum recall (recall@10 / recall@3 / MRR@3)

**semantic-paraphrase** (n=36, eff_n=35)
| arm | recall@10 | recall@3 | MRR@3 | debrief-FPR |
|---|---|---|---|---|
| LIKE | 0.000 | 0.000 | 0.000 | 0.006 |
| BM25 | 0.743 | 0.600 | 0.505 | 0.000 |
| dense-only | **1.000** | 0.914 | **0.760** | 0.000 |
| rrf@5 | 0.971 | 0.829 | 0.752 | 0.000 |
| rrf@10 | 0.943 | 0.800 | 0.738 | 0.000 |
| rrf@20 | 0.914 | 0.800 | 0.743 | 0.000 |
| rrf@30 | 0.857 | 0.829 | 0.752 | 0.000 |
| rrf@60 | 0.857 | 0.829 | 0.752 | 0.000 |

**brand-bearing** (n=7) — proper nouns restored
| arm | recall@10 | recall@3 | MRR@3 |
|---|---|---|---|
| BM25 | 0.857 | 0.429 | 0.429 |
| dense-only | 1.000 | 1.000 | 0.905 |
| rrf@{5..60} | 1.000 | 0.857 | 0.857 |

> Realism check: even WITH proper nouns restored, dense+RRF recall@10 = 1.000 while BM25 = 0.857 — the dense win is **not** a proper-noun-scrubbing artifact.

**keyword-exact** (n=7) — every arm (incl. LIKE) recall@10 = recall@3 = MRR@3 = **1.000**; k has no effect (exact keywords anchor in both channels).

**adversarial-distractor** (n=7) — recall + precision
| arm | recall@10 | MRR@3 | **FPR@10** | precision@10 | mean distractor-hits / top-10 |
|---|---|---|---|---|---|
| BM25 | 0.429 | 0.429 | 0.071 | 0.367 | 0.714 |
| dense-only | **1.000** | 0.905 | **0.243** | 0.298 | 2.429 |
| rrf@5 | 1.000 | 0.548 | 0.157 | 0.464 | 1.571 |
| rrf@10 | 0.857 | 0.500 | 0.157 | 0.417 | 1.571 |
| rrf@20 | 0.857 | 0.500 | **0.129** | 0.440 | 1.286 |
| rrf@30 | 0.857 | 0.500 | 0.129 | 0.440 | 1.286 |
| rrf@60 | 0.857 | 0.500 | 0.129 | 0.440 | 1.286 |

### The recall-vs-precision curve over the k sweep (the decision evidence for (a))
| arm | recall@10 (sem+brand, n=43) | MRR@3 | adversarial FPR@10 | debrief-FPR@10 (all) |
|---|---|---|---|---|
| dense-only | **1.000** | 0.784 | 0.243 | 0.000 |
| rrf@5 | 0.976 | 0.770 | 0.157 | 0.000 |
| rrf@10 | 0.952 | 0.758 | 0.157 | 0.000 |
| rrf@20 | 0.929 | 0.762 | **0.129** | 0.000 |
| rrf@30 | 0.881 | 0.770 | 0.129 | 0.000 |
| rrf@60 | 0.881 | 0.770 | 0.129 | 0.000 |

**Reading the curve:**
- **Recall falls monotonically as k rises** (0.976 → 0.881). Higher k flattens RRF weights, letting BM25's many mid-rank hits bury dense-only-found paraphrase golds.
- **Near-miss FPR falls as k rises but plateaus at k≈20** (0.157 → 0.129, flat thereafter). The hypothesis "low k promotes dense false-positives that high k suppresses" is **confirmed in direction but small in magnitude** (Δ = 0.028 FPR = ~2 distractor-slots across 7 queries; n=7, within small-sample noise).
- **debrief-FPR = 0 at every k** — the FP class that actually mattered historically ("23 debrief blobs outrank gold in 31/36") is already neutralized by the shipped Phase-1 demote, independent of k.
- **Pareto frontier = {dense-only, rrf@5, rrf@20}.** k=10 is weakly dominated by k=5 (same FPR, higher recall); k=30 and k=60 are strictly dominated by k=20 (equal precision, lower recall).

---

## Verdict (a) — recommended k  [LOCKED — see Independent verify]

The measured Pareto frontier among RRF arms is **k=5** and **k≈20**; **k=10 is weakly dominated by k=5**, and **k=30/60 are dominated by k=20**. (Codex's first pass correctly flagged that an earlier "k=10 holds" framing overclaimed — the data does not single out k=10; this verdict is the corrected, data-driven version.)

| candidate k | sem+brand recall@10 | MRR@3 | near-miss FPR@10 | debrief-FPR | Pareto status |
|---|---|---|---|---|---|
| k=5 | **0.976** | 0.770 | 0.157 | 0 | frontier (recall-optimal) |
| k=10 | 0.952 | 0.758 | 0.157 | 0 | **dominated by k=5** (same FPR, lower recall) |
| k=20 | 0.929 | 0.762 | **0.129** | 0 | frontier (precision-optimal) |
| k=30 | 0.881 | 0.770 | 0.129 | 0 | dominated by k=20 |
| k=60 | 0.881 | 0.770 | 0.129 | 0 | dominated by k=20 |

**Recommendation:**
1. **k=5** for a recall-weighted memory surface (recommended default) — recall is the higher-value metric for a recall-augmented memory store, and the canonical FP class (Session-Debrief) is already 0 at every k, so the small near-miss-FPR cost of low k is low-harm.
2. **k≈15–20** only if an operator explicitly prioritizes suppressing *semantically-near* distractors (precision plateau; recall −4.7pp vs k=5). There is **no** case for k > 20.
3. **k=10** is *acceptable* (the current interim default) but has no metric advantage over k=5 — switching to k=5 is a strict recall improvement at equal precision; the switch is a boss/Gwei operational call.
4. **Abandon k=60** (the original code default) — strictly dominated on the recall/precision tradeoff.

Answer to the contract's framing ("does k=10 hold on precision, or move toward ~15–20?"): **for precision, yes — moving k 10→20 lowers near-miss FPR 0.157→0.129**; but for recall, moving 10→5 is better. There is no data case for pinning exactly k=10.

## Verdict (b) — is the GAP-3 reranker needed?  [LOCKED — Codex: SUPPORTED]

**No — recommend CLOSE GAP-3.**
- Shipped dense+RRF on the real path: recall@10 ≈ 0.95 (sem+brand) / 1.00 (dense-only); MRR@3 ≈ 0.74–0.78.
- Pinned reranker ceiling (independent prior measurement #10060805, brand set): MRR@3 **0.8667**, recall@10 **0.9714**.
- **Residual the reranker would close ≈ +0.07–0.10 MRR@3 — ranking-only (moves the gold *within* top-10)** — and it **lowers recall@10** (1.00→0.97) at **~130× latency** (14.5s vs 0.1s) + a 2nd permanent ONNX model.
- The original "+17pp headroom / 0.180 ceiling" was measured vs BM25/pre-BM25; dense+RRF (already live) captures the bulk (dense MRR@3 0.76 vs BM25 0.505 = **+0.255**, ~78% of the rerank gain per the pinned measurement). The marginal reranker residual is **immaterial and recall-negative**.

---

## Independent verify (Codex, adversarial, different model family) — LOCKED

Two-pass `codex exec` (extra-high reasoning) adversarially audited the harness + artifacts and was asked to TRY TO BREAK the methodology (query leakage, scrubbed proper nouns, distractor-selection bias, non-determinism, recall-only-masquerading-as-precision) and confirm/refute each verdict.

**Pass 1:** Independently recomputed the headline metrics from `raw_runs.json` with its OWN script (did not trust `score_gap4.py`) — **all compared fields matched `results.json` exactly**. PASS on: real-path (recallAugmented, env-only arm selection), determinism isolation (fresh clone per run), genuine FPR precision signal (labeled distractors ≠ gold), distractor selection (spot-checked 4 — none actually relevant), proper-noun rebuttal. Verdict (b) **SUPPORTED**. Found ONE material flaw: the earlier verdict-(a) framing ("k=10 holds") overclaimed — measured metrics show **k=5 weakly dominates k=10**.

**Fix:** verdict (a) was revised to the data-driven Pareto framing (k=5 recall-optimal / k=20 precision-optimal / k=10 dominated by k=5 / k=30,60 dominated by k=20 / abandon k=60).

**Pass 2 (re-verify):** Codex recomputed k=5/10/20/30/60 recall+FPR from `raw_runs.json`, confirmed the revised verdict (a), and returned: **"LOCKED (both verdicts now supported, no material flaws)."**

## Reproducibility & guardrails
- **Harness:** `artifacts/gap4/harness/{sweep_gap4.ts, score_gap4.py, build_evalset_gap4.py, mine_negatives.ts}`. Raw outputs: `artifacts/gap4/{raw_runs.json, results.json, per_query.json, evalset.json}`.
- **Determinism proof:** a second full sweep reproduces identical top-10 lists (diff = 0).
- **Guardrails honored:** read-only on live data (VACUUM `mode=ro` copy; per-query CoW clones in scratchpad; live `tasks.db` never written). No prod deploy, no /mcp reconnect, no session restart, no agent pings. Commit is artifact-only with explicit paths; no push without boss.
