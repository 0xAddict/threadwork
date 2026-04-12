# Decision Log — Threadwork Upgrade

## 2026-04-07: Council Evaluation Complete
- 6 LLM Council sessions evaluated the ClawHarness integration plan
- Unanimous verdict: SHIP IT
- Key architectural decisions locked:
  - Phase 0 foundation added before blackboard (provenance IDs, WAL, feature flags)
  - Phases 2+3 merged into unified execution events
  - Gates moved after circuit breakers (tmux transport noise vs noncompliance)
  - Soft quarantine instead of hard block (4-agent team can't lose 25%)
  - Findings decouple from complete_task (crash survivability)
  - tmux = debug surface, not control plane

## 2026-04-08: Harness Pipeline Launched
- Generator (Opus) + Verifier (Sonnet) spawned
- 6 sprints targeting all 6 phases
- /loop 1m self-healing monitor active
- Alpha-verify review planned on completion
