# GAP-4 — Recall + Precision Benchmark & k / Reranker Decision (Sprint Contract)

- **Card:** #10060818 (steve's lane; boss-launched end-to-end per Gwei TG 7380)
- **Executor:** autonomous Generator + independent Verifier (boss-orchestrated)
- **Repo:** `/Users/coachstokes/.claude/mcp-servers/task-board`
- **Upstream state:** GAP-1 dense LIVE (49e2c4e); GAP-2 RRF union-fusion committed (99db206), k=10 interim, canary-GO **(recall only)**. Option B = permanent default (Gwei TG 7380).

## Why
The k=10 canary validated **RECALL only** (golds surface in top-10). It did **not** measure **PRECISION** — a low RRF k can promote dense false-positives that k=60 suppresses. This benchmark closes that gap to answer two decisions:
- **(a) k:** confirm k=10 or retune (is 10 right, or should it move toward ~15–20?).
- **(b) GAP-3 reranker:** does dense+RRF close the gap enough that the cross-encoder reranker is NOT needed, or is there a **material residual gap** justifying the build? (measure-first, per council #10060795 / Decision #2616).

## Deliverables (must_pass)
1. **Eval set** (deterministic, versioned). Start from the council/paraphrase evalset (Kiera Stage-2a — 36 paraphrase queries + golds; if the frozen `arms_dense.py`/evalset is absent in-repo, reconstruct from memory #2620 staged probes + the gold memories). Add:
   - **Precision / false-positive stratum:** queries paired with KNOWN-IRRELEVANT hard distractors (semantically near but wrong) that must NOT appear in top-k.
   - **Brand-bearing realistic stratum:** proper-noun queries (Smartlead / AgentMail / Netlify / launchd / gh …). The Stage-2b realism gate flagged 20/36 queries were scrubbed of proper nouns → inflated headline; include realistic brand-bearing queries so numbers aren't an upper bound.
   - Strata labeled: `semantic-paraphrase`, `keyword-exact`, `brand-bearing`, `adversarial-distractor`.
2. **Arms:** LIKE baseline · BM25/FTS5 · dense-only · dense+RRF (Option B). Sweep RRF **k ∈ {5,10,20,30,60}**. (hybrid+rerank arm OUT OF SCOPE — that's GAP-3, gated on THIS benchmark.)
3. **Metrics** per arm × per k × per stratum: `recall@10`, `MRR@3`, AND `precision@10` / **false-positive rate** (fraction of top-k that are known-irrelevant distractors). Aggregate + per-stratum + per-query.
4. **Run:** deterministic (fixed eval set, pinned tiebreak) on a **COPY of the live DB** (`VACUUM INTO` snapshot) — ZERO mutation of the live board. Reuse the REAL recall path (`MemoryDB.recallAugmented` / the `recall_memories` entrypoint), not a reimplementation. Log `denseRrfK()` per run to prove the k under test.
5. **Output:** results written to `artifacts/` (machine `.json` + readable `.md`) and mirrored to the dashboard.
6. **Verdicts** (the decision payload):
   - **(a) Recommended k** — does k=10 hold on precision, or what k best trades recall vs false-positives across strata? Evidence = the recall-vs-precision curve over the k sweep.
   - **(b) Reranker (GAP-3) needed?** — yes/no with the residual-gap number: after dense+RRF at the recommended k, is there a material recall/precision gap vs target (the +17.2pp reranker headroom / 0.180 ceiling) the reranker would close? Immaterial → recommend CLOSE GAP-3; material → recommend BUILD with the expected gain.

## Verification gate (hard — independent)
- An **independent verifier** (Codex extra-high `codex exec --skip-git-repo-check -C <repo>`, OR a second opus sub-agent that did NOT write the harness) re-runs / re-derives the headline numbers and confirms recall + precision + both verdicts within tolerance.
- Publish exact metric definitions + per-stratum breakdown (objective-grading method). Do NOT headline a verdict before the verify LOCKS (verify_headline_after_lock lesson).
- **No fabricated PASS:** if the harness can't run or the eval set can't be made faithful, STOP and report what's missing — never invent numbers.

## Guardrails
- Read-only on live data (DB copy only). Commits only if the harness/evalset is saved as an artifact — explicit paths, no drift, no push without boss. No prod deploy. No session reconnect/restart. Throwaway runs in `scratchpad/` + outputs in `artifacts/`.

## Done =
All must_pass deliverables produced + independent verify reproduces the headline numbers + both verdicts (k + reranker) delivered with evidence → report to boss for Gwei.
