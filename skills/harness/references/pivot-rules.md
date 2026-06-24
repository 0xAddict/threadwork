# Pivot Rules

The harness's pivot rule prevents wasting cycles polishing a flawed foundation.

## The Rule

**Two consecutive sprint failures with overall score < 72 → PIVOT, do not polish.**

## What "PIVOT" means

Stop trying to make the current approach work. Go back one level in the decision tree:

1. Re-read the roadmap entry for the failing sprint.
2. Open `decision-log.md`. Add an entry: `pivot from <approach A> because <evidence from verifier reports>`.
3. Generator proposes a NEW contract for the same roadmap goal but with a different architecture / library / data shape.
4. Boss approves the new approach (sprint number does NOT increment — it's still sprint N, attempt 3).
5. Generator implements; Verifier grades.

## When NOT to pivot

- One failed sprint at score 60: retry once, fix the verifier-flagged issues, do not pivot yet.
- One failed sprint at score 75 with one bad AC: retry, fix that AC, advance.
- Two failed sprints at score 80+: that's polish-territory; advance with a documented compromise OR retry one more time. Don't trigger pivot here — the foundation is sound.

## When to pivot EARLY

- Verifier says functionality = 0 (the thing literally doesn't work) on the first try AND Generator's implementation log shows it spent the budget fighting the chosen architecture: pivot immediately, don't wait for sprint 2.
- Verifier flags a fundamental scope misunderstanding (the contract was wrong, not the code): re-negotiate the contract first, don't blame the code.

## Pivot Log Format

In `decision-log.md`:

```markdown
## Sprint N — Pivot

**Date:** YYYY-MM-DD
**From:** <approach A> (sprint-N-attempt-1, score XX; sprint-N-attempt-2, score XX)
**To:** <approach B>
**Trigger:** 2x failures at <72 OR <other early-pivot signal>
**Evidence:** verifier-report.md says <quote>
**New contract:** sprints/sprint-N/proposed-contract-attempt-3.md
```

## Generator Anti-Patterns That Trigger Pivot

- Implementation-log keeps adding "fix attempt N" entries — sign the architecture is wrong.
- Verifier flags the same dimension low across 2 sprints (e.g. test coverage = 4 both times) — sign the testing approach can't reach the code shape.
- Sprint takes >2x its budget — sign the scope was wrong; renegotiate, don't grind.
