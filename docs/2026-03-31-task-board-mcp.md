# Task Board MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that gives all 4 Claude Code agents (Boss, Steve, Sadie, Kiera) a shared task board for inter-agent coordination, with tmux-based wake signals and auto-posting to the Telegram group.

**Architecture:** A Bun + TypeScript MCP server using stdio transport. SQLite (via `bun:sqlite`) for persistent task storage. tmux `send-keys` for instant agent wake. Telegram Bot API (curl/fetch) for group status posts. Loaded by all agents via `--mcp-config`.

**Tech Stack:** Bun runtime, TypeScript, @modelcontextprotocol/sdk, bun:sqlite, Telegram Bot API (HTTP), tmux CLI

---

## File Structure

```
~/.claude/mcp-servers/task-board/
  package.json              — dependencies and start script
  server.ts                 — MCP server entry point, tool registration
  db.ts                     — SQLite schema, migrations, query functions
  nudge.ts                  — tmux send-keys wake mechanism
  notify.ts                 — Telegram group auto-post on task events
  config.ts                 — constants (group ID, session names, DB path)
  mcp.json                  — MCP config for --mcp-config flag
  tests/
    db.test.ts              — database CRUD tests
    nudge.test.ts           — tmux nudge tests
    notify.test.ts          — Telegram notification tests
    integration.test.ts     — full end-to-end tool call tests
```

## Spec Gate

The following spec items MUST all pass before this build is considered complete:

- [ ] **SG-1:** `create_task` tool creates a task in SQLite with from, to, description, priority, timestamps
- [ ] **SG-2:** `claim_task` tool atomically claims a task (no double-claims)
- [ ] **SG-3:** `complete_task` tool marks task done with a result string
- [ ] **SG-4:** `list_tasks` tool filters by: mine, pending, all, completed
- [ ] **SG-5:** `send_note` tool appends a note to a task with from/message/timestamp
- [ ] **SG-6:** `nudge_agent` tool sends a wake message to a target agent's tmux session
- [ ] **SG-7:** `create_task` auto-nudges the target agent via tmux after creation
- [ ] **SG-8:** `create_task` auto-posts status to Telegram group (-1003790554582)
- [ ] **SG-9:** `complete_task` auto-posts status to Telegram group
- [ ] **SG-10:** MCP server starts via `bun server.ts` with stdio transport
- [ ] **SG-11:** MCP config loads correctly via `--mcp-config` flag
- [ ] **SG-12:** All 4 agents can access the shared SQLite database concurrently
- [ ] **SG-13:** All unit tests pass: `bun test`
- [ ] **SG-14:** Live integration test: Boss creates task for Steve, Steve receives nudge, claims task, completes it, group gets status updates

---

### Task 1: Project Scaffold

**Files:**
- Create: `~/.claude/mcp-servers/task-board/package.json`
- Create: `~/.claude/mcp-servers/task-board/config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "task-board-mcp",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "bun server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd ~/.claude/mcp-servers/task-board && bun install`
Expected: lockfile created, node_modules populated

- [ ] **Step 3: Create config.ts**

```typescript
import { join } from 'path'

export const DB_PATH = join(
  process.env.HOME ?? '/tmp',
  '.claude',
  'mcp-servers',
  'task-board',
  'tasks.db',
)

export const TELEGRAM_GROUP_ID = '-1003790554582'

// Bot token is passed via env var TELEGRAM_BOT_TOKEN by the pool script
export const getTelegramToken = (): string | undefined =>
  process.env.TELEGRAM_BOT_TOKEN

// Map of agent labels to tmux session names
export const AGENT_SESSIONS: Record<string, string> = {
  boss: 'claude-boss',
  steve: 'claude-steve',
  sadie: 'claude-sadie',
  kiera: 'claude-kiera',
}

// The agent label for this session (set by pool script via env var)
export const SELF_LABEL = process.env.AGENT_LABEL ?? 'unknown'
```

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git init
git add package.json bun.lockb config.ts
git commit -m "feat: scaffold task-board MCP project"
```

---

### Task 2: SQLite Database Module

**Files:**
- Create: `~/.claude/mcp-servers/task-board/db.ts`
- Create: `~/.claude/mcp-servers/task-board/tests/db.test.ts`

- [ ] **Step 1: Write failing tests for database operations**

```typescript
// tests/db.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-test.db'

