# Nudge Delivery Fix Sprint — Spec

**Author:** Boss (synthesized from LLM Council, chairman timed out)
**Date:** 2026-04-09
**Source:** Council report at /tmp/council-nudge-report.md (4 of 5 models responded fully, unanimous on all 6 sub-questions)
**Authority:** Snoopy directive 2026-04-09 18:50 EEST — no stops, strict spec gate hard-enforced, /god-mode v3 with sonnet-medium generator + sonnet-high verifier + /god-monitor loop

---

## Council Consensus (Stage 1, unanimous 4/4 responding models)

Grok-4.20, gpt-5.4-pro, deepseek-r1, and llama-4-maverick all agreed on every sub-question. Gemini cut off mid-sentence after validating the root cause. Stage 2 rankings mostly failed (single evaluator responded) and Stage 3 chairman timed out, but the Stage 1 signal is already strong and converged.

### Q1. ROOT CAUSE — **(a) fractured nudge code path / missed routing**

The unanimous answer: at least one of the 5 server.ts nudge callsites (or additional unlisted paths) is writing `audit_log(action='agent_nudged')` without going through `debounce.ts::tryNudge()`.

Smoking gun: Sadie's `tw_nudge_debounce` row is pristine (`last_nudged_at=NULL`, `pending_count=0`) while audit_log has 5 `agent_nudged` rows targeting her. If `tryNudge()` had been invoked, the debounce row would have been UPSERTed.

**Dissent (gpt-5.4-pro):** noted that a pure stale-tmux theory doesn't explain the untouched debounce row unless there are TWO bugs at once. Ruled out as primary.

**Dissent (none):** on the primary diagnosis.

### Q2. FIX STRATEGY — **(a) consolidate into a single nudge code path** (with one dissent favoring tactical wrap-first)

Majority: create ONE exported function — `dispatchAgentNudge(agentId, urgency, reason, source?)` in a dedicated module (e.g. `src/nudge.ts` or `debounce.ts::nudgeWithDebounce`). All 5 server.ts callsites call this function. Remove/ban direct audit_log('agent_nudged') and direct tmux send-keys outside the dispatcher.

Dispatcher responsibilities (ordered):
1. Resolve target pane/session FRESH (stateless, no cache)
2. Run `tryNudge()` if flag is on
3. If suppressed → write suppression event, return `{shouldFire: false, ...}`
4. If should fire → send to tmux, write fired event, optionally verify delivery in canary/debug mode

**Strongly recommended semantic cleanup (gpt-5.4-pro):** rename action strings so they mean what they say:
- `nudge_requested` (intent)
- `nudge_suppressed` (debounce blocked)
- `nudge_sent` (tmux send succeeded)
- `nudge_delivery_failed` (tmux send errored)
- optional `nudge_acked` (future)

Keep `agent_nudged` ONLY as an alias for `nudge_sent` if needed for backwards compatibility with the existing metrics view.

**Dissent (deepseek-r1):** suggested Option (b) first (minimal wrap the missed callsites), then (a) as follow-up. Reasoning: medium urgency warrants surgical fix to restore Sadie within 4h, then architectural cleanup. The majority (gpt-5.4-pro, grok, llama) rejected this because: (1) partial migration IS what caused the bug, (2) we're on Claude Max with no time pressure, (3) god-mode v3 with spec-gate can land the consolidation safely in one pass.

**BOSS DECISION:** Majority wins. Consolidate in one sprint, no tactical wrap.

**REJECTED (unanimous):** middleware interceptor — too implicit, harder to debug, won't catch nonstandard send paths, can preserve the same fragmented semantics under the hood.

### Q3. METRICS FIX — **expand view to include all currently-emitted literals**, then deprecate the stringly metric later

Immediate: patch `v_nudge_metrics_24h` to count BOTH the legacy action strings AND the new canonical ones the dispatcher will emit. This makes metrics visible immediately post-fix.

Medium-term: move away from ad-hoc action-string greps in a view. Better options:
- Dedicated `tw_nudge_events` table with typed columns
- Or a stricter event-enum/action-constant contract centralized in one module + an integration test that asserts ALL action constants appear in the view

**Dissent (gpt-5.4-pro):** noted fixing the view alone won't help if debounce events are never emitted. Fix the root cause FIRST, then the view.

**BOSS DECISION:** Land dispatcher consolidation + view expansion in the same sprint. View changes are a 1-line SQL patch.

### Q4. TMUX DELIVERY VERIFICATION — **(c) stateless session lookup every call** is the primary fix, combined with preflight checks and deferred ACK

