# P2 — Semantic-Shift-Triggered Consolidation Frontier-Alignment Spec

| Field | Value |
|-------|-------|
| Spec | P2 "semantic-shift-triggered consolidation" frontier-alignment |
| Task | #10060827 (Stage-1 spec child) |
| Parent umbrella | #10060787 (align threadwork to 2026 frontier best-practices) |
| Prior siblings | P0 retrieval (#10060788) — CLOSED (dense+RRF default k=5 shipped). P3 delegation-briefs (#10060822) — spec LOCKED (c5d382f), BUILD shipped (#10060826, default-OFF flag `delegation_briefs_enabled`). |
| Date | 2026-06-29 |
| Author | kiera (spec sub-agent) |
| Stage | STAGE 1 — spec-lock (design only, no implementation) |
| Status | DRAFT — awaiting Boss/Gwei spec-lock review (FIRST gate) |

---

## 1. Benchmark statement (READ-THIS-FIRST — guardrail)

**Benchmarked against the actual REMOTE `origin/main`, not a local working copy.**

- Canonical repo on disk: `/Users/coachstokes/.claude/mcp-servers/task-board`
  (remote `origin` = `https://github.com/0xAddict/threadwork.git`).
- `git fetch origin` was run before any current-state claim below.
- **Resolved `origin/main` HEAD = `242eb86690300db6a808674f00b642bf50469927` (`242eb86`)** —
  the P3 delegation-briefs BUILD landed today (`#10060826`), advancing remote past the
  `10929bd` the P3 *spec* was grounded on. Local working tree is at the SAME SHA (`242eb86`)
  and **clean for every source file cited below** — `git status` shows only `.harness/`
  status files, `briefings/steve.json`, and untracked `artifacts/` dirty; NONE of
  `consolidator.ts / consolidate.ts / dense.ts / memory.ts / server.ts / watchdog.ts /
  snoopy-bot.ts / config.ts / db.ts` differ from `origin/main`. So the line numbers below are
  origin/main line numbers (verified, NOT stale-local).

**Why this matters (the v1 trap):** the umbrella's v1 spec work read a ~60-commit-stale LOCAL
copy and shipped 5 wrong current-state verdicts. Every current-state verdict in §4 is grounded
on the current remote HEAD `242eb86` and re-verified clean. AC-1 (§7) requires a build-time
re-fetch + re-confirm in case the consolidation paths move before P2 is built.

> Working-tree note: `specs/` at `origin/main` already contains
> `P0-retrieval-frontier-alignment.md`, `P3-delegation-briefs-frontier-alignment.md`, and
> `GAP-4-recall-precision-benchmark.md`. This file
> (`specs/P2-semantic-shift-consolidation-frontier-alignment.md`) is NEW and left uncommitted on
> disk for the human spec-lock gate. No `.gitignore` rule excludes `specs/`. Per the Stage-2a
> leak lesson (a 4MB `memdump.json` leaked into the repo), any P2 measurement scratch must be
> gitignored and kept OUT of the repo.

---

## 2. Frontier target (what 2026 best-practice for consolidation triggers is)

### 2.1 The brief's P2 recommendation (Gwei-picked, TG 7420)

> **id: P2 · axis: context-memory · verdict: ADD · effort: S**
> **title:** "Add semantic-shift-triggered consolidation (the one missing consolidation path)"
> **evidence:** consolidation is otherwise RICH (nightly daemon + gates + manual `promote_memory`
> + human-approval digest); the single MISSING trigger is semantic-shift — GAM reaches **40 F1
> vs 35** for time-based; intra-session drift is missed by fixed-window triggers.
> **implementation:** periodically embed the running session summary; if embedding distance to the
> last checkpoint exceeds a threshold, trigger mid-session consolidation.
> **source:** arXiv:2604.12285 (GAM).

### 2.2 Honesty caveat carried from the brief

The **40-vs-35 F1** figure is from **GAM (arXiv:2604.12285)**, a different memory system. The
*direction* (a semantic-shift trigger catches intra-session drift that fixed-window time/volume/idle
triggers miss) is the validated target; the **exact uplift on threadwork is an extrapolation**, which
motivates a measure-first stance (see §6 PC-6, §7 AC-11, §9 OQ-3/OQ-6) — mirroring the P3 GAP-6
precedent (council #10060795).

### 2.3 Frontier target, distilled

Add ONE new consolidation trigger alongside the existing time/volume/idle gates: a **semantic-shift**
gate that periodically embeds the *running session summary*, measures its embedding distance from the
*last checkpoint*, and fires mid-session consolidation when the distance crosses a threshold. It must be:
1. **Additive** — a NEW gate beside today's triggers, not a replacement.
2. **Reuse-only** — embeds via the SHIPPED P0 dense stack (bge-small, `dense.ts`), NO new ML dependency.
3. **Fires the EXISTING consolidation machinery** — `MemoryConsolidator.run()`, not a new engine.
4. **Default-OFF behind a feature flag** — byte-identical to today when off (same discipline as the P3
   `delegation_briefs_enabled` flag and the `TASKBOARD_DENSE_RECALL` flag).
5. **Anti-thrash by construction** — debounce + cooldown + per-day cap + checkpoint-reset, to avoid
   consolidation storms.

---

## 3. Scope

**In scope (P2):** ONE new semantic-shift trigger gate on the consolidation path — running-session-summary
assembly, embedding via P0 `dense.ts`, cosine-distance comparison to a persisted checkpoint, a new
`semantic` gate in `checkTriggers()`/`TriggerGates`, both scheduler call sites consuming it, checkpoint
persistence + reset, the feature flag, and the anti-thrash guards. Additive and backward-compatible.

**Explicitly OUT of scope for P2** (do not build here):
- The consolidation ENGINE itself (`MemoryConsolidator.run()`, gather/validate/consolidate phases,
  decay/archive/prune) — P2 only adds a new *trigger*, it REUSES the engine unchanged.
- The retrieval stack — **P0 is CLOSED**; P2 *consumes* `embedOne()`/`cosineNormalized()`, it does not
  modify `recall()` or any retrieval path.
- Delegation briefs — **P3** (spec locked, build shipped).
- Pre-summarization sanitization / anti memory-laundering → **P4**.
- Concurrent-write ordering / directed messaging → **P5**.
- Typed failure classification / cross-family critique / ternary rewards → **P6/P7/P8**.
- Changing the existing time/volume/idle thresholds (`TRIGGER_INTERVAL_HOURS`, `VOLUME_THRESHOLD`, etc.).

---

## 4. Current state at `origin/main` (`242eb86`) — evidence-based, file:line cited

### 4.1 Consolidation triggers that EXIST today (the "RICH" set the brief credits)

| # | Trigger / path | What fires it | Nature | Evidence |
|---|----------------|---------------|--------|----------|
| C1 | Nightly batch script | Run-when-invoked (cron via `templates/com.threadwork.consolidate.plist`): status-TTL → decay → archive → prune → per-agent briefing | **time / schedule** | `consolidate.ts:102-130` |
| C2 | `checkTriggers()` gates | Returns `TriggerGates {time, volume, idle, lock}`. **time** = ≥6h since last run (`TRIGGER_INTERVAL_HOURS=6`); **volume** = >25 new in 6h OR >15% disputed (`VOLUME_THRESHOLD=25`, `DISPUTE_RATE_THRESHOLD=0.15`); **idle** = 0 `task_status_events` in 45min (`IDLE_MINUTES=45`); **lock** = no unexpired scope lock | **time / count / idle** | `consolidator.ts:217-262`; consts `:56-62`; `TriggerGates` type `:26-31` |
| C3 | `MemoryConsolidator.run()` engine | 5 phases Orient→Gather→Validate→Consolidate→Prune. `gather()` finds signals: **stale** (past 2× decay window), **duplicate** (identical normalized content), **disputed** (challenge≫support) | **time / content / count** | `consolidator.ts:264-363`; `gather` `:365-419` |
| C4 | Scheduler call sites (auto) | (a) **watchdog** `runConsolidationIfDue()` — primary always-on scheduler, 15-min tick, "Replaces the snoopy-bot.ts standalone loop"; (b) **snoopy-bot** `checkAndRun()` — legacy `setInterval` loop (superseded per C4a comment). Both: `checkTriggers()` → push reasons from `{time,volume,idle}` → if any AND `lock` → `run()` | **time-tick poll** | watchdog `watchdog.ts:1497-1530` (interval `config.ts:82`); snoopy-bot `snoopy-bot.ts:41-63` |
| C5 | Manual MCP tool | `consolidate_memories` — operator/agent-triggered `run()` (scope-aware) | **manual** | `server.ts:1349-1364`; tool decl `:383` |
| C6 | Decay window | `getDecayWindowDays()` — importance decay by classification + dispute/quality | **time (last_accessed age)** | `consolidate.ts:18-61` |
| C7 | Manual promote / human-approval digest | `promote_memory` (agent-initiated share); nightly promotion poller + human-approval digest | **manual / human-gated** | `server.ts:267,1164`; `system/bin/memory-promotion-poller.sh`; `system/launchd/com.threadwork.memory-promotion.plist` |
| C8 | Supersede / challenge | `supersede_memory`, `challenge_memory` (manual provenance flows) | **manual** | `server.ts:358,370,1330,1339` |
| C9 | Post-hoc session debrief | `force_debrief` / `run_hygiene` — debrief summarizes COMPLETED tasks → memory at session END (Gather/Solicit/Synthesize/Persist) | **session-END, manual** | `server.ts:521,527,1631,1647`; `debrief.ts` |

**Running-session-activity signal available today:** `task_status_events (agent, task_id, status, detail,
created_at)` — the live per-agent work narrative written by `write_status`. The **idle** gate already
queries it (`consolidator.ts:248-253`). This is the natural source for a "running session summary."
Schema: `db.ts:650-660`.

**Reuse primitives available today (P0 dense stack, SHIPPED) — `dense.ts`:**

| Primitive | Use for P2 | Evidence |
|-----------|-----------|----------|
| `embedOne(text)` → L2-normalized 384-dim vec | embed the running session summary | `dense.ts:245-249` |
| `cosineNormalized(a,b)` (== dot for normalized vecs) | distance to checkpoint | `dense.ts:155-160` |
| `isDenseEnabled()` (`TASKBOARD_DENSE_RECALL`) | precondition (embeddings only exist when dense is ON) | `dense.ts:93-95` |
| `getEmbedder()` — dynamic-imports `fastembed` ONLY when enabled (bge-small INT8 ONNX, 384-dim) | NO new ML dep; zero cost when off | `dense.ts:193-223` |
| `vecToBlob` / `blobToVec` | (de)serialize the checkpoint vec as a SQLite BLOB | `dense.ts:134-143` |
| `ensureVectorTable()` (idempotent sidecar-table pattern) | template for the checkpoint table | `dense.ts:254-271` |
| `DENSE_TRUNC_CHARS = 2000` | truncate the session summary before embed | `dense.ts:34` |
| `resolveSetting()` env→mcp.json fallback chain (module-PRIVATE) | resolve the P2 flag (needs export or a parallel helper — OQ-1) | `dense.ts:81-85` |

### 4.2 The gap — confirmed REAL at `242eb86`

`grep -rniE 'drift|semantic.?shift|checkpoint|embedding.?dist|intra.?session'` over the source returns
**zero** consolidation-trigger hits — the only matches are `scope-drift-advisor.sh` (card notes vs
description, unrelated), schema-drift guards (`watchdog.ts:14`), and FTS index-drift (`db.ts:1005`).
**Every existing consolidation trigger (C1-C9) is time-, volume-, idle-, count-, content-, manual-, or
human-gated. None embeds the running session and measures semantic distance.** The brief's P2 premise —
"the single MISSING trigger is semantic-shift" — holds at current remote. P2 is **0% closed**. P0's
dense stack (§4.1 reuse table) is the piece P2 leans on.

---

## 5. Gap analysis (delta: frontier target §2 vs current state §4)

| Gap | Frontier wants (§2) | Current (§4) | Severity |
|-----|---------------------|--------------|----------|
| **GAP-1 No semantic-shift trigger** | A gate that fires consolidation on intra-session topic drift. | Only time/volume/idle/count/content/manual gates (C1-C9). | P2 — core |
| **GAP-2 No running-session-summary embedding** | Periodically embed the running session summary. | `task_status_events` exists (the live narrative) but is never embedded; only counted (idle gate). | P2 — core (consumes P0 `embedOne`) |
| **GAP-3 No checkpoint / distance comparison** | Compare embedding distance to the last checkpoint vs a threshold. | No checkpoint vector is stored; no distance is ever computed. | P2 — core (consumes P0 `cosineNormalized`) |
| **GAP-4 No anti-thrash for a continuous trigger** | A continuous (distance) trigger needs debounce/cooldown/cap to avoid storms. | The discrete time/volume gates self-limit; a naive distance trigger would not. | P2 — guardrail |
| **GAP-5 No threshold calibrated on threadwork** | A distance threshold that separates genuine shifts from noise. | None exists; the GAM 40-vs-35 figure is an extrapolation (§2.2). | P2 — measure-first (OQ-3) |
| **GAP-6 No measure on threadwork** | Validate the trigger improves outcomes here before full build. | Unmeasured on threadwork. | P2 — measure-first (gates build scope; OQ-6) |

(6 gaps; GAP-5/GAP-6 are measure/calibration gaps that gate how heavily GAP-1..4 are built.)

---

## 6. Proposed changes (design only — no implementation in Stage 1)

**Design principle:** additive and backward-compatible behind a default-OFF feature flag. Flag OFF ⇒
`checkTriggers()` returns exactly today's `{time,volume,idle,lock}`, makes **no embed call**, touches
**no new table**, and the schedulers' reasons are unchanged — byte-identical to `242eb86`. Reuse `dense.ts`
as the embedding seam and `MemoryConsolidator.run()` as the consolidation seam; modify NEITHER's internals.

- **PC-1 (→GAP-1,GAP-2,GAP-3) New `semantic` gate inside `checkTriggers()`.**
  - Extend `TriggerGates` (`consolidator.ts:26-31`) with `semantic: boolean`.
  - When the P2 flag is OFF **or** `isDenseEnabled()` is false → `semantic=false`, return early, **no embed**.
  - When ON: (a) assemble the running session summary = recent `task_status_events.detail` for this scope
    (the idle gate's own table), concatenated newest-first and truncated to `DENSE_TRUNC_CHARS` (window =
    OQ-2); (b) `embedOne(summary)` → current vec; (c) load the last checkpoint vec for this scope (PC-3);
    (d) if no checkpoint → store it, `semantic=false` (first observation never fires — see AC-8);
    (e) `distance = 1 − cosineNormalized(current, checkpoint)`; `semantic = distance > SEMANTIC_SHIFT_THRESHOLD`
    AND the anti-thrash guards (PC-5) permit it.

- **PC-2 (→GAP-1) Scheduler wiring (two-line change at each site).**
  - In `watchdog.ts:1506-1510` and `snoopy-bot.ts:42-47`, add `if (triggers.semantic) reasons.push('semantic')`.
    No other scheduler change — the existing `reasons.length>0 && triggers.lock → run()` flow carries it.
    `run(triggerReason)` already records the reason in `consolidation_runs` for observability.
  - OQ-7: snoopy-bot's loop is legacy (superseded by the watchdog per `watchdog.ts:1494`). Decide whether to
    wire BOTH or watchdog-only, to avoid a double-fire if both daemons are live.

- **PC-3 (→GAP-3) Checkpoint persistence (new sidecar table).**
  - New idempotent `consolidation_checkpoints` table (ensure-pattern mirroring `ensureVectorTable`
    `dense.ts:254`): `scope TEXT PRIMARY KEY, dim INT, model TEXT, vec BLOB, summary_hash TEXT,
    last_semantic_trigger_at TEXT, triggers_today INT, day TEXT, updated_at TEXT`. Vec stored via
    `vecToBlob`/`blobToVec`. Created lazily on the first flag-ON run (so a flag-OFF server never creates it).
    Migration discipline = P0's guarded-block pattern. Exact shape → OQ-4.
  - **Checkpoint reset:** after ANY successful `run()` (semantic or otherwise), UPDATE the checkpoint to the
    current embedding so the distance baseline resets — built-in hysteresis that stops the same drift from
    re-firing every tick.

- **PC-4 (→GAP-2) Running-session-summary assembly helper.**
  - A small pure helper `assembleSessionSummary(scope, window)` → string from `task_status_events.detail`
    (scope-aware: `all` = all agents, `agent:NAME` = one agent's stream). Bounded by row-count/time window
    and `DENSE_TRUNC_CHARS`. No new query path beyond the table the idle gate already reads.

- **PC-5 (→GAP-4) Anti-thrash guards (avoid consolidation storms).**
  - **Cooldown:** no semantic-triggered run within `SEMANTIC_MIN_INTERVAL_MS` of the last one (default ≥30 min;
    independent of the 6h `time` gate). Persisted in `last_semantic_trigger_at` (survives restarts).
  - **Debounce:** require `distance > threshold` on ≥2 consecutive checks before firing (rejects single-tick spikes).
  - **Per-day cap:** `SEMANTIC_MAX_PER_DAY` per scope (default ≤4) via `triggers_today`/`day`.
  - **Lock reuse:** the existing scope `lock` gate already serializes concurrent runs.
  - **Checkpoint reset** (PC-3) is itself anti-thrash. Exact constants → OQ-5 (calibrated by PC-6).

- **PC-6 (→GAP-5,GAP-6) Measure-first verdict (lightweight, BEFORE full build).**
  - Out-of-tree, read-only on a DB copy (P0/GAP-4 precedent, council #10060795): from real
    `task_status_events`, (a) reconstruct rolling session summaries, embed them with the shipped `dense.ts`,
    and chart the **cosine-distance distribution** over time; (b) confirm intra-session shifts actually occur
    and are MISSED by today's 6h/volume/idle gates; (c) pick a `SEMANTIC_SHIFT_THRESHOLD` that separates real
    topic-shifts from noise; (d) estimate whether semantic-triggered consolidation would improve memory
    F1/recall vs time-based alone on a threadwork sample. If the signal is immaterial, recommend the *minimal*
    slice (or NO-BUILD); if material, build PC-1..5 with the calibrated constants. Scope → OQ-6.

**Do NOT add:** any change to `MemoryConsolidator.run()`/gather/validate/decay (P2 is trigger-only); any change
to `recall()` / the retrieval stack (P0 closed); P3/P4/P5 work; a second embedder / new ML dep.

---

## 7. Acceptance criteria / full-checklist verification

A later builder may mark P2 complete only when ALL of the following are evidence-checked:

- [ ] **AC-1** `git fetch origin` re-run; §4 current-state re-confirmed against the then-current `origin/main`
      SHA (re-verify no semantic/checkpoint trigger has appeared and the `dense.ts`/`consolidator.ts` seams
      still match the cited lines).
- [ ] **AC-2 (byte-identical when OFF)** With the P2 flag OFF (default): `checkTriggers()` returns the exact
      `{time,volume,idle,lock}` of `242eb86` (semantic=false), makes **zero** embed calls, creates/touches
      **no** `consolidation_checkpoints` table, and both schedulers' `reasons` + `consolidation_runs` rows are
      byte-for-byte identical to today. Verified by test.
- [ ] **AC-3 (reuse P0 embeddings, no new dep)** Embedding routes through `dense.ts` `embedOne()` and distance
      through `cosineNormalized()`; NO new ML dependency, no second embedder, `package.json` unchanged. Verified
      by test + dependency diff.
- [ ] **AC-4 (additive gate)** `TriggerGates` gains `semantic`; `checkTriggers()` computes it; BOTH wired
      scheduler sites consume it; the manual `consolidate_memories` path is unaffected. Verified by test.
- [ ] **AC-5 (checkpoint persist + reset)** Checkpoint vec is persisted per scope and reset to the current
      embedding after every successful `run()` (distance baseline resets, no immediate re-fire). Verified by test.
- [ ] **AC-6 (anti-thrash)** Cooldown (`SEMANTIC_MIN_INTERVAL_MS`), debounce (≥2 consecutive), and per-day cap
      (`SEMANTIC_MAX_PER_DAY`) all enforced. A "rapid-drift storm" test proves the number of semantic triggers
      stays bounded. Verified by test.
- [ ] **AC-7 (precondition degrade)** With dense OFF (`isDenseEnabled()` false), the semantic path silently
      no-ops — never embeds, never throws — exactly like `dense.ts` degrades to BM25. Verified by test.
- [ ] **AC-8 (first observation)** No checkpoint for a scope ⇒ store the current embedding and do NOT trigger.
      Verified by test.
- [ ] **AC-9 (scope guard)** Diff audit: no changes to `MemoryConsolidator.run()`/gather/validate/decay logic,
      no `recall()`/retrieval changes, no P3/P4/P5 code, no existing-threshold changes.
- [ ] **AC-10** Board + dashboard updated; spec referenced from the umbrella; PR opened only at the pre-deploy
      gate (§8).
- [ ] **AC-11 (measure-first)** PC-6 verdict delivered (threadwork drift-distance distribution + a calibrated
      `SEMANTIC_SHIFT_THRESHOLD` + an F1/recall-uplift estimate vs time-based), with the build-scope
      recommendation it implies (no-build / minimal / full). This GATES the build (§8).

---

## 8. Run-config to honor

- **Execution model:** Stage-and-Gate. This document is **Stage 1 (spec-lock)** output only.
- **Verification:** full-checklist (§7), not spot-check.
- **Persistence:** board writes + dashboard mirror for all progress and any measurement artifacts.
  Measurement scratch (raw `task_status_events` dumps, embedding caches) MUST be gitignored — do not repeat
  the Stage-2a 4MB `memdump.json` leak.
- **Specs location:** `/specs` (this file: `specs/P2-semantic-shift-consolidation-frontier-alignment.md`).
- **Budget:** unlimited.
- **Human checkpoints — Boss-gated gates:**
  1. **Spec-lock (FIRST / current gate):** Boss + Gwei review and lock THIS spec before any build.
  2. **Measure-first gate (PC-6 / AC-11):** the measurement verdict gates build scope (no-build / minimal / full).
  3. **Pre-deploy gate:** Boss-only gate before shipping (Boss holds deploy perms). No deploy without it.
- **Ownership:** kiera = spec author/driver. Boss = umbrella #10060787 owner + human-checkpoint gates.
- **Commit discipline:** Stage 1 leaves this spec UNCOMMITTED on disk; Boss commits on spec-lock approval.

---

## 9. Open questions for Boss/Gwei spec-lock review

- **OQ-1 (flag + resolver):** Flag name (proposed `TASKBOARD_SEMANTIC_CONSOLIDATION`, default OFF). Reuse
  `dense.ts`'s `resolveSetting` (env→mcp.json) by EXPORTING it, or add a parallel `isSemanticConsolidationEnabled()`
  helper? P2 also depends on dense being ON — make that an explicit precondition (AC-7) or its own sub-flag?
- **OQ-2 (session-summary definition):** "Running session summary" = rolling `task_status_events.detail`.
  What window — last N rows or last M minutes? And what scope granularity — global `all` (all agents' streams),
  or per-agent `agent:NAME` (more sensitive to one agent's drift but multiplies embed cost)? GAM's "session" is a
  single conversational thread; threadwork's is a multi-agent event stream — is that the right analog, or should
  it be a per-agent live transcript (OQ tied to the GAM extrapolation caveat §2.2)?
- **OQ-3 (threshold + metric):** Cosine distance (`1 − cosineNormalized`) on bge-small vectors. Starting default
  ~0.25–0.35 is a GUESS — must be calibrated by PC-6 before relying on it. Confirm metric + that the value is
  measure-set, not hard-coded blind.
- **OQ-4 (storage shape):** New `consolidation_checkpoints` sidecar table (proposed) vs reusing an existing table
  (e.g. a row in `consolidation_runs` metadata). Column set as in PC-3?
- **OQ-5 (cadence + anti-thrash constants):** Piggyback the existing 15-min watchdog tick vs a dedicated interval;
  debounce N (proposed ≥2 consecutive); cooldown `SEMANTIC_MIN_INTERVAL_MS` (≥30 min); `SEMANTIC_MAX_PER_DAY` (≤4).
  Confirm these are PC-6-tunable, not frozen.
- **OQ-6 (measure-first scope):** The 40-vs-35 F1 is a GAM extrapolation (§2.2). Run the PC-6 study (drift
  distribution + threshold calibration + uplift estimate) BEFORE the full build, per the P0/GAP-4 / council
  #10060795 precedent? And does the verdict gate to no-build / minimal / full?
- **OQ-7 (dual scheduler):** snoopy-bot's loop is legacy (superseded by the watchdog per `watchdog.ts:1494`).
  Wire the semantic gate into BOTH or watchdog-only (and is snoopy-bot even running)? Avoid double-fire / double
  embed cost. Also confirm `CONSOLIDATION_DRY_RUN=false` (`config.ts:81`) is the intended live posture for
  semantic-triggered runs.
- **OQ-8 (sequencing + benchmark pointer):** Confirm P2 is the intended current item (Gwei-picked, TG 7420) ahead
  of the earlier-noted DG1/DG2/P5 order. And — echoing the P3 OQ — advance the umbrella's benchmark pointer to
  `242eb86` so later children stop re-deriving stale current-state verdicts.

---

*End of P2 semantic-shift-consolidation frontier-alignment spec — Stage 1 (spec-lock). No implementation performed.*
