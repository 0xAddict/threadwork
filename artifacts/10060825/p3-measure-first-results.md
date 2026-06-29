# P3 — Curated Delegation Briefs: Measure-First Study (STAGE-2a)

**Task:** #10060825 (P3 umbrella #10060787; spec `specs/P3-delegation-briefs-frontier-alignment.md`, locked @ c5d382f) · **Repo:** `task-board`
**Date:** 2026-06-29 · **Author:** kiera (build sub-agent) · **Stage:** STAGE-2a measure-first (STUDY ONLY — no build, no source/retrieval change, no push)

Gates spec §6 PC-6 / §7 AC-11 / §9 OQ-3: does a curated, bookended delegation brief
improve delegatee outcomes vs (a) THIN free-text-description-only (status quo) and
(b) FULL-DUMP of the delegator's full context — and is the signal MATERIAL (build full
auto-assembly) or IMMATERIAL (ship minimal explicit-brief param only)?

---

## TL;DR — verdict (for the HUMAN gate; not a decision made here)

**The frontier DIRECTION holds on threadwork, robustly. The curated-vs-thin uplift
MAGNITUDE is lens-dependent (honest caveat below).**

1. **FULL-DUMP is pathological on threadwork — robust across every metric.** A delegator
   full-context dump is **622k–980k tokens** per delegation (median ~625k), of which
   **~75–90% is 6 giant Session-Debrief/decision blobs** (60k–130k tokens each).
   Precision (fraction of dumped memories that are actually needed) is **0.028–0.120**
   → **88–97% noise**. This is unusable (exceeds most context windows) and is the
   mechanical signature of AOrchestra's "full-context inheritance is empirically worse":
   the needed facts are buried in ~760k tokens of irrelevant blobs. → **The anti-full-dump
   guard (spec PC-5) is clearly warranted.**
2. **CURATED is robustly Pareto-superior to FULL-DUMP.** A recall-selected, capped brief
   reaches **0.69–0.93 needed-fact coverage at 1/87–1/193 the tokens** of full-dump
   (≈4k tokens @5, ≈9k @12 vs ~760k) with **3–10× full-dump's precision**.
3. **CURATED ≥ THIN on coverage under every metric and threshold tested**, but the
   *magnitude* of the uplift depends on how "needed fact" is operationalized:
   **+0.025 coverage** (conservative loose distinct-token-count lens) to **+0.49 coverage**
   (salience-weighted-grounding lens). Direction always positive; size uncertain.

**Build-scope recommendation (for Boss/Gwei): MATERIAL-leaning → build the auto-assembly
(PC-1) + anti-dump guard (PC-5), NOT the minimal slice — but cap N≈8 and relevance-GATE it.**
Rationale: findings #1 and #2 are robust and decisive — full-dump must be prevented and a
recall-selected capped brief is the right shape; the assembly logic is required for the
guard anyway; ~1/3 of delegations are self-contained (|G|=0) so the brief must be
relevance-gated (no brief when nothing clears the bar). The curated-over-thin uplift is
positive but its size is lens-sensitive, so the case rests primarily on #1/#2, not on a
headline thin→curated number. See "Honest caveat" before quoting any single uplift figure.

---

## Method (objective-grading; deterministic, no LLM, no network)

- **Remote-grounded:** `git fetch origin`; `origin/main = 10929bd024ea731a64d51a000d5491816c53721e`.
  The shipped `db.ts` / `memory.ts` / `dense.ts` on disk are **byte-identical to origin/main**
  (`git diff --quiet origin/main` clean) → running local code = running the shipped path.
