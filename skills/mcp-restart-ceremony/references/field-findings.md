# Field Findings & Ceremony History

This document captures the operational lessons (F-numbered) and the
ceremony log that motivated the v4 playbook in `playbook.md`. Read this
before deviating from the playbook — every shortcut that looks
attractive has a known failure mode below.

## Field findings

### F0 — ESC twice clears the input buffer (canonical)

Source: GweiSprayer 2026-05-07, Telegram message 13956.

Pressing `Escape` twice in the Claude Code TUI clears the input buffer
without submitting. This is the canonical clear and the default branch
in step 2a of the v4 playbook.

```
tmux send-keys -t claude-<agent> Escape
tmux send-keys -t claude-<agent> Escape
```

Effects: empties the buffer, no submission, no history mutation. Verify
with `tmux capture-pane` after.

> ⚠️ **VERSION-DEPENDENT — see F5.** As of Claude Code **2.1.183**,
> ESC-ESC NO LONGER clears the buffer — it OPENS the Rewind/restore-
> checkpoint modal, where a stray `Enter` would destructively rewind the
> agent. F0 is stale on 2.1.183+. Read F5 before using ESC-ESC; prefer
> the functional audit-log verification (F5) over blind buffer-clearing.

### F1 — Up-arrow ≠ buffer-wrap

Discovered ceremony #963 (2026-05-07). Triggered the v3 → v4 playbook
revision.

Pressing `Up` does NOT clear or wrap the buffer. It RECALLS the most
recent history entry and **overwrites** whatever is currently in the
buffer. If a subsequent `Enter` is sent, the recalled entry is
submitted. This means an Up-wrap "clear" can:

- Destroy whatever real intent was sitting in the buffer.
- Submit a stale or unrelated entry as if the agent typed it.

Demoted to fallback-only (step 2b) after F0 was confirmed. Use ESC-ESC
unless you have a specific reason it isn't working on this pane.

### F2 — Ctrl+U unreliable on multi-line input

Discovered ceremony #926 (2026-05-06).

`C-u` ("kill to start of line") does not reliably clear the full buffer
when the input spans multiple lines. Don't use it for buffer clearing
in this ceremony. ESC-ESC is the canonical answer.

### F3 — Stale notification submission via Up-wrap is harmless but noisy

Observed during ceremony #963.

When Up-wrap recalls a stale "task #N completed" or similar
notification, the agent receiving it typically reacts with a
`list_tasks` call to figure out what's happening. That's noise but not
damage. Boss in particular logged a brief reaction during #963.

With F0 (ESC-ESC), this entire failure mode goes away — we never
recall anything because we never press Up.

### F4 — Backlog tasks (null assignee) cannot be self-claimed by snoopy

Surfaced via task #831.

`create_task` does not accept `snoopy` as a `to` value, so any
self-marker tasks snoopy might want to drop into the backlog will land
without an assignee and cannot be claim+complete'd by snoopy himself.

Workaround: when snoopy needs to track a personal artifact relating to
the ceremony, use `send_note` on a related task rather than trying to
spin up a fresh self-task. This isn't a blocker for the ceremony
itself; it's a footgun snoopy hits when trying to log ceremony
artifacts.

### F5 — ESC-ESC opens the Rewind modal on CC 2.1.183 (F0 is stale)

Discovered during the kiera remediation, 2026-06-23 (snoopy). All team
sessions were on Claude Code **2.1.183**.

On 2.1.183, pressing `Escape` twice does **NOT** clear the input buffer
(contra F0). It OPENS the **Rewind / restore-checkpoint modal** — a
checkpoint list footered `Enter to continue · Esc to cancel`. In that
modal:

- **`Enter` RESTORES the selected checkpoint = destructively rewinds the
  agent's session.** Never send Enter while the modal is up.
- **A single `Escape` cancels** the modal and returns to the prompt.

Safe handling on 2.1.183+:

- To cancel the Rewind modal: send **one** `Escape`. Do not double it.
- Never use ESC-ESC as a "buffer clear" — you'll open the modal. If the
  buffer genuinely has text, note that `C-u` and `Backspace` may also
  fail to clear it when the text is actually a **ghost auto-suggestion**
  (greyed-out suggested input, not real buffer content — typing a real
  command like `/mcp` replaces it cleanly, so it doesn't block the
  ceremony).

Other findings from the same run:

- **Picker render delay:** the `/mcp` picker takes ~4–5s to paint. An
  immediate `capture-pane` shows a stale `MCP dialog dismissed` line and
  looks like a failure. Use a **delayed capture** (run `tmux send-keys …
  /mcp Enter; sleep 5; tmux capture-pane …` as a background command).
- **task-board is not in the top "User MCPs" group:** it's a
  project/local-scoped MCP, grouped separately far down a ~48-server
  picker list. Do NOT blind-arrow-navigate to find its exact `· ✔
  connected · 40 tools` line — it's a rabbit hole, and every stray ESC
  risks re-opening the Rewind modal.
- **Prefer the FUNCTIONAL verification (supersedes picker-hunting):**
  after the reconnect, `nudge_agent(<agent>, "run list_tasks to confirm
  task-board is back, leave <blocked task> intact")`, then read
  `query_audit_log(agent=<agent>)` for a fresh row (a `status_written` /
  `list_tasks`). A successful task-board call IS the proof of
  connection — stronger than reading a picker line, and it avoids all
  the ESC/rewind hazards.

### kiera 2026-06-23 — remediation under the F5 hazard

Kiera was parked ~18h at a Rewind/restore-checkpoint modal + a flapping
`/mcp` dialog. Snoopy ESC-cancelled the modal (no restore), reconnected
via `/mcp`, and **verified functionally** (kiera ran `list_tasks` and
logged `write_status`/`read_status`). `#10060741` left intact
(blocked_on=human). Surfaced F5 — several of snoopy's ESCs re-opened the
modal before the single-ESC-cancel pattern was pinned.

## Ceremony history

The numeric IDs are task-board task numbers. Use them as anchors when
investigating regressions or writing memos.

### #908 — 2026-05-06 12:36

First MCP restart ceremony. 4/4 panes reconnected. Established the
basic shape: clear → /mcp → verify-via-picker.

### #926 — 2026-05-06 16:10

5/5 reconnected via Up-wrap (the v2 shape that predated F0). Surface
finding: F2 — Ctrl+U unreliable on multi-line input.

### #932 — 2026-05-06 16:30s

5/5 reconnected with the same playbook as #926. Notable for shipping
the Fix-C verify-loop (the explicit re-capture-pane after picker open
to confirm the connected line, rather than trusting the keystroke
alone).

### #963 — 2026-05-07 13:30s

3/4 reconnected. Boss / steve / sadie completed cleanly. **Kiera was
ABORTED** because her pane had `yes pull the data` queued in the
buffer — real, unsubmitted intent. Up-wrap would have destroyed it
and submitted history instead. The abort correctly preserved the
intent.

This ceremony surfaced F1 (Up-arrow overwrites buffer rather than
wrapping) and triggered the v3 playbook revision: READ FIRST before
clearing, escalate when real intent is in the buffer.

### post-#963 — F0 + v4 playbook is now canonical

GweiSprayer provided F0 (ESC-ESC clears) shortly after #963. The v4
playbook integrates F0 as the canonical clear in step 2a, demotes
Up-wrap to fallback-only in step 2b, and keeps the READ FIRST decision
tree from v3.

Memory #1282 captured the v4 playbook in long-form. After this skill
exists, that memory should be superseded with a thin pointer back to
this skill (`/mcp-restart-ceremony`) so the playbook has exactly one
canonical home.
