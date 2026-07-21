---
name: mcp-restart-ceremony
description: Reconnect threadwork agents (boss/steve/sadie/kiera, optionally snoopy-self last) to the task-board MCP server after disconnects, /clear ceremonies, or team-wide reconnect requests. Reads pane first; on CC 2.1.215+ uses the direct '/mcp reconnect task-board' arg form (F6 — no picker, no ESC); verifies inline success + FRESH server pid. NEVER ESC-ESC on CC 2.1.183+ (opens Rewind modal — F5). Surfaces field findings F0-F6.
---

# mcp-restart-ceremony

Canonical (v4) procedure for reconnecting threadwork agents to the
`task-board` MCP server. Follow it in order; do not improvise. The
ceremony touches other agents' input buffers via `tmux send-keys`, which
is a privileged operation — a wrong keystroke can silently submit
garbage as if the agent typed it (F1, ceremony #963), or interrupt real
work. Every step exists because a prior shortcut around it had a real
failure mode.

For the full step-by-step procedure (with pane-state decision table,
keystroke commands, and reporting format) see
[`references/playbook.md`](references/playbook.md). For the field-
findings history that motivates each step see
[`references/field-findings.md`](references/field-findings.md). Read
both before running the ceremony for the first time in a session.

## When to fire

- User asks to reconnect agents to MCP.
- A `/clear` was just injected into one or more agent panes (the
  recycle pipeline drops the MCP connection on the way through).
- Team-wide MCP disconnect signals: heartbeat anomalies, gaps in
  `query_audit_log`, agents reporting tool-call failures.
- Snoopy or boss explicitly requests the ceremony after a restart.

## Inputs

- `agents` — subset of `{boss, steve, sadie, kiera}`. Default: all four.
- **Snoopy is the operator running the ceremony; do NOT run it on the
  snoopy pane itself.** (F4)

## Procedure summary (full detail in `references/playbook.md`)

For each agent in scope, in series:

### 1. READ FIRST — never clear blind

```
tmux capture-pane -t claude-<agent> -p | tail -30
```

Decision tree based on what you see:

- **Mid-tool-use** (in-flight tool call, spinner, unfinished response)
  → **ABORT** for that agent and escalate to the human. Do not clear
  or interrupt active work.
- **Buffer holds unsubmitted REAL user/agent intent** (a real prompt,
  reasoning, or instruction the agent or a human typed but didn't
  submit) → **ESCALATE before clearing.** Silently nuking another
  agent's reasoning is a serious failure mode (F1 history).
- **Stale notification text / boilerplate** (e.g. old "task #N
  completed" banner, leftover monitor nudge) → safe to clear, go to
  step 2a.
- **Empty buffer** → skip to step 3.

### 2a. ESC-twice clear (canonical — F0) — ⚠️ STALE ON CC 2.1.183+, see F5

> ⚠️ **DO NOT blindly ESC-ESC on Claude Code 2.1.183+.** On 2.1.183,
> ESC-ESC OPENS the Rewind/restore-checkpoint modal (footer `Enter to
> continue · Esc to cancel`), where a stray `Enter` would **destructively
> rewind the agent's session.** If a pane is parked in that modal, cancel
> it with a **SINGLE** `Escape` (never double, never `Enter`). Note that
> `C-u`/`Backspace` may fail to clear what looks like buffer text if it's
> actually a greyed-out **ghost auto-suggestion** (harmless — typing the
> real `/mcp` command replaces it). See F5 in `references/field-findings.md`.

On versions where F0 still holds, ESC-ESC clears the buffer:

```
tmux send-keys -t claude-<agent> Escape
tmux send-keys -t claude-<agent> Escape
```

Then `tmux capture-pane` again and confirm the input line is empty.
(F0, GweiSprayer 2026-05-07 — superseded by F5 on 2.1.183+.)

### 2b. Up-wrap (FALLBACK ONLY)

Use ONLY if ESC-ESC is provably failing on this pane. Up does NOT wrap
the buffer — it RECALLS history and overwrites whatever's in the
buffer (F1). Submitting recalled history is noisy but usually harmless
(F3), yet it can also submit something dangerous if the recalled item
is non-trivial. Prefer ESC-ESC.

```
tmux send-keys -t claude-<agent> Up
tmux send-keys -t claude-<agent> Enter
```

Do NOT use `C-u` for multi-line input — it's unreliable (F2).

### 3. Reconnect — PREFERRED: direct arg form (F6, CC 2.1.215+)

On CC 2.1.215+ use the argument form — it reconnects inline with **no
picker and zero ESC/Rewind exposure** (proven 5/5, T4 ceremony
2026-07-20):

```
tmux send-keys -t claude-<agent> -l '/mcp reconnect task-board'
sleep 0.4
tmux send-keys -t claude-<agent> Enter
```

Success = inline `⎿ Successfully reconnected to task-board` + clean
composer. Then verify a **fresh server pid** (ps: `bun run …
task-board/server.ts` with ppid = the pane's claude pid, new lstart).
See F6 in `references/field-findings.md` — including the safe
self-application pattern for the operator's own pane.

**Fallback only** (older CC, or arg form errors) — open the picker:

```
tmux send-keys -t claude-<agent> '/mcp'
tmux send-keys -t claude-<agent> Enter
```

### 4. Verify (~5–10 sec wait)

```
tmux capture-pane -t claude-<agent> -p | tail -30
```

Look for the line `task-board · ✔ connected · 40 tools`. The picker is
authoritative — if it shows connected with the right tool count, the
reconnect succeeded. If it shows fewer tools or a disconnected state,
re-run the picker open (step 3) once before escalating.

> ⚠️ The `/mcp` picker takes **~4–5s to render** — an immediate capture
> shows a stale `MCP dialog dismissed` line; use a delayed capture
> (`… /mcp Enter; sleep 5; capture-pane` in a background command).
> `task-board` is NOT in the top "User MCPs" group — it's grouped
> separately far down a ~48-server list. **Do NOT blind-arrow-navigate
> to find its line** on 2.1.183+: every stray ESC risks re-opening the
> Rewind modal. Prefer the **functional verification in step 5** as the
> primary proof on that version.

### 5. Audit-log smoke-test (recommended — PRIMARY proof on 2.1.183+)

Call `mcp__task-board__query_audit_log` filtered by `agent=<agent>`
and look for fresh rows in the last few minutes. A reconnected agent
will typically log a `get_boot_briefing` or similar shortly after
rehydrate. Picker truth + audit-log truth together gives high
confidence.

If the agent is idle and won't log on its own, **trigger a functional
test**: `nudge_agent(<agent>, "run list_tasks to confirm task-board is
back, then go idle; leave <blocked task #> intact")`. A successful
`list_tasks` / `status_written` row in the audit log IS proof the
task-board MCP is responsive — stronger than a picker line and with no
ESC/rewind hazard. This is the **preferred** verification on CC
2.1.183+ (see F5). Validated on the kiera 2026-06-23 remediation.

## After all agents are processed

- Report per-agent outcomes (ok / aborted / escalated).
- If any agent was aborted because it was mid-tool-use or had real
  intent in the buffer, surface that to the human verbatim — do not
  retry without permission.
- Send a 1-line summary back to the requester (snoopy normally posts
  to Telegram).

## Why this is precise

The MCP reconnect ceremony touches other agents' input buffers via
`tmux send-keys`. That's a privileged operation: a wrong keystroke can
silently submit garbage as if the agent typed it (F1, ceremony #963),
or worse, interrupt real work. The READ FIRST + ESC-ESC + verify-via-
picker shape exists specifically because we have learned, the hard
way, that each shortcut around it has a real failure mode.

## Field findings (canonical history)

Full discussion of each finding (and the ceremony numbers that
surfaced them) lives in
[`references/field-findings.md`](references/field-findings.md).

- **F0 (2026-05-07, GweiSprayer):** ESC-ESC is the canonical buffer
  clear, NOT C-u.
- **F1:** Up-arrow does NOT wrap the buffer — it recalls history and
  overwrites. Submitting recalled history is the silent-submission
  risk.
- **F2:** `Ctrl+U` (C-u) is unreliable on multi-line input.
- **F3:** Submitting recalled history is noisy but usually harmless —
  but can submit dangerous content if the history item is non-trivial.
- **F4:** Never run the ceremony on snoopy's own pane — snoopy is the
  operator.
- **F5 (2026-06-23):** On CC 2.1.183+ ESC-ESC OPENS the Rewind modal
  (destructive on Enter) — single-Escape only; prefer functional
  verification.
- **F6 (2026-07-20, CC 2.1.215):** `/mcp reconnect task-board` works as
  a direct argument command — inline success, no picker, zero ESC
  exposure. Now the PREFERRED reconnect. Verify via fresh server pid.
  Includes a safe operator-self-reconnect pattern (queued composer +
  background sentinel) that supersedes F4's blanket ban for this
  mechanism.