- **Read-only on live data:** `VACUUM INTO` snapshot of live `tasks.db` opened `mode=ro`
  (sha256 `42134b8508ebc0…`). Per-instance **APFS copy-on-write clones** in scratch. Live
  `tasks.db` main file never written. (Mirrors GAP-4 #10060821 discipline.)
- **Shipped recall AS-IS** as the relevance primitive: `MemoryDB.recallAugmented('boss',
  {query: description, limit})` — the `recall_memories` entrypoint — invoked with the
  **production config from `mcp.json`**: dense ON, mode `rrf`, **k=5** (bm25_k=dense_k=50).
  Config proof logged per run (`config_proof.json`). No reimplementation, no retrieval edit.
- **Point-in-time fidelity:** on each instance's clone we `DELETE FROM memories WHERE
  datetime(created_at) > datetime(delegation_created_at)` (delete triggers keep `memories_fts`
  + `memory_vectors` consistent), so recall sees only the delegator's context **that existed
  at delegation time** — and the task's own post-completion debrief memory can never leak
  into its brief. One clone per instance (recall's `touchRecalled` mutation cannot contaminate
  another instance).

### Sample (N=59)
- All **completed `boss→worker` delegations with a substantive result** (`from_agent='boss'`,
  `to_agent ∈ {sadie,kiera,steve}`, supervised, `status='completed'`, `len(result)>150`).
- `boss` is the canonical orchestrator-delegator the spec targets ("Boss generates the brief",
  OQ-2 Boss-path-first). Other delegators (watchdog→boss, brief-bridge, snoopy: ≤8 each) excluded
  to keep the delegator-pool homogeneous + rich.
- Point-in-time delegator pool grows 159→241 memories over the sample window; avg description
  ~1436 chars (~360 tok), avg result ~2229 chars (~560 tok).
- **Small-N caveat:** 59 delegations from one delegator on one team. Direction-finding, not a
  population estimate. CIs not computed (deterministic point metrics on a census of the
  available boss delegations, not a random sample).

### The 3 conditions (per instance)
- **THIN** = the free-text `description` only (exactly what `delegate_task` ships today).
- **CURATED@N** = `description` + the top-N memories from shipped `recall(description)`,
  N swept ∈ {3,5,8,12}. (Bookending — head/tail placement — is a *positional* optimization
  for LLM attention; it does **not** change set-coverage/precision/tokens, so it is NOT
  measured here. See limitations.)
- **FULL-DUMP** = `description` + the delegator's entire point-in-time pool (≈160–241 memories).

### Outcome proxy + exact metric definitions
Ground truth **G = "facts the delegatee actually needed"** is derived from the completed
task's **RESULT** — an **independent** signal from the recall query (the **DESCRIPTION**).
recall selects vs description; G is grounded vs result; the two are computed from different
texts, so CURATED is **not** circularly constructed to contain G.

- Tokenizer: `[a-z0-9_]+` on lowercased text (keeps identifiers/SHAs/env-vars/task-ids whole),
  minus a minimal **function-word** stoplist (no domain stoplist — IDF handles domain-common
  terms). IDF over the 241-memory corpus; "distinctive" = token in ≤5% of memories (df≤12).
- **Primary metric (`score_p3.py`):** `grounding_score(mem, text) = Σidf(mem∩text)/Σidf(mem)`
  (salience-weighted fraction of the memory's distinctive content echoed in `text`).
  `G = { pool mem : grounding_score(mem, RESULT) ≥ τ AND ≥1 distinctive shared term }`, τ swept.
  `covered(mem, conditionText)` same rule vs the condition's text.
  - **coverage** = fraction of G delivered (THIN text = desc; CURATED = desc∪top-N content;
    FULL = desc∪all-pool ⇒ 1.0 by construction).
  - **precision** = fraction of *surfaced memories* that are in G (CURATED: |top-N∩G|/N;
    FULL: |G|/|pool|; THIN: n/a — surfaces no memories).
  - **token cost** = `ceil(chars/4)` of the full brief (CURATED counts UNCAPPED memory
    content — conservative; a real byte-capped/bookended brief is smaller).
- **Independent verifier (`verify_p3.py`)** — structurally different operationalization:
  `G' = { pool mem : ≥2 shared DISTINCTIVE tokens with RESULT }` (count-based, no IDF ratio,
  no τ). Recomputes coverage/precision. Robustness check vs the formula, not just the threshold.

---

## Results (primary metric, τ=0.15 — 39 informative instances, 20 with |G|=0, mean |G|=5.08)

| metric | THIN | CURATED@3 | CURATED@5 | CURATED@8 | CURATED@12 | FULL-DUMP |
|---|---|---|---|---|---|---|
| **coverage** (needed-fact recall) | 0.304 | 0.746 | **0.792** | 0.867 | **0.929** | 1.000 |
| **precision** (surfaced=needed) | n/a | 0.34 | 0.282 | 0.21 | 0.169 | **0.028** |
| **tokens** (brief size, est) | 366 | ~2.6k | 3,932 | ~6.2k | 8,743 | **758,939** (med 791,915) |
| **needed-facts / 1k tokens** | 3.19 | — | 1.14 | — | — | **0.0068** |

- **curated@5 − thin = +0.488 coverage** for **+3.6k tokens** (cheap).
- **full − curated@5 = +0.208 coverage** for **+755k tokens (193×)** and **−0.254 precision**
  (10× more noise). curated@12 closes to within **0.071** of full at **1/87 the tokens**.
- `facts/1k-tokens`: full-dump = **0.0068** vs thin **3.19** (≈**470× worse signal density**) —
  the mechanical proxy for "full-context inheritance is worse than nothing."

### Sensitivity — τ sweep (primary metric), coverage
| τ | n_inf | mean\|G\| | THIN | CURATED@5 | CURATED@12 |
|---|---|---|---|---|---|
| 0.10 | 55 | 12.13 | 0.258 | 0.809 | 0.936 |
| **0.15** | 39 | 5.08 | **0.304** | **0.792** | **0.929** |
| 0.20 | 26 | 2.73 | 0.270 | 0.871 | 0.935 |
| 0.25 | 12 | 2.00 | 0.299 | 0.833 | 0.917 |

Curated ≫ thin at **every** τ (thin 0.26–0.30 vs curated@5 0.79–0.87) — the salience-lens
verdict is robust to the grounding threshold.

### Independent verifier (loose distinct-token-count metric) — 59 informative, mean |G'|=21.3
| metric | THIN | CURATED@5 | CURATED@12 | FULL |
|---|---|---|---|---|
| coverage | 0.666 | 0.691 | 0.730 | 1.000 |
| precision | n/a | 0.359 | 0.268 | 0.120 |