describe('TaskDB', () => {
  let db: TaskDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    db = new TaskDB(TEST_DB)
  })

  test('createTask returns a task with id and pending status', () => {
    const task = db.createTask({
      from: 'boss',
      to: 'steve',
      description: 'Update landing page',
      priority: 'normal',
    })
    expect(task.id).toBeGreaterThan(0)
    expect(task.status).toBe('pending')
    expect(task.from_agent).toBe('boss')
    expect(task.to_agent).toBe('steve')
    expect(task.description).toBe('Update landing page')
  })

  test('claimTask sets status to in_progress', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    const claimed = db.claimTask(task.id, 'steve')
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.claimed_at).toBeTruthy()
  })

  test('claimTask fails on already claimed task', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')
    const second = db.claimTask(task.id, 'sadie')
    expect(second).toBeNull()
  })

  test('completeTask sets status to completed with result', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')
    const completed = db.completeTask(task.id, 'Done — updated hero text')
    expect(completed?.status).toBe('completed')
    expect(completed?.result).toBe('Done — updated hero text')
    expect(completed?.completed_at).toBeTruthy()
  })

  test('listTasks filters by assignee', () => {
    db.createTask({ from: 'boss', to: 'steve', description: 'task 1', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'sadie', description: 'task 2', priority: 'normal' })
    const steveTasks = db.listTasks({ assignee: 'steve' })
    expect(steveTasks).toHaveLength(1)
    expect(steveTasks[0].to_agent).toBe('steve')
  })

  test('listTasks filters by status', () => {
    const t = db.createTask({ from: 'boss', to: 'steve', description: 'task 1', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'steve', description: 'task 2', priority: 'normal' })
    db.claimTask(t.id, 'steve')
    const pending = db.listTasks({ status: 'pending' })
    expect(pending).toHaveLength(1)
  })

  test('addNote appends a note to a task', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.addNote(task.id, 'boss', 'Make sure to update the CTA too')
    const notes = db.getNotes(task.id)
    expect(notes).toHaveLength(1)
    expect(notes[0].from_agent).toBe('boss')
    expect(notes[0].message).toBe('Make sure to update the CTA too')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/db.test.ts`
Expected: FAIL — `Cannot find module '../db'`

- [ ] **Step 3: Implement db.ts**

```typescript
// db.ts
import { Database } from 'bun:sqlite'

export interface Task {
  id: number
  from_agent: string
  to_agent: string
  description: string
  priority: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  result: string | null
  created_at: string
  claimed_at: string | null
  completed_at: string | null
}

export interface Note {
  id: number
  task_id: number
  from_agent: string
  message: string
  created_at: string
}

export interface CreateTaskInput {
  from: string
  to: string
  description: string
  priority: string
}

export interface ListFilter {
  assignee?: string
  status?: string
}

export class TaskDB {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        from_agent TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_to_agent ON tasks(to_agent);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_notes_task_id ON notes(task_id);
    `)
  }

  createTask(input: CreateTaskInput): Task {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (from_agent, to_agent, description, priority)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    return stmt.get(input.from, input.to, input.description, input.priority) as Task
  }

  claimTask(id: number, agent: string): Task | null {
    const stmt = this.db.prepare(
      `UPDATE tasks
       SET status = 'in_progress', claimed_at = datetime('now')
       WHERE id = ? AND status = 'pending'
       RETURNING *`
    )
    return (stmt.get(id) as Task) ?? null
  }

  completeTask(id: number, result: string): Task | null {
    const stmt = this.db.prepare(
      `UPDATE tasks
       SET status = 'completed', result = ?, completed_at = datetime('now')
       WHERE id = ? AND status = 'in_progress'
       RETURNING *`
    )
    return (stmt.get(result, id) as Task) ?? null
  }

  cancelTask(id: number): Task | null {
    const stmt = this.db.prepare(
      `UPDATE tasks
       SET status = 'cancelled'
       WHERE id = ? AND status IN ('pending', 'in_progress')
       RETURNING *`
    )
    return (stmt.get(id) as Task) ?? null
  }

  getTask(id: number): Task | null {
    return (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task) ?? null
  }

  listTasks(filter: ListFilter = {}): Task[] {
    let sql = 'SELECT * FROM tasks WHERE 1=1'
    const params: string[] = []

    if (filter.assignee) {
      sql += ' AND to_agent = ?'
      params.push(filter.assignee)
    }
    if (filter.status) {
      sql += ' AND status = ?'
      params.push(filter.status)
    }

    sql += ' ORDER BY created_at DESC'
    return this.db.prepare(sql).all(...params) as Task[]
  }

  addNote(taskId: number, from: string, message: string): Note {
    const stmt = this.db.prepare(
      `INSERT INTO notes (task_id, from_agent, message)
       VALUES (?, ?, ?)
       RETURNING *`
    )
    return stmt.get(taskId, from, message) as Note
  }

  getNotes(taskId: number): Note[] {
    return this.db.prepare(
      'SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as Note[]
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/db.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add db.ts tests/db.test.ts
git commit -m "feat: SQLite task board with CRUD operations and tests"
```

---

### Task 3: tmux Nudge Module

**Files:**
- Create: `~/.claude/mcp-servers/task-board/nudge.ts`
- Create: `~/.claude/mcp-servers/task-board/tests/nudge.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/nudge.test.ts
import { describe, test, expect, mock } from 'bun:test'
import { buildNudgeCommand, resolveSession } from '../nudge'

describe('nudge', () => {
  test('resolveSession maps agent label to tmux session name', () => {
    expect(resolveSession('steve')).toBe('claude-steve')
    expect(resolveSession('boss')).toBe('claude-boss')
    expect(resolveSession('unknown-agent')).toBeNull()
  })

  test('buildNudgeCommand creates correct tmux send-keys command', () => {
    const cmd = buildNudgeCommand('claude-steve', 'You have a new task (#5) from boss: Update landing page')
    expect(cmd).toEqual([
      'tmux', 'send-keys', '-t', 'claude-steve',
      'You have a new task (#5) from boss: Update landing page',
      'Enter',
    ])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/nudge.test.ts`
Expected: FAIL — `Cannot find module '../nudge'`

- [ ] **Step 3: Implement nudge.ts**

```typescript
// nudge.ts
import { AGENT_SESSIONS } from './config'

export function resolveSession(agent: string): string | null {
  const label = agent.toLowerCase()
  return AGENT_SESSIONS[label] ?? null
}

export function buildNudgeCommand(session: string, message: string): string[] {
  return ['tmux', 'send-keys', '-t', session, message, 'Enter']
}

export async function nudgeAgent(
  agent: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = resolveSession(agent)
  if (!session) {
    return { ok: false, error: `Unknown agent: ${agent}` }
  }

  const cmd = buildNudgeCommand(session, message)
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, error: `tmux failed (exit ${exitCode}): ${stderr.trim()}` }
  }

  return { ok: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/nudge.test.ts`
Expected: All 2 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add nudge.ts tests/nudge.test.ts
git commit -m "feat: tmux nudge module for agent wake signals"
```

---

### Task 4: Telegram Group Notification Module

**Files:**
- Create: `~/.claude/mcp-servers/task-board/notify.ts`
- Create: `~/.claude/mcp-servers/task-board/tests/notify.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/notify.test.ts
import { describe, test, expect } from 'bun:test'
import { formatTaskCreated, formatTaskCompleted, formatTaskClaimed } from '../notify'

describe('notify formatting', () => {
  test('formatTaskCreated produces correct status message', () => {
    const msg = formatTaskCreated({
      id: 5,
      from_agent: 'boss',
      to_agent: 'steve',
      description: 'Update landing page copy',
      priority: 'high',
      status: 'pending',
      result: null,
      created_at: '2026-03-31 12:00:00',
      claimed_at: null,
      completed_at: null,
    })
    expect(msg).toContain('#5')
    expect(msg).toContain('boss')
    expect(msg).toContain('steve')
    expect(msg).toContain('Update landing page copy')
  })

  test('formatTaskCompleted includes result', () => {
    const msg = formatTaskCompleted({
      id: 5,
      from_agent: 'boss',
      to_agent: 'steve',
      description: 'Update landing page copy',
      priority: 'normal',
      status: 'completed',
      result: 'Done — updated hero text and CTA',
      created_at: '2026-03-31 12:00:00',
      claimed_at: '2026-03-31 12:01:00',
      completed_at: '2026-03-31 12:05:00',
    })
    expect(msg).toContain('#5')
    expect(msg).toContain('Done — updated hero text and CTA')
  })

  test('formatTaskClaimed shows agent claiming', () => {
    const msg = formatTaskClaimed({
      id: 5,
      from_agent: 'boss',
      to_agent: 'steve',
      description: 'Update landing page',
      priority: 'normal',
      status: 'in_progress',
      result: null,
      created_at: '2026-03-31 12:00:00',
      claimed_at: '2026-03-31 12:01:00',
      completed_at: null,
    })
    expect(msg).toContain('#5')
    expect(msg).toContain('steve')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/notify.test.ts`
Expected: FAIL — `Cannot find module '../notify'`

- [ ] **Step 3: Implement notify.ts**

```typescript
// notify.ts
import type { Task } from './db'
import { TELEGRAM_GROUP_ID, getTelegramToken } from './config'

export function formatTaskCreated(task: Task): string {
  return `📋 Task #${task.id} assigned\nFrom: ${task.from_agent} → To: ${task.to_agent}\nPriority: ${task.priority}\n${task.description}`
}

export function formatTaskClaimed(task: Task): string {
  return `🔨 Task #${task.id} claimed by ${task.to_agent}\n${task.description}`
}

export function formatTaskCompleted(task: Task): string {
  return `✅ Task #${task.id} completed by ${task.to_agent}\n${task.description}\nResult: ${task.result}`
}

export function formatNote(taskId: number, from: string, message: string): string {
  return `💬 Note on task #${taskId} from ${from}:\n${message}`
}

export async function postToGroup(text: string): Promise<void> {
  const token = getTelegramToken()
  if (!token) return

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_GROUP_ID,
        text,
      }),
    })
  } catch {
    // Silently fail — notification is best-effort
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/notify.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add notify.ts tests/notify.test.ts
git commit -m "feat: Telegram group notification module for task events"
```

---

### Task 5: MCP Server Entry Point

**Files:**
- Create: `~/.claude/mcp-servers/task-board/server.ts`

- [ ] **Step 1: Implement server.ts**

```typescript
#!/usr/bin/env bun
// server.ts — Task Board MCP server
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TaskDB } from './db'
import { nudgeAgent } from './nudge'
import {
  postToGroup,
  formatTaskCreated,
  formatTaskClaimed,
  formatTaskCompleted,
  formatNote,
} from './notify'
import { DB_PATH, SELF_LABEL } from './config'

const db = new TaskDB(DB_PATH)

const mcp = new Server(
  { name: 'task-board', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You are agent "${SELF_LABEL}". You have a shared task board with other agents (boss, steve, sadie, kiera).`,
      'Use create_task to assign work to another agent. It auto-nudges them and posts to the team group.',
      'Use list_tasks to check your inbox (filter: "mine") or see all work.',
      'Use claim_task when you start working on a task assigned to you.',
      'Use complete_task when done — include a result summary.',
      'Use send_note to add context to any task.',
      'Use nudge_agent to wake an agent without creating a task.',
      'Always delegate complex work to subagents (Agent tool) to keep your context clean.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_task',
      description: 'Create a task and assign it to another agent. Auto-nudges the target agent and posts to the team Telegram group.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          description: { type: 'string', description: 'What needs to be done' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Task priority (default: normal)' },
        },
        required: ['to', 'description'],
      },
    },
    {
      name: 'claim_task',
      description: 'Claim a pending task assigned to you. Sets status to in_progress.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to claim' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a task as completed with a result summary. Posts to team group.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to complete' },
          result: { type: 'string', description: 'Summary of what was done' },
        },
        required: ['task_id', 'result'],
      },
    },
    {
      name: 'list_tasks',
      description: 'List tasks. Filter by assignee and/or status.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['mine', 'pending', 'in_progress', 'completed', 'all'],
            description: '"mine" shows tasks assigned to you. Others filter by status. Default: mine.',
          },
        },
      },
    },
    {
      name: 'send_note',
      description: 'Add a note/comment to a task. Posts to team group.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID' },
          message: { type: 'string', description: 'The note content' },
        },
        required: ['task_id', 'message'],
      },
    },
    {
      name: 'nudge_agent',
      description: 'Send a wake message to another agent without creating a task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['agent', 'message'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'create_task': {
        const to = (args.to as string).toLowerCase()
        const description = args.description as string
        const priority = (args.priority as string) ?? 'normal'

        const task = db.createTask({
          from: SELF_LABEL,
          to,
          description,
          priority,
        })

        // Auto-nudge target agent
        const nudgeMsg = `You have a new task (#${task.id}) from ${SELF_LABEL}: ${description}`
        await nudgeAgent(to, nudgeMsg)

        // Auto-post to group
        await postToGroup(formatTaskCreated(task))

        return {
          content: [{
            type: 'text',
            text: `Task #${task.id} created and assigned to ${to}. Agent nudged.`,
          }],
        }
      }

      case 'claim_task': {
        const taskId = args.task_id as number
        const task = db.claimTask(taskId, SELF_LABEL)

        if (!task) {
          return {
            content: [{
              type: 'text',
              text: `Cannot claim task #${taskId} — either it doesn't exist or is already claimed.`,
              isError: true,
            }],
          }
        }

        await postToGroup(formatTaskClaimed(task))

        return {
          content: [{
            type: 'text',
            text: `Claimed task #${task.id}: ${task.description}`,
          }],
        }
      }

      case 'complete_task': {
        const taskId = args.task_id as number
        const result = args.result as string
        const task = db.completeTask(taskId, result)

        if (!task) {
          return {
            content: [{
              type: 'text',
              text: `Cannot complete task #${taskId} — either it doesn't exist or isn't in progress.`,
              isError: true,
            }],
          }
        }

        // Notify the task creator
        const nudgeMsg = `Task #${task.id} completed by ${SELF_LABEL}: ${result}`
        await nudgeAgent(task.from_agent, nudgeMsg)

        await postToGroup(formatTaskCompleted(task))

        return {
          content: [{
            type: 'text',
            text: `Task #${task.id} completed. Result: ${result}`,
          }],
        }
      }

      case 'list_tasks': {
        const filterStr = (args.filter as string) ?? 'mine'
        let filter: { assignee?: string; status?: string } = {}

        if (filterStr === 'mine') {
          filter.assignee = SELF_LABEL
        } else if (filterStr !== 'all') {
          filter.status = filterStr
        }

        const tasks = db.listTasks(filter)

        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: 'No tasks found.' }] }
        }

        const lines = tasks.map(
          (t) => `#${t.id} [${t.status}] ${t.from_agent}→${t.to_agent}: ${t.description}${t.result ? ` | Result: ${t.result}` : ''}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'send_note': {
        const taskId = args.task_id as number
        const message = args.message as string

        const task = db.getTask(taskId)
        if (!task) {
          return {
            content: [{ type: 'text', text: `Task #${taskId} not found.`, isError: true }],
          }
        }

        db.addNote(taskId, SELF_LABEL, message)
        await postToGroup(formatNote(taskId, SELF_LABEL, message))

        return {
          content: [{ type: 'text', text: `Note added to task #${taskId}.` }],
        }
      }

      case 'nudge_agent': {
        const agent = (args.agent as string).toLowerCase()
        const message = args.message as string
        const result = await nudgeAgent(agent, message)

        if (!result.ok) {
          return {
            content: [{ type: 'text', text: `Nudge failed: ${result.error}`, isError: true }],
          }
        }

        return {
          content: [{ type: 'text', text: `Nudged ${agent}: ${message}` }],
        }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${req.params.name}`, isError: true }],
        }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err}`, isError: true }],
    }
  }
})