Ranked: (c) > (b) > (a)

- **(c) stateless lookup on every nudge** — resolve pane/session/window FRESH. Never cache tmux handle/pid for an agent across respawns. Log: agent, resolved target, pane_id, pane_pid, session_name, callsite/reason.
- **Preflight:** before send, confirm pane exists via `tmux has-session` and/or `list-panes`. If not found, emit `nudge_delivery_failed` with reason=`no_target_pane`.
- **(b) nudge ACK from target agent** — deferred. Strongest end-to-end mechanism but requires agent behavior changes + timeout state. Good as follow-up sprint.
- **(a) synchronous pane-poll with nonce** — good for debug/canary only. Racy in production.

**Dissent (gpt-5.4-pro):** argued ACK should arguably be first because it proves actual agent consumption. Acknowledged this would be slower to restore Sadie today, so not-first.

**BOSS DECISION:** Stateless lookup + preflight in this sprint. ACK is out of scope (follow-up sprint).

### Q5. TESTING — **integration tests against real tmux, no mocks for the delivery layer**

Required test files (unanimous):

1. **`tests/integration/nudge-routing.test.ts`** — real tmux integration, isolated tmux server per test run via `tmux -L threadwork-test -f /dev/null`. Temp SQLite DB, real bun server, real tmux panes for test-sadie + test-steve. Trigger each of the 5 callsites, assert:
   - audit_log shows the expected event sequence (requested → fired/suppressed → sent)
   - tw_nudge_debounce row was updated
   - `capture-pane` on the target test pane shows the expected nudge string
2. **`tests/integration/nudge-debounce.test.ts`** — with `THREADWORK_DEBOUNCE_ENABLED=1`:
   - first nudge fires, pane receives it, debounce row updated
   - second nudge inside window suppresses, pane does NOT receive it, pending_count incremented
   - urgent nudge inside window bypasses suppression