- curated@5 − thin = **+0.025** coverage (curated@12 − thin = +0.064). **Direction still
  positive**, magnitude small. curated precision **3× full** (0.359 vs 0.120) — the
  curated≫full-dump precision verdict **reproduces**.

---

## Honest caveat — the curated-vs-thin magnitude is lens-dependent (read before quoting a number)

The two metrics disagree on the SIZE of the thin→curated uplift (+0.49 salience-lens vs
+0.025 loose-count-lens). Cause: the **loose count lens admits the giant debrief/decision
blobs into G'** (a 130k-char blob trivially shares ≥2 distinctive tokens with any on-topic
result → mean |G'|=21 needed facts/task is implausibly high), and those same blobs are
"covered by the description" on ≥2 coincidental tokens → it **inflates thin coverage with
false positives on both sides**, compressing the contrast. The **salience-ratio lens** is
stricter and more semantically faithful ("the result is substantially *about* this memory's
distinctive content"; mean |G|=5/task is plausible), but it is also the lens that yields the
larger, more flattering uplift — so it must not be cherry-picked.

**What is metric-INDEPENDENT (safe to rely on):** (1) full-dump is unusable (tokens +
precision), (2) curated ≫ full-dump on precision (3–10×) and tokens (1/87–1/193), (3) curated
≥ thin always. **What is uncertain:** the precise thin→curated coverage uplift (somewhere in
[+0.03, +0.49+]). The build-scope case therefore rests on (1)/(2), not on the headline thin
number. A true causal thin-vs-curated delegatee-outcome delta would require an A/B with live
delegatees (out of scope for this gate).

### Other limitations
- **Bookending not measured** — head/tail placement is an LLM-attention (lost-in-the-middle)
  effect; mechanical set-coverage can't see it. Adopt it per the frontier evidence; it's
  orthogonal to these numbers.
- **Superseded-state** is read at snapshot time, not delegation time (minor pool shrinkage).
- **One delegator (boss), one team** — direction-finding only.
- The AOrchestra "full < thin" inversion is an LLM-attention result; our mechanical coverage
  can't reproduce an inversion (full coverage is 1.0 by construction). We capture full-dump's
  *harm* via precision/token/signal-density, which is the mechanistic cause of that inversion.

---

## Independent verify (Codex, adversarial, different model family) — LOCKED

`codex exec` (reasoning=high) was told to TRY TO BREAK the study: recompute the headline
from raw with its OWN script, hunt circularity / leakage / metric cherry-picking, and
adjudicate the lens divergence + the verdict.

- **Independent recompute (own Python, no import of `score_p3.py`): MATCHED** `results.json`
  exactly — THIN 0.30390, CURATED@5 0.79193, CURATED@12 0.92850, FULL 1.0; precision
  CURATED@5 0.28205 / FULL 0.02829; tokens CURATED@5 3,931.7 / FULL mean 758,939 / median 791,915.
- **Circularity: PASS** — G is built from `result` only; `recall_order` is used solely for the
  CURATED condition; recall query is `description`. No recall-id leaks into G.
- **Leakage: PASS** — retained pools had 0 memories `created_at > task.created_at`, 0 at the same
  second, and 0 retained rows with `source_task_id == task_id`. (Edge note: the `>` filter leaves
  a *theoretical* same-second hole — absent in this sample; `>=` + an explicit `source_task_id !=`
  guard would be strictly tighter. Recommended hardening for any production reuse of the harness.)
- **Lens divergence: PASS** — Codex independently judged the **salience lens more faithful**
  (loose count admits debrief/decision blobs on incidental overlap → mean |G'|=21.3 is implausible
  for one delegation; mean |G|≈5.08 is credible) and confirmed the writeup does not hide the
  divergence and does not rest the build case on the +0.49 figure.
- **Full-dump pathology: PASS** — full tokens mean 741,765 / median 625,250 (all 59); CURATED@5 is
  **9.97× more precise** and **193× smaller**. Supported.
- **Verdict adjudication: PASS** — the MATERIAL-leaning recommendation is supported because it rests
  on full-dump pathology + curated-vs-full efficiency (robust), NOT on a promised +0.49 live delegatee
  delta (which the data does not support).

**Codex verdict: `LOCKED (no material flaws)`.**

---

## Reproducibility & guardrails
- **Harness:** `artifacts/10060825/harness/{build_sample.ts, score_p3.py, verify_p3.py}`.
  **Raw:** `artifacts/10060825/{sample.json, memdump.json, results.json, per_instance.json,
  config_proof.json}`. Deterministic (fixed sample, ONNX int8 deterministic, `(-score,id)`
  tiebreaks, pure-function scorer). Re-running reproduces identical numbers.
- **Guardrails honored:** read-only on live data (VACUUM `mode=ro` snapshot + per-instance CoW
  clones in scratch; live `tasks.db` never written). No source/retrieval changes (recall used
  AS-IS, code byte-identical to origin/main). Out-of-tree (artifacts/ only). No build, no
  deploy, no /mcp reconnect, no session restart. Artifacts committed locally only — **NOT pushed**.
