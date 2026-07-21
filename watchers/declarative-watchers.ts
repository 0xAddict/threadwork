// watchers/declarative-watchers.ts — EPIC-PF2 declarative watchers (PF-spec.md,
// ~/.claude/state/p4-p8-fanout/specs/PF-spec.md, REQ-PF2-01..18 / ATM-PF2-01..16).
//
// Scaffold-only stub (PK-PF2-0). No logic lands here yet. Later PF2 packets
// (PK-PF2-1..6, per ~/.claude/state/pf-build/PHASE1-PLAN.md section (b)) add:
// createWatcher() / condition_spec validation (PK-PF2-2), the three bounded
// condition evaluators — evaluateScheduledCondition() (interval-only, injected
// clock), evaluateStateChangeCondition() (transition-only, watched_selector XOR
// watched_aggregate allowlisted to COUNT/MAX/MIN/SUM, UNAVAILABLE on 0/>1 row),
// evaluateLlmCondition() (one bounded prompt, default-false on ambiguity) —
// (PK-PF2-3), fireWatcher() / idempotency via DB-level UNIQUE + getWatchers() /
// disableWatcher() (PK-PF2-4), and the additive, flag-gated, fault-isolated
// evaluateWatchers() wiring into watchdog.ts's main tick loop plus the 3 new
// MCP tool cases in server.ts (PK-PF2-5).
//
// This module is deliberately a separate top-level namespace from `reflection/`
// (EPIC-PF1) — PF2 has zero logic overlap with PF1 per PF-spec.md's
// Overlap/Isolation Proof; the only shared file between the two epics is
// db.ts's migrate() (additive, disjoint tables/flags). No open expression
// evaluation is permitted anywhere in this module or its eventual condition
// evaluators — zero eval(/new Function( ever (static-scan gate). Firing must
// reuse the EXISTING create_task path (fireWatcher() is not a new
// task-creation primitive) and must never touch findStaleTasks/
// determineAction/escalation-creation or the watcher_heartbeat table/DDL/call
// sites — those are a different, pre-existing mechanism this must not collide
// with. New tables are declarative_watchers / declarative_watcher_firings
// (deliberately NOT "watchers" — collision guard vs. the existing
// watcher_heartbeat table).

export {};