3. **`tests/integration/nudge-respawn.test.ts`** — stale-pane regression catching hypothesis (c):
   - start test-sadie pane
   - send successful nudge, verify delivery
   - kill + recreate the test-sadie session (simulating today's respawn)
   - send again
   - assert delivery reaches the NEW pane, not the old cached handle
4. **`tests/sql/v_nudge_metrics_24h.test.ts`** — view smoke test. Insert synthetic audit_log events, query the view, assert counts match. Fails if the view's action-string grep doesn't match the dispatcher's emitted strings.
5. **`tests/guardrails/no-direct-nudge-paths.test.ts`** — CI guardrail. Grep (or AST walk) the codebase:
   - No `audit_log('agent_nudged'...)` outside `dispatchAgentNudge`
   - No direct `tmux send-keys` invocation outside `dispatchAgentNudge`
   - Fails CI if anyone reintroduces a bypass path

**Rejected (unanimous):**
- Mocks for tmux (hide exactly this failure mode)
- Unit tests only around `tryNudge()` (don't exercise the missing callsite)
- Metrics-only validation (blind if the dispatcher emits different strings)

### Q6. ROLLOUT — **DO NOT promote to Stage 2. Restart Stage 1 from zero post-fix**

Unanimous: current Stage 1 data is contaminated by (1) probable route inconsistency, (2) probable metrics blindness, (3) Sadie missing actual delivery. The 2h observation window is not measuring what we think it is.

Safe rollout order:

**Step 1.** Land the hotfix via /god-mode v3:
- **Patch A — delivery path:** new `dispatchAgentNudge`, rewire all 5 callsites, stateless tmux resolution, standardized event names
- **Patch B — observability:** fix `v_nudge_metrics_24h` view (union old + new action strings), centralize action constants in one module
- **Patch C — tests/guardrails:** 5 test files above, all green before deploy

**Step 2.** Flip `THREADWORK_DEBOUNCE_ENABLED=0` before deploy. Ship the fix in "pass-through" mode first to prove the dispatcher works without debounce.

**Step 3.** Canary verification (real, against live agents, before declaring Stage 1 resumed):
- Manually trigger a Sadie nudge (via delegate_task or direct server.ts test)
- Manually trigger a Steve nudge
- Verify on BOTH:
  - pane delivery (capture-pane shows the nudge string)
  - debounce row mutation (when flag flipped back on)
  - fired/suppressed metrics present in view
  - correct target resolution in logs (fresh pane_id, not cached)

**Step 4.** Re-flip `THREADWORK_DEBOUNCE_ENABLED=1`. Restart the Stage 1 24h observation clock from canary confirmation time. Do not count the pre-fix 2h.

**Step 5.** Promote to Stage 2 only after a clean 24h Stage 1 with:
- Successful Sadie delivery across the window
- Expected Steve delivery across the window
- Nonzero fired/suppressed metrics in `v_nudge_metrics_24h`
- No stale-target anomalies (respawn test passes in production)

**Dissent (deepseek-r1):** argued Stage 1 could continue without full reset if post-fix Sadie delivery is verified for 2h. Majority rejected on the grounds that v2-lite success criteria (suppression_rate ≥ 0.60, wake_latency_p99 ≤ 90s) need a clean 24h window to be statistically meaningful.

**BOSS DECISION:** Majority. Restart Stage 1 from zero.

---

## Strict Spec Gate (hard-enforced, negotiated with verifier per Snoopy 18:51)

The verifier is instructed to REFUSE to mark this sprint complete unless EVERY one of the following is true:

### MUST-PASS gates

1. `dispatchAgentNudge` exists in a NEW file (not inlined in server.ts), with a public export
2. All 5 server.ts callsites at the originally-identified lines (621/670/774/834/1013, may have drifted) OR any other site that was emitting `agent_nudged` call `dispatchAgentNudge` and nothing else
3. Grep across the entire codebase for `audit_log('agent_nudged'` OR `audit_log("agent_nudged"` returns EXACTLY ONE match, inside `dispatchAgentNudge`
4. Grep across the entire codebase for literal `send-keys` or `tmux.*send` returns matches ONLY inside `dispatchAgentNudge` or test files
5. `v_nudge_metrics_24h` view includes BOTH the old `agent_nudged`/`nudge_fired` strings AND whatever new canonical names the dispatcher emits
6. Action constants are centralized in one module (e.g. `src/constants/nudge-actions.ts`) with a TypeScript enum or const union
7. ALL 5 new test files exist and pass against real tmux:
   - `tests/integration/nudge-routing.test.ts`
   - `tests/integration/nudge-debounce.test.ts`
   - `tests/integration/nudge-respawn.test.ts`
   - `tests/sql/v_nudge_metrics_24h.test.ts`
   - `tests/guardrails/no-direct-nudge-paths.test.ts`
8. The respawn test specifically asserts that killing + recreating a tmux session does NOT cause subsequent nudges to land on the old cached pane — assert via capture-pane that the NEW pane received the nudge
9. `bun test` returns ALL previously-passing tests green (no regressions in Sadie's 24 v2-lite tests, no regressions elsewhere)
10. The guardrail test FAILS if a synthetic bypass is introduced (verifier MUST demonstrate this by temporarily adding a bypass line, running the test, confirming it fails, then reverting)
11. Canary verification: after deploy, real nudges to Sadie land in her tmux pane (verified via `tmux capture-pane -t claude-sadie -p | tail -30` showing the dispatcher nudge text)

### DEPLOY-GATE (nothing deploys without all 11)

The verifier is NOT allowed to mark the task complete OR authorize `netlify deploy` / MCP restart until all 11 pass. If ANY gate fails, the verifier returns the specific failure with file:line evidence and the generator iterates.

### NO-ROLLBACK GATE

The verifier is also NOT allowed to suggest rolling back the v2-lite sprint as a workaround. The fix must land forward. The only "rollback" path is flipping `THREADWORK_DEBOUNCE_ENABLED=0` AFTER the dispatcher is in place (Step 2 of the rollout), which is not a rollback of code, only a flag flip.

---

## /god-mode v3 Invocation Parameters

**Generator:** sonnet-medium thinking mode (implementation lane)
**Verifier:** sonnet-high thinking mode (verification lane + spec gate enforcement)
**Monitor:** /god-monitor loop (self-healing, auto-unstick every 1 min)
**Auto-approval:** authorized for all file edits, Bash commands, migrations, test runs, and the final canary deploy

**Reference files:**
- Spec (this file): /Users/coachstokes/threadwork/sprints/2026-04-09-nudge-delivery-fix-spec.md
- Original v2-lite spec: /Users/coachstokes/threadwork/sprints/2026-04-09-v2-lite-watchdog-sprint.md
- Council report: /tmp/council-nudge-report.md
- Target codebase: /Users/coachstokes/.claude/mcp-servers/task-board/

**Out of scope (explicitly deferred):**
- Nudge ACK from target agent (Q4 option b) — follow-up sprint
- Dedicated tw_nudge_events typed table (Q3 medium-term) — follow-up sprint
- AST-based guardrail (we're accepting grep-based in this sprint)
- Rewriting the v2-lite Stage 1 observation from scratch (we just restart the clock, no data wipe)
