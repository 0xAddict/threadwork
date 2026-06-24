---
name: reset-taskboard
description: Reconnect the task-board MCP server on agent sessions via tmux. Use when the task-board MCP needs restarting after code changes, or when an agent reports task-board disconnection. Accepts optional agent name argument (default: all agents).
---

# Reset Task Board MCP

Reconnects the task-board MCP server on Claude Code agent sessions using the /mcp interactive panel via tmux send-keys.

## Formula

`/mcp` → 1x Up → Enter → 1x Down → Enter = reconnect task-board

The /mcp panel lists MCP servers. task-board is the LAST item. Pressing Up once from the default cursor position (top) wraps to task-board. Enter opens the sub-menu. "Reconnect" is 1 Down from the default "View tools" option.

## Usage

### Single agent
```bash
# Replace {agent} with: boss, steve, sadie, kiera, snoopy
tmux send-keys -t claude-{agent} C-m
sleep 1
tmux send-keys -t claude-{agent} '/mcp' C-m
sleep 3
tmux send-keys -t claude-{agent} Up
sleep 0.5
tmux send-keys -t claude-{agent} Enter
sleep 2
tmux send-keys -t claude-{agent} Down
sleep 0.5
tmux send-keys -t claude-{agent} Enter
sleep 5
# Verify: capture pane to confirm reconnection
tmux capture-pane -t claude-{agent} -p | tail -10
```

### All agents
Run the above sequence for each of: claude-boss, claude-steve, claude-sadie, claude-kiera, claude-snoopy. Wait 5 seconds between agents to avoid race conditions on the MCP server process.

## Notes

- The tap count (1 Up, 1 Down) is based on task-board being the LAST server in the /mcp list. If new MCP servers are added, verify the position first.
- Reconnecting restarts the MCP server process — in-flight tool calls on that server will be dropped.
- After reconnection, agents will re-handshake with the MCP server and pick up any code changes on disk.
- The /mcp panel is an interactive TUI — send-keys timing matters. If the panel doesn't render in 3 seconds, increase the sleep.
- Send C-m (Enter) first to ensure a clean prompt before /mcp.