// Connect
await mcp.connect(new StdioServerTransport())

// Cleanup on exit
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
```

- [ ] **Step 2: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add server.ts
git commit -m "feat: MCP server with all 6 task board tools"
```

---

### Task 6: MCP Config and Pool Script Integration

**Files:**
- Create: `~/.claude/mcp-servers/task-board/mcp.json`
- Modify: `~/.claude/telegram-pool.sh` — add AGENT_LABEL env var and --mcp-config flag

- [ ] **Step 1: Create mcp.json**

```json
{
  "mcpServers": {
    "task-board": {
      "command": "bun",
      "args": ["run", "/Users/coachstokes/.claude/mcp-servers/task-board/server.ts"]
    }
  }
}
```

- [ ] **Step 2: Update telegram-pool.sh to pass AGENT_LABEL and load task-board MCP**

In the BOTS array, no changes needed. Add two things:

After the line `echo "✓  Using Telegram bot: $CHOSEN_LABEL"`, the script already builds `bot_flags` from the config file. Add the task-board MCP config and AGENT_LABEL to the launch command.

Change the final launch line from:
```bash
TELEGRAM_BOT_TOKEN="$CHOSEN_TOKEN" exec claude "${BASE_FLAGS[@]}" "${bot_flags[@]}" "${CHANNEL_FLAGS[@]}"
```

