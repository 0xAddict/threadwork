---
name: premortem
description: Run a premortem on a plan, launch, product, hire, strategy, partnership, pricing change, or high-stakes decision by assuming it failed 6 months from now and working backward to identify why. Use when the user says "premortem this", "premortem my", "run a premortem", "what could kill this", "future-proof this", "stress test this plan", "what am I missing here", "find the blind spots", "what could go wrong", "am I missing anything", "poke holes in this", "where will this break", or "devil's advocate this" in relation to a concrete plan or commitment. Do not use for simple factual questions, ordinary draft feedback, vague ideas with no plan yet, or LLM Council requests.
---

# Premortem

Run a prospective-hindsight failure analysis: assume the plan has already failed 6 months from now, then work backward to identify why, what assumptions enabled the failure, and how to revise the plan before execution.

## Use When

Use this skill for concrete, reversible plans or commitments where the cost of being wrong is meaningful:

- Product or feature launches
- Pricing or business model changes
- Hiring decisions
- Strategic pivots or positioning changes
- Partnerships, deals, or major operational commitments
- Any launch, plan, or decision the user asks to stress test for blind spots

Do not use this skill for:

- Vague ideas with no concrete plan yet; help define the plan first
- Questions with one correct factual answer
- Creative editing or ordinary feedback on a draft
- Decisions that are already irreversible
- LLM Council requests

## Context Minimum

Before running the premortem, make sure you know:

1. **What it is**: the plan, product, launch, hire, strategy, or decision in one sentence.
2. **Who it affects**: customer, audience, team, buyer, stakeholder, or user.
3. **What success means**: the outcome the user wants.

First scan existing context:

- Current conversation
- `CLAUDE.md` or `claude.md`
- `memory/`
- Files explicitly referenced by the user
- Nearby briefs, plans, docs, or project files that appear relevant

Keep this scan quick, roughly 30 seconds. Prefer `rg` and `rg --files`.

If any of the three minimum context items are missing, ask the smallest useful question and wait. Ask one question at a time. Proceed as soon as the context threshold is met.

Useful questions:

- "What specifically are you about to launch, build, or decide?"
- "Who is this for or who does it affect?"
- "What does a win look like for this?"

## Premortem Frame

Always set the frame explicitly before analysis:

> It is 6 months from now. This plan has failed. It is done. We are looking back to understand what went wrong.

This is not a generic risk review. The frame must be failure already happened.

## Workflow

### 1. Raw Failure Reasons

Generate a comprehensive list of genuine failure reasons.

Rules:

- Ground every reason in the user's actual plan and context.
- Include every real failure mode, but do not pad the list.
- Use 1-2 sentences per reason.
- Avoid generic risks that would apply to any plan.
- Ignore minor inconveniences and extremely unlikely edge cases.

### 2. Parallel Deep Dives

Run one independent deep dive per failure reason. Use parallel subagents when available. If subagent tooling is unavailable, perform separate independent passes and avoid letting earlier analyses steer later ones.

Use this prompt shape for each deep dive:

```text
You are an investigator in a premortem analysis. You have been assigned one specific failure reason to analyze in depth.

The plan:
---
[full context: what it is, who it is for, what success looks like, plus relevant workspace context]
---

PREMORTEM FRAME: It is 6 months from now. This plan has failed.

YOUR ASSIGNED FAILURE REASON: [specific failure reason]

Your job is to go deep on this one failure. Write the story of how it actually played out. Be specific. Use details from the plan. Make it feel real, like a case study of something that actually happened.

Your output should include:

1. THE FAILURE STORY: A 2-3 paragraph narrative of how this specific failure played out. Use details from the plan. Name specific moments where things went wrong and why.

2. THE UNDERLYING ASSUMPTION: The one thing the user was taking for granted that made this failure possible. State it in one sentence.

3. EARLY WARNING SIGNS: 1-2 concrete, observable signals the user could watch for that would indicate this failure mode is starting to play out. These should be things the user can actually see or measure.

Keep the total response under 300 words. Be direct. Do not hedge. Do not sugarcoat.
```

### 3. Synthesis

Read all deep dives and produce a premortem synthesis with:

1. **The Most Likely Failure**: the most probable scenario and why.
2. **The Most Dangerous Failure**: the highest-damage scenario, even if less likely.
3. **The Hidden Assumption**: the biggest unchallenged assumption across the analyses.
4. **The Revised Plan**: concrete changes that make the plan more resilient. Each revision should map to a failure mode.
5. **The Pre-Launch Checklist**: 3-5 specific checks, tests, or safeguards to complete before execution.

The revised plan must be actionable this week. Prefer specific tests, thresholds, owners, timelines, and fallback decisions over abstract advice.

## Required Artifacts

Produce both files in the user's workspace:

```text
premortem-report-[timestamp].html
premortem-transcript-[timestamp].md
```

Use a local timestamp that sorts cleanly, such as `YYYYMMDD-HHMMSS`.

### HTML Report

Create a single self-contained HTML file with inline CSS.

Design requirements:

- Dark background, e.g. `#0a0e1a`
- Clean typography and strong scanability
- Synthesis at the top, since most users will read that first
- One card per failure reason
- Each card includes the failure reason, failure story, underlying assumption, and early warning signs
- Distinct accent colors across cards
- Clear visual indicators for likelihood and severity
- A round-robin or grid overview showing how many deep dives ran and their core findings
- Footer with timestamp and what was premortemed

Open the HTML report after generating it when local browser tooling is available.

### Markdown Transcript

Create the full transcript with:

- Gathered context: what, who, success criteria
- Raw premortem failure reasons
- All deep-dive analyses
- Full synthesis

## Chat Summary

After generating the files, respond in chat with no more than three sentences:

- Most likely failure
- Hidden assumption
- Single most important revision

Mention the generated report and transcript paths.

## Quality Bar

- Be specific, direct, and unsentimental.
- Do not sugarcoat serious problems.
- Do not invent context; ask when the minimum context is missing.
- Do not confuse this with ordinary feedback, a strategy brainstorm, or an LLM Council.
- The synthesis is the product. Make it concrete enough that the user can change the plan immediately.
