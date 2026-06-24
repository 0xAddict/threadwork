---
name: recycle
description: Evacuate-then-rehydrate context recycle. Run when context-budget-watch warns at 60%, when the user manually requests recycle, or proactively before drift compounds. Captures session state to durable memory and injects /clear.
---

# recycle — Evacuate-then-Rehydrate Context Recycle

## Purpose

Recycle a threadwork agent's session context safely. The agent's running
session is preserved as a durable handoff memory, `/clear` is injected into
the target pane, and the SessionStart hook rehydrates the fresh session from
the memory on next boot.

Targets one of: `boss`, `steve`, `sadie`, `kiera`, `snoopy`.

The hard problem this skill solves: a naive `/clear` silently nukes whatever
the agent had in flight — unsubmitted user intent, in-flight Agent
sub-agents, the thread of an ongoing user conversation. This skill exists to
preserve real intent before clearing.

## When to fire

- **60% auto-trigger.** `~/.claude/hooks/context-budget-watch.sh` (PreToolUse)
  estimates context-token usage from the session transcript jsonl. At 60% of
  `CLAUDE_CONTEXT_BUDGET_TOKENS` (default 1,000,000), it `tmux send-keys -l`
  an `AUTO-RECYCLE NUDGE` block into the persistent `claude-snoopy` session.
  Snoopy then runs this SOP. Self-loop guarded — never recycles snoopy
  about snoopy.
- **Manual request.** User asks an agent to recycle itself or another agent.
- **Proactive.** End of a logical work block, before the next round, when
  drift is starting to feel like it's compounding.
- **Post-compaction safety.** Per deep-research finding #638(c): if an
  auto-compaction has already happened in this session, a manual recycle
  here is safer than relying on a second compaction. Compaction is itself a
  drift step.

## Inputs

- `target_agent` — one of `{boss, steve, sadie, kiera, snoopy}`. The
  auto-nudge format includes this; manual requests must specify it.

## Procedure

### 1. Capture pane state (read-first; never clear blind)

Run:

```
tmux capture-pane -p -t claude-<target> -S -300 | tail -200
```

Read the capture. Branch:

- **Spinner / in-flight tool call visible** — ABORT. Do not `/clear` work
  that is actively running. Escalate to the user. Snoopy can react with a
  Telegram message explaining the abort.
- **Unsubmitted text in the input buffer that looks like real user or agent
  intent** — preserve it verbatim in the handoff memory below. This is the
  **F1 rule**: silent buffer-nuking of real intent is the exact failure mode
  this discipline exists to prevent.
- **Boilerplate, empty, or idle prompt** — proceed.

Also scan for in-flight Agent sub-agents — visible as
`(N background agents)` or status indicators. They may not survive `/clear`.
Flag them in the handoff so the rehydrated session knows to check fate.

### 2. Attempt `force_debrief`

```
mcp__task-board__force_debrief()
```

Originally boss-only. The 2026-05-10 patch (commit `fa9bd93`) added snoopy
to the allowlist. Caveat: snoopy's own MCP child process may be stale until
restart and can still return the old "Only boss can force a debrief" error
when snoopy is the caller — that's fine, the pane-derived handoff path
(step 3) is the resilient fallback.

- If it succeeds, the debrief decision is recorded on the task board.
- If it returns an RBAC error, note the skip and proceed.

### 3. Save the handoff memory — the critical preservation step

```
mcp__task-board__save_memory(
  category="fact",
  importance=5,
  content="[session-handoff:<agent>:<iso8601-utc>]\n\n<handoff body>"
)
```

The prefix `[session-handoff:<agent>:<iso8601>]` is **mandatory**.
`~/.claude/hooks/session-boot.sh` (SessionStart) searches the task-board
SQLite for the most recent memory matching this prefix (last 24h,
state=active) and surfaces it as a system message on the next boot. Skip
the prefix and the rehydrate is blind.

The handoff body must include, in this order:

1. **Unsubmitted input buffer** (verbatim, if any). Flag it with a warning
   marker so the rehydrated session can't miss it.
