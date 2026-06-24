---
name: task-delegation
description: Use when receiving any task from the task board, before doing any direct work — enforces delegation to persistent runner or sub-agent, with per-task monitoring loops. Main thread is a dispatcher, never a worker.
---

# task-delegation

## Purpose

Enforce the threadwork dispatcher pattern: never execute work directly in the main thread; always delegate to a named persistent sub-agent. The main thread exists only to receive nudges, claim tasks, delegate, and stay responsive.

**Core principle:** The main thread is a dispatcher, not a worker.

## When to fire

- Receiving any task from the task board
- Before doing any direct work — enforces delegation to persistent runner or sub-agent
- Per-task monitoring loops

## On Boot

Spawn two named background agents immediately after boot briefing:

```
Agent(name="{you}-runner", model="sonnet", run_in_background=true,
  prompt="You are {you}'s task runner. Execute simple, bounded tasks.
  MCP access to task board. When working:
  1. Post send_note updates every few minutes
  2. complete_task when done
  3. Wait for next task via SendMessage.
  Identity: you act AS {you} on the task board.")

Agent(name="{you}-agent", model="opus", run_in_background=true,
  prompt="You are {you}'s sub-agent for complex work — research, multi-step,
  code generation, analysis.
  MCP access to task board. When working:
  1. Post send_note updates every few minutes
  2. complete_task when done
  3. Wait for next task via SendMessage.
  Identity: you act AS {you} on the task board.")
```

Replace `{you}` with agent name (steve/sadie/kiera/boss). Boss only spawns runners.

## When a Task Arrives

```
Task arrives via nudge → claim_task → simple/complex decision →
  → SendMessage({you}-runner | {you}-agent) → spawn monitor loop → return to idle
```

### Simple vs Complex

| Simple (runner) | Complex (sub-agent) |
|----------------|---------------------|
| Single API call | Multi-step research |
| Format + send message | Code generation/edits |
| Look up one piece of data | Analysis across sources |
| Straightforward CRUD | Judgment calls required |
| < 5 min expected | > 5 min expected |

### Delegation message format

```
SendMessage(to="{you}-runner", message="
  TASK #{id}: {description}
  PRIORITY: {priority}
  FROM: {from_agent}
  Post send_note updates to task #{id} as you work.
  Call complete_task(task_id={id}, result='...') when done.
")
```

## The Monitor Loop

When you delegate your FIRST task, start ONE monitor loop:

```
/loop 2m Monitor my delegated tasks. Use read_status(agent="{you}") to check all active task status entries. For each task: if status is "working" with recent timestamps, report a one-line summary. If status is "blocked" or no new entries since last check, that's an idle check — track consecutive idle checks per task. On 2 idle checks, SendMessage to the stuck runner/sub-agent asking for status. On 3 idle checks, escalate to Boss via nudge_agent (or to user if you ARE Boss) and offer to interrupt_agent. If status is "complete", call clear_status(agent="{you}", task_id=N) to clean up. If ALL tasks are cleared and no new delegations pending, cancel this loop.
```

The monitor is per-agent, not per-task. One loop watches everything.

### Monitor escalation ladder

| Consecutive idle checks | Action |
|------------------------|--------|
| 1 | Normal — work may be in progress |
| 2 | `SendMessage` to stuck runner/sub-agent: "Status update? Are you blocked?" |
| 3 | `nudge_agent` to Boss (or user). Offer `interrupt_agent`. |

### How sub-agents report status

```
write_status(agent="{parent}", task_id=42, status="working", detail="Pulling Shopify orders...")
write_status(agent="{parent}", task_id=42, status="blocked", detail="Amazon API returning 429")
write_status(agent="{parent}", task_id=42, status="complete", detail="Sent results to Telegram")
```

When task completes: `clear_status(agent="{parent}", task_id=42)`.

## One-Shot Sub-Agent Invocations (Agent tool)

When using the **Agent tool** directly (not SendMessage to persistent runner/agent), wrap the call as try/finally around `spawn_subagent` / `close_subagent`:

1. `spawn_subagent(parent_task_id=N, description="...")` and capture returned `task_id`
2. Invoke Agent tool
3. **In a finally-equivalent block — on success AND failure AND interrupt — call `close_subagent(task_id=N, result=...)` before doing anything else.** If Agent threw, pass error message as `result`.

```
child = spawn_subagent(parent_task_id=N, description="...")
try:
  out = Agent(...)
  close_subagent(child.id, result=summarize(out))
except err:
  close_subagent(child.id, result=f"Failed: {err}")
  raise   # propagate after cleanup
```

Server-side auto-close on parent `complete_task` is a backstop for crash/abort cases. It does NOT record actual sub-agent outcome and only fires when parent later completes. Skipping explicit close blinds the audit trail and leaves the watchdog spinning on dead synthetic tasks.

## Interrupt

If asked to "interrupt" an agent or sub-agent:

```
interrupt_agent(target="{agent}") → sends tmux Ctrl+C to their session
```

Use when sub-agent is stuck in infinite loop, hung on API call, needs force-stop. Monitor loop can request after escalation.

## Red Flags — You Are Violating This Skill

- Calling Shopify/Amazon/external APIs directly in main thread
- Writing code directly instead of delegating
- Running tools that take > 30 seconds in main thread
- "Just quickly doing this one thing" — NO. Delegate.
- No monitor loop running but active delegated tasks
- Waiting for sub-agent result in main thread instead of going idle

**All of these mean: STOP. Delegate to runner or sub-agent.**

## DO NOT

- Do not execute tasks directly — always delegate
- Do not block main thread waiting for sub-agent results
- Do not skip monitor loop when delegating
- Do not let monitor loop run with zero active tasks (cancel it)
- Do not spawn new runner/sub-agent per task — reuse persistent named ones via SendMessage
