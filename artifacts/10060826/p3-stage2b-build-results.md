# P3 — Curated Delegation Briefs: BUILD (STAGE-2b)

**Task:** #10060826 (P3 umbrella #10060787; spec `specs/P3-delegation-briefs-frontier-alignment.md`, LOCKED @ `c5d382f`) · **Repo:** `task-board`
**Date:** 2026-06-29 · **Author:** kiera (build sub-agent) · **Stage:** STAGE-2b BUILD (additive + backward-compatible; default-OFF; NOT deployed)
**Grounding:** `git fetch` run; `origin/main = c5d382f` (locked spec, pushed by Boss); local `main = 637ace1` (Stage-2a study, ahead 1). Built on `637ace1`; ACs grounded against the locked spec `c5d382f`. Retrieval stack (`memory.ts`/`dense.ts`) **0-line diff** (AC-9).

---

## What shipped (per spec §6 PC-1..6)

- **PC-1 `assembleDelegationBrief()`** (`delegation-brief.ts`): a curated, **bookended** brief built from
  (a) the SHIPPED P0 recall path `MemoryDB.recallAugmented()` → `recall()` (AC-3; no new/duplicate retrieval path),
  capped at **N=8** memories; (b) a post-recall **distinctive-token relevance filter** (anti-junk floor —
  `sanitizeFtsQuery` ORs stopwords like "the", so a bare recall hit is not sufficient); (c) parent-task context
  (description/result) + **parent AND sibling findings** via `db.readParentAndSiblingFindings()`. **RELEVANCE GATE:**
  returns `null` when nothing clears the bar (≈1/3 of delegations are self-contained per study #10060825 → no brief).
- **PC-2 `delegate_task` surface** (`server.ts`): new optional `brief` param (explicit delegator-curated) **AND**
  auto-assembly when omitted. BOTH gated by the default-OFF flag `delegation_briefs_enabled`.
- **PC-3 persistence** (`db.ts`): new nullable `tasks.delegation_brief` column via guarded `ALTER TABLE` (same
  migration discipline as P0); written in `delegateTask` (AC-7).
- **PC-4 surfacing** (`server.ts`): the brief is rendered to the delegatee at **claim_task** (full), **list_tasks**
  (full content), and **boot** (`get_boot_briefing`, via `db.getActiveDelegationBriefs`). All flag-gated (AC-6).
- **PC-5 anti-dump guard** (`delegation-brief.ts` + `db.ts`): HARD count cap (N=8) + byte cap
  (`BRIEF_MAX_BYTES = 8000` ≈ 2k tokens, ~95–375× below the ~760k-token full-dump the study found pathological).
  Caller-supplied `maxMemories`/`maxBytes` are **clamped** to the ceilings; `enforceAntiDumpBrief()` rejects an
  oversized explicit brief; `db.delegateTask` re-enforces the byte cap so a direct DB caller cannot bypass it (AC-8).
- **PC-6 / AC-11 measure-first**: already delivered + Codex-locked in Stage-2a (#10060825); not re-run.

## Bookending (PC-1/AC-4)
`render()` emits the most-critical content at the **HEAD** and recaps it at the **TAIL**, with lower-salience
context in the middle; the bookends are never dropped — only middle context is trimmed to honor the byte budget.

## Backward-compat (AC-5)
The entire P3 code path is gated on `db.isFeatureEnabled('delegation_briefs_enabled')` (DEFAULT **0/OFF**). With the
flag OFF: no `recall()` call (no memory access-count side-effects), `delegation_brief` persists as **NULL**, the nudge
string is unchanged, and the audit payload gains no keys → **byte-identical to the pre-P3 (`10929bd`) behavior.**
A dedicated test asserts the NULL/unchanged-row behavior.

---

## Tests (`tests/delegation-brief.test.ts`) — 17 pass / 0 fail / 50 assertions
Covers: migration + flag-default-OFF; AC-5 NULL-when-off row; AC-7 persistence; AC-6 boot query (incl. >5 tasks);
AC-2/AC-3 recall-selected count+byte-capped subset; AC-4 bookend (auto + explicit near-cap); AC-8 anti-dump
(explicit reject + db-layer reject + at-cap accept + huge-memory auto path); relevance gate (no brief for
self-contained / stopword-only matches); hard count-cap clamp; parent + sibling findings.
*(The suite forces dense OFF so `recallAugmented()` returns the sync `recall()` base — AC-3 still holds — avoiding a
Bun native ONNX-teardown panic; dense production fidelity is proven separately in Stage-2a.)*

**Full suite:** 577 pass / 11 fail. The 11 failures are **pre-existing on baseline `637ace1`** (verified by stashing
the P3 edits and re-running the implicated files): 8× a `0009_state_contracts` migration harness, GATE3/GATE4
nudge-dispatcher meta-guardrails, 1× a `memory_fts` boot test. **Zero new regressions** from P3.

## Adversarial verification (Codex `exec`, `model_reasoning_effort=xhigh`, verify-to-BREAK)
- **Round 1:** NOT LOCKED, 5 flaws → fixed (hard-clamp caps; distinctive-overlap relevance filter; explicit-brief
  bookend via the renderer; `list_tasks` renders content; parent findings).
- **Round 2:** NOT LOCKED, 4 flaws → fixed (db-layer anti-dump guard; parent **AND sibling** findings; boot cap 5→20).
  Relevance "single content-word overlap" adjudicated a tuning nit, not an AC break.
- **Round 3 (final): `LOCKED (no material flaws)`.** AC-2/3/4/5/6/7/8/9/11 PASS; AC-1 N-A in-sandbox (fetch/confirm
  done at build start); AC-10 N-A (board/dashboard/PR = the pre-deploy gate, Boss's domain).

### Documented non-material nits (left by design)
1. Boot surfaces up to 20 briefed open tasks; `claim_task`/`list_tasks` cover **all** tasks, so coverage is complete.
2. The slim `tasks_archive` (14-day hygiene) omits `delegation_brief` — consistent with that archive already omitting
   ~15 operational columns; the brief is ephemeral working context and the audit log durably records its mode+bytes.

---

## Guardrails honored
- Additive + backward-compatible; default-OFF; **byte-identical when OFF** (AC-5).
- Reused the shipped `recall()` AS-IS; **no retrieval-stack changes** (`memory.ts`/`dense.ts` 0-line diff, AC-9).
- Scope-guarded: no P2/P4/P5/P6-8 code.
- Commit hygiene: explicit-path `git add` only (no `git add -A`); **no raw dumps committed**; gitignore rule added
  against future `memdump.json` leaks (637ace1 precedent). **Not pushed** — stopped at the pre-deploy gate (Boss holds deploy).