To:
```bash
TELEGRAM_BOT_TOKEN="$CHOSEN_TOKEN" AGENT_LABEL="${CHOSEN_LABEL,,}" exec claude "${BASE_FLAGS[@]}" "${bot_flags[@]}" --mcp-config "$HOME/.claude/mcp-servers/task-board/mcp.json" "${CHANNEL_FLAGS[@]}"
```

Note: `${CHOSEN_LABEL,,}` lowercases the label (Boss→boss, Steve→steve, etc.)

- [ ] **Step 3: Test MCP server starts**

Run: `cd ~/.claude/mcp-servers/task-board && echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | AGENT_LABEL=boss bun server.ts 2>/dev/null | head -1`
Expected: JSON response containing tool definitions

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add mcp.json
cd ~/.claude
git add telegram-pool.sh  # or commit separately
```

---

### Task 7: Integration Test

**Files:**
- Create: `~/.claude/mcp-servers/task-board/tests/integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { buildNudgeCommand, resolveSession } from '../nudge'
import { formatTaskCreated, formatTaskCompleted } from '../notify'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-integration.db'

describe('integration: full task lifecycle', () => {
  let db: TaskDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    db = new TaskDB(TEST_DB)
  })

  test('boss creates task → steve claims → steve completes', () => {
    // Boss creates
    const task = db.createTask({
      from: 'boss',
      to: 'steve',
      description: 'Pull Shopify sales report',
      priority: 'high',
    })
    expect(task.status).toBe('pending')

    // Verify nudge would target correct session
    const session = resolveSession('steve')
    expect(session).toBe('claude-steve')
    const cmd = buildNudgeCommand(session!, `New task #${task.id}`)
    expect(cmd[3]).toBe('claude-steve')

    // Verify notification format
    const createMsg = formatTaskCreated(task)
    expect(createMsg).toContain('boss')
    expect(createMsg).toContain('steve')

    // Steve claims
    const claimed = db.claimTask(task.id, 'steve')
    expect(claimed?.status).toBe('in_progress')

    // Sadie can't double-claim
    const doubleClaim = db.claimTask(task.id, 'sadie')
    expect(doubleClaim).toBeNull()

    // Steve adds a note
    db.addNote(task.id, 'steve', 'Working on it, pulling data now')
    const notes = db.getNotes(task.id)
    expect(notes).toHaveLength(1)

    // Steve completes
    const completed = db.completeTask(task.id, '5 orders, $289.80 revenue')
    expect(completed?.status).toBe('completed')
    expect(completed?.result).toBe('5 orders, $289.80 revenue')

    // Verify completion notification
    const completeMsg = formatTaskCompleted(completed!)
    expect(completeMsg).toContain('$289.80')

    // Verify listing
    const steveTasks = db.listTasks({ assignee: 'steve' })
    expect(steveTasks).toHaveLength(1)
    expect(steveTasks[0].status).toBe('completed')
  })

  test('concurrent tasks across multiple agents', () => {
    db.createTask({ from: 'boss', to: 'steve', description: 'Task A', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'sadie', description: 'Task B', priority: 'high' })
    db.createTask({ from: 'boss', to: 'kiera', description: 'Task C', priority: 'normal' })

    const all = db.listTasks({})
    expect(all).toHaveLength(3)

    const pending = db.listTasks({ status: 'pending' })
    expect(pending).toHaveLength(3)

    // Each agent claims their own
    db.claimTask(1, 'steve')
    db.claimTask(2, 'sadie')

    const inProgress = db.listTasks({ status: 'in_progress' })
    expect(inProgress).toHaveLength(2)

    const stillPending = db.listTasks({ status: 'pending' })
    expect(stillPending).toHaveLength(1)
    expect(stillPending[0].to_agent).toBe('kiera')
  })
})
```

- [ ] **Step 2: Run all tests**

Run: `cd ~/.claude/mcp-servers/task-board && bun test`
Expected: All tests PASS (db: 7, nudge: 2, notify: 3, integration: 2 = 14 total)

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add tests/integration.test.ts
git commit -m "feat: integration tests for full task lifecycle"
```

