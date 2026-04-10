# Diagnosis: Sadie nudge drops + PostToolUse telegram reply hook error
Date: 2026-04-09 | Author: Boss diagnostic sub-agent

## 1. What is the PostToolUse hook doing?
`/Users/coachstokes/threadwork/scripts/telegram-typing-stop.sh` (executable, mode 755) runs on every `mcp__plugin_telegram_telegram__reply`. It reads the hook JSON on stdin, extracts `chat_id` + `session_id`, kills this session's typing-loop background PID, deletes the "agent is working on this..." placeholder message via `deleteMessage` REST call, then performs a CLEANUP LOOP at line 49:

```
for flag in "${STATE_DIR}/${CHAT_ID}".*.flag; do
  [[ -f "$flag" ]] || continue
```

Dependencies: python3, curl, `$TELEGRAM_BOT_TOKEN`, `rm`, `kill`, `rmdir` — all present.
Confidence: high. Next action: none (understood).

## 2. Is the hook actually erroring? What error?
YES — repeatedly and in exactly the pattern reported. Sadie's pre-restart session jsonl (`8bcfc29d-04db-48f6-9230-dc71b80f5f1b.jsonl`) contains 25 `hook_non_blocking_error` attachments out of 32 telegram reply calls, all with identical stderr:

```
/Users/coachstokes/threadwork/scripts/telegram-typing-stop.sh:49: no matches found:
/tmp/telegram_typing/1712539766.*.flag
```

Root cause: the script is `#!/bin/zsh` and zsh's default `NOMATCH` option causes unquoted globs with no matches to ERROR (exit 1) instead of expanding to an empty list (bash's behavior). When a reply fires and there is no remaining `.flag` file (the common case — the session's own flag was already `rm -f`'d at line 32), the `for flag in ...*.flag` loop aborts the script with a non-zero exit, and Claude surfaces it as `hook_non_blocking_error` in the tmux/transcript.

Fix (for the fix task, not this report): add `setopt NULL_GLOB` (or `unsetopt NOMATCH`) at top of the script, or quote-guard with `(N)` qualifier: `for flag in "${STATE_DIR}/${CHAT_ID}".*.flag(N)`.

Confidence: very high — exact stderr captured from 25 separate events. Next action: one-line fix to telegram-typing-stop.sh.

## 3. How does nudge_agent deliver to a tmux session?
`server.ts` case `nudge_agent` (line 831) → `nudgeAgent(agent, message)` in `nudge.ts`. `nudge.ts` resolves agent label via `AGENT_SESSIONS` map in `config.ts` (sadie → `claude-sadie`) and spawns:

```
/Users/coachstokes/.local/bin/tmux send-keys -t claude-sadie "<msg>" Enter
```

Then waits for exit code — returns `{ok:false,error}` on non-zero. There is NO liveness check, NO circuit-breaker gate, NO queue, NO session-is-idle check. It will happily send-keys into a pane whose foreground process is already mid-tool-call. tmux `send-keys` writes to the pty input buffer — if Claude Code's input line is already busy (e.g. "Marinating…" state), those keystrokes get APPENDED to the existing input buffer; they do not dispatch as a new prompt until the current turn finishes and the user's input line becomes free again. To the monitor they look "silently dropped."

Liveness-flip concern: Sadie's `agent_sessions.state` is currently `alive` (fault_count=1, circuit closed). Boss's row shows `circuit_state=open`, fault_count=280, cooldown 14:28:58 — but `nudge_agent` does NOT check the circuit (only `delegate_task` does, server.ts:651). So nudges bypass the circuit entirely; the "refusing to send because it thinks she is dead" hypothesis is NOT the cause.

Task #247 had nudge_count=39 and escalation_level=39 — nudges were being logged and tmux exit 0 was returned. They weren't dropped at the delivery layer; they landed in a busy input buffer.

Confidence: high. Next action: make nudgeAgent check pane busy-state before send-keys, or switch to a proper inbox-file channel that the target polls.

## 4. Is the PostToolUse hook error related to the nudge failure?
Almost certainly NO direct causal link. PostToolUse runs in the target session's hook chain but is marked non-blocking (Claude reported `hook_non_blocking_error`, not `hook_blocking_error`), so exit 1 is cosmetic — it does not freeze stdin, does not hold the pty, and does not block `tmux send-keys` from another process. Settings.json has no `"blocking":true` or timeout on this hook. The two bugs are independent but happened to co-occur during the same incident:

- Hook error = cosmetic noise in tmux on every telegram reply.
- Nudge drop = send-keys landing in a busy input line while Sadie was mid-marinate.

Confidence: high. Next action: fix both separately; do not couple them.

## 5. Other failure modes observed
a. `get_boot_briefing` returned 233,993 characters and was refused by Sadie's harness as `result exceeds maximum allowed tokens`, spilling to a tool-results file. Boot briefing is unbounded — bug: needs truncation/pagination.
b. `nudge_agent` bypasses circuit breaker entirely while `delegate_task` enforces it — inconsistent. Boss's circuit is currently open (280 faults) but boss nudges still fire.
c. `AGENT_LABEL env var not set` warnings in watchdog.log (lines 5272+) — MCP server instances starting without `AGENT_LABEL`, `SELF_LABEL` falling back to "unknown" and polluting audit rows.
d. tmux send-keys has no idempotency / no duplicate suppression — 39 nudges on task #247 hammered Sadie's input buffer.
e. `/tmp/telegram_typing/1712539766.placeholder.lock` is a stale `mkdir` lock directory from the current session; if the stop hook errors before `rmdir`, it leaks. Currently present.

Confidence: high on (a)(b)(c)(d), medium on (e). Next actions: cap boot_briefing output; add circuit gate to nudge_agent; require AGENT_LABEL at server startup; add nudge dedupe / busy-pane detection.