2. **In-flight sub-agent IDs and tokens** (if any). Flag for fate-check on
   rehydrate — the rehydrated session should look up whether those
   sub-agents completed, stalled, or died with the parent.
3. **Immediate post-rehydrate action.** The user's latest direct ask, if
   there's an open thread the agent owes a reply to.
4. **Recent work this session.** Chronological. Key task IDs, decisions,
   outcomes. Keep it focused — the goal is rehydrate, not a full audit.
5. **Cross-agent state** (only if directly relevant). What other agents are
   doing that this agent will trip over on resume.
6. **Open / parked items.** Things deferred, blocked, or waiting.
7. **Token count at recycle.** Read from the pane footer
   (`save NNNk tokens`).
8. **Resume on rehydrate** — an explicit checklist of next actions.
9. **Recycle ceremony stamp.**
   `"Snoopy injecting /clear via tmux send-keys at <iso8601-utc>"`

Why this much structure: the rehydrated session has no working memory.
The handoff is its only window into what just happened. Vague summaries
lead to the new session repeating work or missing a user reply.

### 4. Inject `/clear`

```
tmux send-keys -t claude-<target> '/clear' Enter
```

`/clear` is a Claude-Code-internal client-side slash command. It can't be
called via MCP. But pasting the literal characters into the pane from
outside via `tmux send-keys` is indistinguishable to the client from a
human typing it — and Claude Code happily processes it.

Record the injection timestamp; the Telegram notify in step 5 reports it.

### 5. Telegram-notify GweiSprayer (chat `1712539766`)

```
mcp__plugin_telegram_telegram__reply(
  chat_id="1712539766",
  text="<recycle report>"
)
```

The report should include:

- Target agent
- Token count at recycle
- Memory ID of the handoff (so the user can pull it up if needed)
- `/clear` injection timestamp
- Any immediate-action flags — e.g., "open thread: user asked X right
  before recycle hit"
- **Prominently flag in-flight sub-agents** if any. Fate is uncertain
  post-`/clear`; the user should know.

## Caveats

- **F1 rule (preserve real intent).** Unsubmitted text that looks like a
  real instruction goes into the handoff memory verbatim. Silent
  buffer-nuking is the failure this discipline prevents. When in doubt,
  preserve.
- **Snoopy self-recycle.** The SOP works on snoopy too — he can
  `tmux send-keys` to his own pane — but he loses his active conversation
  thread when he does. Snoopy normally defers his own recycle to
  end-of-day or natural restart events.
- **`force_debrief` RBAC gap (partly closed).** Memory #1187 documented
  this was boss-only. The 2026-05-10 patch (commit `fa9bd93`) added
  snoopy to the allowlist. Snoopy's MCP child process may be stale until
  restart and can still return the old error when snoopy is the caller —
  the pane-derived handoff is the fallback and works fine.
- **Auto-recycle hook trigger.** `context-budget-watch.sh` is PreToolUse;
  it estimates context-token usage from the session transcript jsonl.
  60% of `CLAUDE_CONTEXT_BUDGET_TOKENS` (default 1,000,000; per-session
  env override). It tmux-send-keys an `AUTO-RECYCLE NUDGE` block into
  `claude-snoopy`. Self-loop guarded. Dedup state in
  `~/.claude/state/context-budget/state-<session>.json`. Dispatch logs in
  `~/.claude/state/context-budget/dispatch-<session>.log`.
- **Why `/clear` via tmux send-keys works.** It's still a
  Claude-Code-internal slash command; snoopy isn't calling it from
  inside Claude Code — he's pasting characters into the target pane
  from outside. The target client sees a "human" typing.

## Output

After the SOP completes:

- A memory exists with prefix `[session-handoff:<agent>:<iso8601>]`,
  importance 5, category `fact`.
- `/clear` has been injected into the target pane.
- A Telegram reply has been posted to GweiSprayer (chat 1712539766) with
  the memory ID, token count at recycle, injection timestamp, and any
  immediate-action flags.
- On the target agent's next boot, `session-boot.sh` will surface the
  handoff memory and `get_boot_briefing` will load the agent's role and
  recent task history — belt-and-suspenders rehydrate.
