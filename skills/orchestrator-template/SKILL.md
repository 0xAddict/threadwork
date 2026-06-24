---
name: orchestrator-template
description: Use when authoring a new orchestrator skill (e.g. /orchestrate, /rsa, /campaign-plan style umbrella commands) that delegates work across multiple sub-agents or sub-skills. Codifies Simon Scrapes's 5-point orchestrator contract (architecture / inputs / handoffs / HITL / visual results) so every orchestrator skill in this codebase follows the same structure. Triggers: 'orchestrator', 'umbrella skill', 'multi-skill workflow', 'sub-agent decomposition'.
---

# Orchestrator Skill Template

This skill is a **scaffold**, not a runtime. Read it when you are about to author
a new orchestrator-style skill — an umbrella slash command that fans out work
to specialized sub-agents and/or sub-skills (e.g. `/rsa`, `/orchestrate`,
`/campaign-plan`, `/case-study`).

Every orchestrator skill in this codebase must satisfy the same 5-point
contract — distilled from Simon Scrapes's writeup of Anthropic's `/rsa`
marketing orchestrator (Austin Lau's Growth team build). Follow the contract
so the resulting skills are debuggable, reviewable, and stylistically
coherent across the team.

The detailed worked example lives in
[`references/anthropic-marketing-pattern.md`](references/anthropic-marketing-pattern.md).
Read it before you start; this SKILL.md only summarizes. Don't duplicate that
content here.

## When to fire

Invoke this template skill whenever any of these phrases or contexts show up:

- "orchestrator"
- "umbrella skill" / "umbrella command"
- "multi-skill workflow"
- "sub-agent decomposition" / "fan-out skill" / "agent split"
- A user asks to design a slash command that itself delegates to multiple
  named sub-agents or other skills (e.g. "build me a `/campaign-plan` skill
  that calls headline-agent and description-agent")
- A user asks you to make an existing single-shot skill into a fan-out
  workflow

If the skill you are authoring is single-shot (one prompt in, one artifact
out, no sub-agents) you do NOT need this template — use `skill-creator`
directly.

## How to use

1. Read this SKILL.md.
2. Read [`references/anthropic-marketing-pattern.md`](references/anthropic-marketing-pattern.md)
   in full. It walks Austin Lau's `/rsa` example through each of the 5
   points and gives you the exact quotes and JSON-on-disk patterns to copy.
3. Draft your new skill's SKILL.md using the 5-point structure below as the
   spine of the body. Reuse the canonical Anthropic marketing-plugin skill
   vocabulary verbatim (`brand-voice`, `content-creation`,
   `competitive-analysis`, `performance-analytics`, `campaign-planning`) when
   it fits — do not invent parallel names.
4. If your orchestrator targets a non-Growth marketing role (Customer /
   Influencer / Product / Partner) or any domain outside Anthropic's
   published `/rsa` data point, flag the decomposition as **derivative**
   in the new skill's frontmatter description (see the provenance note in
   the reference doc — only Growth Marketing has Anthropic-blessed
   architectural detail).

## The 5-point orchestrator contract

Every orchestrator skill body must explicitly answer all five points. If a
section would be empty, the orchestrator is probably the wrong shape — go
back to single-shot.

### 1. Architecture

Name every sub-agent and every sub-skill the orchestrator fans out to.
For each sub-agent: state its model (Opus/Sonnet/Haiku), its sole
responsibility, and the *one* artifact it produces. The Anthropic
justification (PDF p. 16) for splitting is **debuggability and output
quality** — one agent, one job. If you cannot give a sub-agent a one-line
responsibility, it is doing too much; split it again or fold it back into
the parent.

### 2. Inputs

List every input the orchestrator demands **before any sub-agent fires**.
For each input: required vs optional, source (user prompt, file path, MCP
connector), and the fail-fast behavior when it's missing or malformed.
`/rsa` requires `campaign_data`, `existing_copy`, `target_keywords` and
hard-fails on empty keywords or missing ad-group ID. Yours should be
equally explicit.

### 3. Handoffs

Specify the on-disk contract between sub-agents. For each artifact: the
file path, the JSON schema, who writes it, who reads it. Sub-agents
communicate through files, not through chat — this is what makes the
workflow auditable and re-runnable. `/rsa` writes
`.rsa/<campaign>/headlines.json`, `descriptions.json`, `brand-scores.json`
and the orchestrator's join step reads all three.

Reuse Anthropic's marketing-plugin skill names verbatim where applicable:
`brand-voice`, `content-creation`, `competitive-analysis`,
`performance-analytics`, `campaign-planning`.

### 4. HITL (Human-in-the-Loop)

Identify every **external side effect** (publish, send, push, charge, post
to a third-party API, write to a production table) and gate it behind
explicit user approval. Internal scratch writes (e.g. JSONs to `.rsa/`) do
not need a gate. Specify the approval surface: Telegram reply, terminal
`y/N`, sprint contract, decision-board `finalize_decision`, etc.

Cowork principle: *"Before Claude acts, it shows you the plan and waits
for your approval. Redirect, refine, or take a different approach at any
step."*

### 5. Visual Results

Define the **finished deliverable**, not a step-by-step transcript. Lead
with a one-line triage summary (PASS / PARTIAL / FAILED + the headline
metric, e.g. `PASS — 12/15 headlines + 4/4 descriptions cleared brand
threshold ≥ 0.8`). Follow with the formatted artifact (markdown table,
spreadsheet, memo, briefing doc). Intermediate sub-agent JSONs stay on
disk in the sidecar directory for audit — they do not show up in chat.

Cowork: *"finished work instead of step-by-step updates: a formatted
spreadsheet, a memo, a briefing doc."*

## Authoring checklist

When your orchestrator-skill draft is ready, gate it against these
questions. If any answer is "no" or "unclear," fix it before shipping.

- [ ] Is every sub-agent reducible to a one-line responsibility?
- [ ] Does the body explicitly cover all 5 points in order?
- [ ] Are inputs validated with a named fail-fast behavior?
- [ ] Is every external side effect gated by HITL?
- [ ] Are sub-agent JSON schemas defined (paths + fields)?
- [ ] Does the deliverable lead with a PASS/PARTIAL/FAILED triage line?
- [ ] Did you reuse Anthropic's marketing-plugin skill vocabulary where it
      fits (instead of inventing parallel names)?
- [ ] If the decomposition is outside Growth Marketing, did you flag the
      skill as **derivative / Anthropic-style** in its frontmatter?

## Reference

- [`references/anthropic-marketing-pattern.md`](references/anthropic-marketing-pattern.md)
  — Full worked example of `/rsa` through all 5 points, with the Anthropic
  PDF and blog quotes, the canonical skill vocabulary, and the
  provenance/derivation caveats for non-Growth roles.