---

### Task 8: Live Deployment and Verification

- [ ] **Step 1: Kill existing tmux sessions**

```bash
tmux kill-server 2>/dev/null
rm -f ~/.claude/channels/telegram/locks/*.lock
```

- [ ] **Step 2: Update pool script with task-board MCP and AGENT_LABEL**

Apply the changes from Task 6 Step 2 to `~/.claude/telegram-pool.sh`.

- [ ] **Step 3: Lock Boss and launch 3 tmux sessions**

```bash
LOCK_ID=$(echo -n "BOSS_TOKEN" | shasum -a 256 | cut -c1-12)
echo "EXTERNAL" > ~/.claude/channels/telegram/locks/${LOCK_ID}.lock

# Launch sessions with staggered delays
for name in claude-steve claude-sadie claude-kiera; do
  tmux new-session -d -s "$name"
  tmux send-keys -t "$name" "source ~/.claude/telegram-pool.sh" Enter
  sleep 4
  tmux send-keys -t "$name" Enter  # accept trust prompt
  sleep 3
done
```

- [ ] **Step 4: Verify task-board MCP loaded in sessions**

Check each tmux session for MCP server connection. The agents should have `task-board` in their MCP list.

- [ ] **Step 5: Run live test — SG-14**

From Boss session, create a task for Steve:
1. Boss calls `create_task(to="steve", description="Pull today's Shopify order count")`
2. Verify Steve's tmux session receives the nudge
3. Verify Telegram group gets the status post
4. In Steve's session, call `claim_task(task_id=1)`
5. Steve calls `complete_task(task_id=1, result="5 orders, $289.80")`
6. Verify Boss gets nudge about completion
7. Verify Telegram group gets completion post

