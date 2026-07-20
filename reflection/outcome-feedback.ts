// reflection/outcome-feedback.ts — EPIC-PF1 outcome-feedback loop (PF-spec.md,
// ~/.claude/state/p4-p8-fanout/specs/PF-spec.md, REQ-PF1-01..11 / ATM-PF1-01..11).
//
// Scaffold-only stub (PK-PF1-0). No logic lands here yet. Later PF1 packets
// (PK-PF1-1..5, per ~/.claude/state/pf-build/PHASE1-PLAN.md section (b)) add:
// recordExpectedOutcome() / persistOutcomeExpectation() (PK-PF1-2), the pure
// diffOutcome() comparator (PK-PF1-2), reflect() / distillSharedPattern() /
// supersedeSharedPattern() (PK-PF1-3), and the additive, flag-gated,
// try/catch-swallowed wiring into debrief.ts's post-summarise step and the
// server.ts claim_task/delegate_task pre-act path (PK-PF1-4).
//
// This module is deliberately a separate top-level namespace from
// `verification/` — PF1 is not a verification-axis capability (see PF-spec.md
// Overlap/Isolation Proof carve #1). It must read the existing verification-axis
// triad (getFailureClassifications/getCrossFamilyCritiques/getTernaryRewards)
// strictly SELECT-only, and per the Persistence idiom section of PF-spec.md,
// all PF1 writes use the LOCAL BEGIN IMMEDIATE idiom (decision.ts:156-206) —
// never P5's memory-write-transaction primitive (that helper belongs to the
// P5 namespace; see PF-spec.md for why PF1 must not depend on it).

export {};
