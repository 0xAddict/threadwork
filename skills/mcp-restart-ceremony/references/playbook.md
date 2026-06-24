# MCP Restart Ceremony — v4 Playbook

This is the canonical procedure for reconnecting threadwork agents
(boss / steve / sadie / kiera) to the `task-board` MCP server. v4
supersedes earlier ad-hoc Up-wrap variants after ceremony #963 surfaced
F1 (Up-arrow overwrites the buffer with prior history rather than
clearing it).

For the field findings that motivate each step, see
`field-findings.md`.

## Scope

- **In-scope agents:** boss, steve, sadie, kiera. The skill operates on
  any subset the caller passes; default is all four.
- **Out of scope:** snoopy. Snoopy is the operator running the
  ceremony — never run the ceremony against the snoopy pane (the
  context-budget hook is even self-loop guarded for the same reason).

## Per-agent loop

For each agent in scope, run steps 1 → 5 in series. Do not parallelise
across agents on the same pane series — `tmux send-keys` is racy with
overlapping keystrokes.

### Step 1 — READ FIRST

```
tmux capture-pane -t claude-<agent> -p | tail -30
```

Classify what you see and pick the branch:

| Pane state | Action |
|---|---|
| Mid-tool-use (spinner, in-flight tool call, partial assistant turn) | **ABORT** for this agent. Escalate to the human. Do not type into the pane. |
| Unsubmitted REAL user or agent intent in the buffer (a real prompt, real reasoning, real instruction) | **ESCALATE before clearing.** Silently destroying another agent's reasoning is a P0 failure mode (see ceremony #963 / F1). |
| Stale notification text / boilerplate (e.g. an old "task #N completed" banner, a leftover monitor nudge, a Telegram echo) | Proceed to Step 2a. |
| Buffer empty | Skip to Step 3. |

When in doubt, escalate. The cost of escalating once unnecessarily is
low; the cost of nuking real reasoning is high.

### Step 2a — ESC-twice (canonical clear, F0)

```
tmux send-keys -t claude-<agent> Escape
tmux send-keys -t claude-<agent> Escape
```

Then re-`capture-pane` and confirm the input line is empty. This is the
canonical clear (F0). It does not submit anything; it just empties the
buffer.

### Step 2b — Up-wrap (FALLBACK ONLY)

Use only if ESC-ESC is provably not clearing the buffer on this specific
pane. The semantics:

```
tmux send-keys -t claude-<agent> Up      # RECALLS prior history, overwriting buffer
tmux send-keys -t claude-<agent> Enter   # submits whatever was recalled
```

Risks:

- Up does **not** wrap or clear the buffer. It overwrites the buffer
  with the most recent history entry (F1).
- Whatever pops up is then submitted by the Enter. Usually that's stale
  notification text (F3), which is noisy but harmless. But "usually" is
  not "always" — if the recalled item is, e.g., a real operational
  instruction, you've just run it.

Do **not** use `C-u` for multi-line input — it does not reliably clear
the full buffer (F2, ceremony #926).

### Step 3 — Open the /mcp picker

```
tmux send-keys -t claude-<agent> '/mcp'
tmux send-keys -t claude-<agent> Enter
```

`/mcp` is a Claude Code client-side slash command that opens an
interactive picker showing connected MCP servers and their tool counts.
This is the authoritative source of truth for whether `task-board` is
connected.

### Step 4 — Verify

Wait ~5–10 seconds for the picker to render, then:

```
tmux capture-pane -t claude-<agent> -p | tail -30
```

Look for the literal substring:

```
task-board · ✔ connected · 40 tools
```

- ✔ connected with 40 tools → reconnect succeeded.
- ✔ connected with a different tool count → partial — note it and
  surface to the human; the schema may have changed or a tool may be
  missing.
- ✗ disconnected or absent → re-run Step 3 once. If still disconnected,
  escalate.

### Step 5 — Audit-log smoke-test (recommended)

```
mcp__task-board__query_audit_log(agent="<agent>", limit=10)
```

A freshly reconnected agent typically logs `get_boot_briefing` or some
other tool call within a minute or two of rehydrate. Fresh rows confirm
the connection is live, not just visually-connected. Picker truth +
audit-log truth together is the gold standard.

## Reporting

After all agents are processed, return:

- Per-agent outcome: `ok` / `aborted` / `escalated` / `partial`.
- For aborts: the reason (mid-tool-use, real intent in buffer).
- For escalations: a copy of the captured pane snippet so the human can
  judge.

Snoopy will normally post a 1-line summary to Telegram and update the
ceremony history (see `field-findings.md`).

## Pitfalls and field rules

- Never run the ceremony on snoopy.
- Never clear blind — always READ FIRST.
- Prefer ESC-ESC over Up-wrap. Always.
- Never use `C-u` on multi-line input.
- The /mcp picker is authoritative. Heartbeats and audit-log are
  corroborating evidence, not replacements.
- Do not parallelise keystrokes across the same pane. Series only.
- If any agent is aborted, surface that fact prominently — half-done
  ceremonies are worse than no ceremony because the operator may
  assume the team is fully reconnected.
