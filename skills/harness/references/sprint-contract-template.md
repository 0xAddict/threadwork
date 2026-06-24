# Sprint Contract Template

Generator writes `proposed-contract.md` BEFORE implementing anything. Boss reviews and writes `approved-contract.md` (often identical, sometimes revised). Verifier grades against the approved contract.

## Required Sections

```markdown
# Sprint N Contract — <short title>

**Status:** PROPOSED | APPROVED
**Author:** Generator (opus, harness #<task_id>)
**Date:** YYYY-MM-DD

## Goal
One paragraph. What this sprint produces and why.

## Scope (files to create/modify)
1. <abs path> — <one-line purpose, line budget>
2. ...

## Out of Scope (deferred)
- <items the user might expect but this sprint won't ship>

## Acceptance Criteria
1. <testable assertion>
2. <testable assertion>
...

## Test Commands (for Verifier)
```bash
# AC1
<command that exits 0 on pass>
# AC2
...
```

## Definition of Done
- All ACs pass their test commands.
- Generator writes `implementation-log.md` with files-changed manifest + decisions.
- `status.txt` set to `ready_for_evaluation`.
- No edits outside the scoped paths.

## Target Metrics
- Verifier overall ≥ 78, functionality ≥ 9/10 (PASS threshold).
- LOC: <budgets per file>.
- Files created: exactly <N>.

## Risks / Open Questions for Boss
- R1 — <ambiguity>: <fallback if unanswered>
- R2 — ...
```

## Verifier Rubric

Verifier scores 5 dimensions (each 0–10), reports overall as sum (0–50) scaled to 0–100. PASS bar: overall ≥ 78 AND functionality ≥ 9.

| Dimension | Question |
|-----------|----------|
| Functionality | Does it do what the contract says? Test commands exit 0? |
| Code quality | Reads cleanly, no obvious smells, follows codebase conventions |
| Test coverage | ACs have evidence; manual checks documented |
| Scope discipline | No collateral edits; respected out-of-scope list |
| Documentation | Implementation-log explains decisions; future-Steve can follow |

## Verifier Report Skeleton

```markdown
# Verifier Report — Sprint N

**Verdict:** PASS | PARTIAL | FAILED
**Overall:** XX/100
**Per-dimension:** Func X/10, Quality X/10, Tests X/10, Scope X/10, Docs X/10

## Test Run
- AC1: PASS — <evidence>
- AC2: FAIL — <what went wrong>
...

## Findings
- <substantive notes, even on PASS>

## Recommendation
- ADVANCE | RETRY | PIVOT
```