- [ ] **Step 6: Final commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add -A
git commit -m "feat: task-board MCP v0.1.0 — deployed and verified"
```

---

## Spec Gate Verification Checklist

Run through each spec gate item and mark as passed:

- [ ] **SG-1:** `create_task` → check SQLite for new row with correct fields
- [ ] **SG-2:** `claim_task` → verify atomic claim (test double-claim returns null)
- [ ] **SG-3:** `complete_task` → verify status=completed, result populated
- [ ] **SG-4:** `list_tasks` → test mine/pending/all/completed filters
- [ ] **SG-5:** `send_note` → verify note persisted with from/message/timestamp
- [ ] **SG-6:** `nudge_agent` → verify tmux send-keys reaches target session
- [ ] **SG-7:** `create_task` auto-nudge → Steve's session shows nudge message
- [ ] **SG-8:** `create_task` auto-post → group chat shows task creation message
- [ ] **SG-9:** `complete_task` auto-post → group chat shows completion message
- [ ] **SG-10:** `bun server.ts` starts without errors
- [ ] **SG-11:** `--mcp-config mcp.json` loads tools in Claude Code
- [ ] **SG-12:** Multiple agents read/write SQLite concurrently (WAL mode)
- [ ] **SG-13:** `bun test` → all tests pass
- [ ] **SG-14:** Live end-to-end: Boss→create→Steve→claim→complete→group notified
