---
name: evidence-investigate
description: Use when answering questions about the CURRENT state of code, git history, or on-disk files — e.g. "is X installed", "what does Y do", "what branch has Z", "when did W change", "does the running code have feature F". Do NOT use for trivial file existence checks answerable by a single ls, for implementation/edit work, or for questions about mutable external state (APIs, databases, live processes, Telegram history).
---

# Evidence Investigate

## Purpose

Answer code-state questions through a dedicated read-only sub-agent so every factual claim is backed by a cited command output or file:line reference. This skill exists because main-thread Claude has repeatedly claimed things about running code from memory (grepping for a symbol name remembered from a commit message, for example) and been wrong.

## When this skill fires

The skill description auto-triggers on questions like:
- "Is function X defined in file Y?"
- "What branch of the plugin clone is currently checked out?"
- "Does the running task-board MCP import `debounce.ts`?"
- "Is commit SHA X reachable from origin/main?"
- "What files does branch A have that branch B does not?"
- "When was the last modification to `server.ts` on main?"

## When this skill does NOT fire

- Trivial file existence checks answerable by a single `ls` — just run the ls.
- Implementation work (edits, writes, builds, deploys) — different skills.
- Questions about mutable external state (APIs, databases, live processes, Telegram message history) — these are non-deterministic and not a good fit for an "evidence replayability" contract.
- "Should we do X?" — that's a decision, not a fact. The sub-agent refuses these.

## Red Flags — STOP and Spawn the Sub-Agent

These thoughts mean you are about to violate this skill. Stop.

| Thought | Reality |
|---|---|
| "I remember this function is called X" | Symbol names recalled from memory are the #1 source of hallucinated claims. Spawn the sub-agent. |
| "Let me just grep this quickly" | Main-thread grep without reading the file first is the exact error class this skill exists to prevent. Spawn the sub-agent. |
| "I can verify this faster than a sub-agent" | You are not faster, you are sloppier. Your direct claims skip the citation requirement. Spawn the sub-agent. |
| "I don't need a skill for such a simple question" | Simple code-state questions are where you have fabricated claims before. Spawn the sub-agent. |
| "The user is waiting, I should just answer" | A wrong answer fast is worse than a right answer in 90 seconds. Spawn the sub-agent. |
| "I already know the answer" | You "already knew" `dispatchAgentNudge` existed. You were wrong. Spawn the sub-agent. |
| "The skill body is long, I'll just follow the description" | The description is intentionally triggers-only. The rules are in the body. Read it. |
| "I only need to check one line — I'll read it myself" | Reading one line and forming a claim without the Evidence/Claims/Unknowns format is still a violation. Spawn the sub-agent. |
| "Violating the letter is OK because I'm following the spirit" | Violating the letter IS violating the spirit. Spawn the sub-agent. |

**Violating the letter of this skill is violating the spirit of this skill.** The whole point is that your judgment under pressure ("I know this one, it's fine") is exactly the judgment that got `dispatchAgentNudge` wrong. The sub-agent does not have that judgment — it has a citation requirement. Use it.

## What to do when this skill activates

Your job is to relay, not to investigate.

**Step 1.** Spawn the sub-agent with the Agent tool:

```
Agent(
  subagent_type="evidence-investigator",
  description="<5-word summary of the question>",
  prompt="<the user's question verbatim, plus any directly relevant file paths or SHAs from the current conversation. Do NOT include your own theories, interpretations, or hypotheses about the answer — just the question and neutral context.>"
)
```

**Step 2.** Wait for the sub-agent's report. It returns in 1–5 minutes.

**Step 3.** Relay the report to the user verbatim with the prefix:

> `report from evidence-investigator:`

Do not summarize. Do not drop Unknowns. Do not add your own commentary unless the user asks a follow-up.

## Forbidden while this skill is active

1. Using `Grep`, `Read`, or `Bash` on code files yourself. The sub-agent does that.
2. Making factual claims about function names, file paths, commit SHAs, or git state from memory.
3. Summarizing or condensing the sub-agent's report in a way that hides Unknowns or drops citations.
4. Acting on the report (e.g., executing a plan based on its findings) in the same message as relaying it. Acting requires a separate turn and the user's explicit go-ahead.

## Escape hatch

If the user explicitly says "don't use evidence-investigate", "skip it", "answer from memory", or "just tell me what you remember", acknowledge and answer directly. In that mode, **every factual claim must be prefixed with `UNVERIFIED:`** so the user sees the downgrade. The escape hatch resets at the start of each user turn — do not persist it across turns.

## Rationalization Table

Common excuses for bypassing this skill, with the rebuttal.

| Excuse | Reality |
|---|---|
| "The sub-agent takes too long" | 60-120s. A wrong claim costs much more — it propagates into plans and builds. |
| "I already did the investigation this morning" | Code changes. Memory decays. Re-run it. |
| "I'll just prefix my answer with UNVERIFIED:" | The escape hatch is for when the USER tells you to skip. It is not a get-out-of-skill card you use on yourself. |
| "I can cite the file path from memory, that's enough citation" | File paths from memory can be wrong (wrong branch, renamed file, moved module). Spawn the sub-agent. |
| "This is meta — I'm investigating the investigation tool itself" | Still a code-state question. Still spawn the sub-agent. |
| "I grep'd and got output, I'll just report what I saw" | Raw grep output is evidence material but skips the structured Claims/Unknowns sections that keep you honest. Spawn the sub-agent. |
| "I need to answer fast because the user is on Telegram" | The user has explicitly said they prefer correct over fast today. Spawn the sub-agent. |

## Follow-ups

If the user asks a follow-up that expands the investigation scope ("what about branch X?", "is that also true for file Y?"), re-spawn the sub-agent with the expanded question. Do not answer from the previous report unless the previous report's Evidence section already covered the new question verbatim.

## Failure handling

- If the sub-agent returns in under 5 seconds with an empty Evidence section, something is wrong. Re-spawn with "please investigate thoroughly before answering" appended to the prompt.
- If the sub-agent's report has a Claim with no Evidence citation, relay the report AS-IS so the failure is visible, then add one line of main-thread commentary: "Note: the sub-agent produced an uncited claim in item N. I do not trust it."
- If the sub-agent refuses the question as out of scope, relay the refusal verbatim. Do not try to answer it yourself.
