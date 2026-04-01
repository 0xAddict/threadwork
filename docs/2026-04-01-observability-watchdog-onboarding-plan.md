# Observability, Watchdog & Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audit logging to all agent actions, a watchdog that detects and escalates stuck agents, and a universal operating manual with seeded role memories and boot self-check.

**Architecture:** Extend existing task-board MCP. New `audit.ts` module for logging, `watchdog.ts` standalone script for monitoring, CLAUDE.md for universal rules, `seed-roles.ts` for one-time role memory setup.

**Tech Stack:** Bun, TypeScript, bun:sqlite (existing DB), LaunchAgent (cron), tmux

---

## Spec Gate

- [ ] SG-1: audit_log table created with correct schema
- [ ] SG-2: Every tool call in server.ts logs to audit_log
- [ ] SG-3: query_audit_log tool returns filtered audit entries
- [ ] SG-4: Watchdog detects stale in-progress tasks (>10 min, no activity)
- [ ] SG-5: Watchdog nudges stuck agents via tmux with escalation backoff
- [ ] SG-6: Watchdog auto-escalates to Boss after 30 minutes
- [ ] SG-7: Watchdog detects unclaimed pending tasks (>15 min) and re-nudges
- [ ] SG-8: Watchdog detects dead tmux sessions
- [ ] SG-9: Watchdog LaunchAgent runs every 5 minutes
- [ ] SG-10: CLAUDE.md deployed at ~/.claude/CLAUDE.md
- [ ] SG-11: Role memories seeded for all 4 agents
- [ ] SG-12: Boot self-check in launch-all.sh
- [ ] SG-13: All tests pass
- [ ] SG-14: Live test: watchdog nudges stuck agent

---

### Task 1: Audit Log Table + Module

**Files:**
- Modify: `~/.claude/mcp-servers/task-board/db.ts` — add audit_log table + nudge_count column
- Create: `~/.claude/mcp-servers/task-board/audit.ts`
- Create: `~/.claude/mcp-servers/task-board/tests/audit.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/audit.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/audit-test.db'

describe('AuditLog', () => {
  let taskDb: TaskDB
  let audit: AuditLog

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    audit = new AuditLog(taskDb)
  })

  test('log creates an audit entry', () => {
    audit.log('boss', 'task_created', { to: 'steve', description: 'test' }, 1)
    const entries = audit.query({})
    expect(entries).toHaveLength(1)
    expect(entries[0].agent).toBe('boss')
    expect(entries[0].action).toBe('task_created')
    expect(JSON.parse(entries[0].detail!)).toEqual({ to: 'steve', description: 'test' })
    expect(entries[0].task_id).toBe(1)
  })

  test('query filters by agent', () => {
    audit.log('boss', 'task_created', {}, 1)
    audit.log('steve', 'task_claimed', {}, 1)
    const bossEntries = audit.query({ agent: 'boss' })
    expect(bossEntries).toHaveLength(1)
    expect(bossEntries[0].agent).toBe('boss')
  })

  test('query filters by action', () => {
    audit.log('boss', 'task_created', {}, 1)
    audit.log('boss', 'memory_saved', {}, undefined, 5)
    const memEntries = audit.query({ action: 'memory_saved' })
    expect(memEntries).toHaveLength(1)
    expect(memEntries[0].memory_id).toBe(5)
  })

  test('query filters by task_id', () => {
    audit.log('boss', 'task_created', {}, 1)
    audit.log('boss', 'task_created', {}, 2)
    const entries = audit.query({ taskId: 1 })
    expect(entries).toHaveLength(1)
  })

  test('query respects limit', () => {
    for (let i = 0; i < 20; i++) {
      audit.log('boss', 'task_created', {}, i)
    }
    const entries = audit.query({ limit: 5 })
    expect(entries).toHaveLength(5)
  })

  test('getAgentActivity returns recent entries', () => {
    audit.log('steve', 'task_claimed', {}, 1)
    audit.log('steve', 'note_added', {}, 1)
    const activity = audit.getAgentActivity('steve', 60)
    expect(activity).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/audit.test.ts`
Expected: FAIL — Cannot find module '../audit'

- [ ] **Step 3: Add audit_log table and nudge_count to db.ts migration**

In db.ts, add to the end of the migrate() exec block:

```sql
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        task_id INTEGER,
        memory_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
```

Also add nudge_count column to tasks — since we use CREATE TABLE IF NOT EXISTS and the table may already exist with data, do this safely in migrate():

```typescript
    // Add nudge_count column if missing (safe migration for existing DBs)
    try {
      this.db.exec('ALTER TABLE tasks ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0')
    } catch {
      // Column already exists
    }
```

- [ ] **Step 4: Implement audit.ts**

```typescript
// audit.ts
import type { Database } from 'bun:sqlite'
import type { TaskDB } from './db'

export interface AuditEntry {
  id: number
  agent: string
  action: string
  detail: string | null
  task_id: number | null
  memory_id: number | null
  created_at: string
}

export interface AuditFilter {
  agent?: string
  action?: string
  taskId?: number
  since?: string
  limit?: number
}

export class AuditLog {
  private db: Database

  constructor(taskDb: TaskDB) {
    this.db = (taskDb as any).db
  }

  log(agent: string, action: string, detail?: object, taskId?: number, memoryId?: number): void {
    this.db.prepare(
      `INSERT INTO audit_log (agent, action, detail, task_id, memory_id) VALUES (?, ?, ?, ?, ?)`
    ).run(agent, action, detail ? JSON.stringify(detail) : null, taskId ?? null, memoryId ?? null)
  }

  query(filter: AuditFilter): AuditEntry[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.agent) {
      conditions.push('agent = ?')
      params.push(filter.agent)
    }
    if (filter.action) {
      conditions.push('action = ?')
      params.push(filter.action)
    }
    if (filter.taskId) {
      conditions.push('task_id = ?')
      params.push(filter.taskId)
    }
    if (filter.since) {
      conditions.push('created_at >= ?')
      params.push(filter.since)
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const limit = filter.limit ?? 50
    return this.db.prepare(
      `SELECT * FROM audit_log${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, limit) as AuditEntry[]
  }

  getAgentActivity(agent: string, minutes: number): AuditEntry[] {
    return this.db.prepare(
      `SELECT * FROM audit_log WHERE agent = ? AND created_at >= datetime('now', '-' || ? || ' minutes') ORDER BY created_at DESC`
    ).all(agent, minutes) as AuditEntry[]
  }
}
```

- [ ] **Step 5: Run tests — all 6 must pass**

Run: `bun test tests/audit.test.ts`

- [ ] **Step 6: Run full suite**

Run: `bun test`

- [ ] **Step 7: Commit**

```bash
git add audit.ts tests/audit.test.ts db.ts
git commit -m "feat: audit log module with query/filter and nudge_count migration"
```

---

### Task 2: Add Audit Logging + query_audit_log to Server

**Files:**
- Modify: `~/.claude/mcp-servers/task-board/server.ts`

- [ ] **Step 1: Add import and initialization**

After `import { MemoryDB } from './memory'`, add:
```typescript
import { AuditLog } from './audit'
```

After `const mem = new MemoryDB(db)`, add:
```typescript
const audit = new AuditLog(db)
```

- [ ] **Step 2: Add query_audit_log tool definition**

In ListToolsRequestSchema handler, add after pin_memory:

```typescript
    {
      name: 'query_audit_log',
      description: 'Query the audit log to see what agents have been doing. Useful for reviewing team activity and debugging.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Filter by agent name' },
          action: { type: 'string', description: 'Filter by action type (task_created, task_claimed, task_completed, memory_saved, etc.)' },
          task_id: { type: 'number', description: 'Filter by task ID' },
          limit: { type: 'number', description: 'Max results (default: 50)' },
        },
      },
    },
```

- [ ] **Step 3: Add query_audit_log handler**

In CallToolRequestSchema handler, before `default:`:

```typescript
      case 'query_audit_log': {
        const entries = audit.query({
          agent: args.agent as string | undefined,
          action: args.action as string | undefined,
          taskId: args.task_id as number | undefined,
          limit: args.limit as number | undefined,
        })

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: 'No audit entries found.' }] }
        }

        const lines = entries.map(e => {
          const detail = e.detail ? ` ${e.detail}` : ''
          const taskRef = e.task_id ? ` [task:#${e.task_id}]` : ''
          return `${e.created_at} | ${e.agent} | ${e.action}${taskRef}${detail}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
```

- [ ] **Step 4: Add audit.log() calls to ALL existing tool handlers**

Add `audit.log()` after each successful tool operation in server.ts. For every case block:

**create_task** — after postToGroup:
```typescript
        audit.log(SELF_LABEL, 'task_created', { to, description, priority }, task.id)
```

**claim_task** — after postToGroup (success path):
```typescript
        audit.log(SELF_LABEL, 'task_claimed', { task_id: taskId }, taskId)
```
And in the failure path (before return with isError):
```typescript
        audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: 'not found or already claimed' }, taskId)
```

**complete_task** — after mem.saveMemory (success path):
```typescript
        audit.log(SELF_LABEL, 'task_completed', { task_id: taskId, result }, taskId)
```
And in the failure path:
```typescript
        audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: 'not found or not in progress' }, taskId)
```

**send_note** — after postToGroup:
```typescript
        audit.log(SELF_LABEL, 'note_added', { task_id: taskId, message }, taskId)
```

**nudge_agent** — after successful nudge:
```typescript
        audit.log(SELF_LABEL, 'agent_nudged', { target: agent, message })
```

**save_memory** — after mem.saveMemory:
```typescript
        audit.log(SELF_LABEL, 'memory_saved', { category, importance: memory.importance }, undefined, memory.id)
```

**recall_memories** — after recallMemories:
```typescript
        audit.log(SELF_LABEL, 'memory_recalled', { query: query ?? null, results_count: memories.length })
```

**get_boot_briefing** — after building sections:
```typescript
        audit.log(SELF_LABEL, 'boot_briefing', {
          role_count: briefing.role.length,
          memory_count: briefing.topMemories.length,
          shared_count: briefing.sharedMemories.length,
          task_count: briefing.recentTasks.length,
        })
```

**promote_memory** — after promoteMemory:
```typescript
        audit.log(SELF_LABEL, 'memory_promoted', { memory_id: memoryId }, undefined, memoryId)
```

**pin_memory** — after pinMemory:
```typescript
        audit.log(SELF_LABEL, 'memory_pinned', { memory_id: memoryId, pinned: !!toggled.pinned }, undefined, memoryId)
```

- [ ] **Step 5: Verify all tests pass + verify 12 tools listed**

Run: `bun test`
Run: MCP tool list check — expect 12 tools (6 task + 5 memory + 1 audit)

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat: audit logging on all tool calls + query_audit_log tool"
```

---

### Task 3: Watchdog Script

**Files:**
- Create: `~/.claude/mcp-servers/task-board/watchdog.ts`
- Create: `~/.claude/mcp-servers/task-board/tests/watchdog.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/watchdog.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { MemoryDB } from '../memory'
import { findStaleTasks, findUnclaimedTasks, determineAction } from '../watchdog'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/watchdog-test.db'

describe('watchdog', () => {
  let taskDb: TaskDB
  let audit: AuditLog

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    audit = new AuditLog(taskDb)
  })

  test('findStaleTasks returns in-progress tasks older than threshold', () => {
    const task = taskDb.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    taskDb.claimTask(task.id, 'steve')
    // Backdate claimed_at
    const db = (taskDb as any).db
    db.prepare("UPDATE tasks SET claimed_at = datetime('now', '-15 minutes') WHERE id = ?").run(task.id)

    const stale = findStaleTasks(taskDb, 10)
    expect(stale).toHaveLength(1)
    expect(stale[0].id).toBe(task.id)
  })

  test('findStaleTasks excludes tasks with recent activity', () => {
    const task = taskDb.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    taskDb.claimTask(task.id, 'steve')
    const db = (taskDb as any).db
    db.prepare("UPDATE tasks SET claimed_at = datetime('now', '-15 minutes') WHERE id = ?").run(task.id)

    // Add recent audit activity
    audit.log('steve', 'note_added', { message: 'working on it' }, task.id)

    const stale = findStaleTasks(taskDb, 10, audit)
    expect(stale).toHaveLength(0) // Has recent activity, not stale
  })

  test('findUnclaimedTasks returns pending tasks older than threshold', () => {
    const task = taskDb.createTask({ from: 'boss', to: 'steve', description: 'old task', priority: 'normal' })
    const db = (taskDb as any).db
    db.prepare("UPDATE tasks SET created_at = datetime('now', '-20 minutes') WHERE id = ?").run(task.id)

    const unclaimed = findUnclaimedTasks(taskDb, 15)
    expect(unclaimed).toHaveLength(1)
  })

  test('determineAction returns nudge for nudge_count 0', () => {
    expect(determineAction(0)).toBe('first_nudge')
  })

  test('determineAction returns warning for nudge_count 1', () => {
    expect(determineAction(1)).toBe('second_nudge')
  })

  test('determineAction returns escalate for nudge_count >= 2', () => {
    expect(determineAction(2)).toBe('escalate')
    expect(determineAction(5)).toBe('escalate')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement watchdog.ts**

```typescript
#!/usr/bin/env bun
// watchdog.ts — Detect stuck agents and escalate
import { TaskDB, type Task } from './db'
import { AuditLog } from './audit'
import { nudgeAgent } from './nudge'
import { postToGroup } from './notify'
import { DB_PATH, AGENT_SESSIONS, getTelegramToken } from './config'

export function findStaleTasks(taskDb: TaskDB, minutesThreshold: number, audit?: AuditLog): Task[] {
  const db = (taskDb as any).db
  const stale = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'in_progress'
    AND claimed_at < datetime('now', '-' || ? || ' minutes')
  `).all(minutesThreshold) as Task[]

  if (!audit) return stale

  // Filter out tasks where the agent has recent activity
  return stale.filter(task => {
    const activity = audit.getAgentActivity(task.to_agent, minutesThreshold)
    return activity.length === 0
  })
}

export function findUnclaimedTasks(taskDb: TaskDB, minutesThreshold: number): Task[] {
  const db = (taskDb as any).db
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND created_at < datetime('now', '-' || ? || ' minutes')
  `).all(minutesThreshold) as Task[]
}

export function determineAction(nudgeCount: number): 'first_nudge' | 'second_nudge' | 'escalate' {
  if (nudgeCount === 0) return 'first_nudge'
  if (nudgeCount === 1) return 'second_nudge'
  return 'escalate'
}

function incrementNudgeCount(taskDb: TaskDB, taskId: number): void {
  const db = (taskDb as any).db
  db.prepare('UPDATE tasks SET nudge_count = nudge_count + 1 WHERE id = ?').run(taskId)
}

async function checkDeadSessions(audit: AuditLog): Promise<void> {
  for (const [agent, session] of Object.entries(AGENT_SESSIONS)) {
    const proc = Bun.spawnSync(['tmux', 'has-session', '-t', session], { stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) {
      audit.log('watchdog', 'session_dead', { agent, session })
      await postToGroup(`⚠️ ${agent} session (${session}) is dead.`)
    }
  }
}

// Standalone execution
const isMainScript = process.argv[1]?.endsWith('watchdog.ts')
if (isMainScript) {
  const taskDb = new TaskDB(DB_PATH)
  const audit = new AuditLog(taskDb)

  console.log(`[${new Date().toISOString()}] Watchdog running...`)

  // 1. Check stale in-progress tasks
  const staleTasks = findStaleTasks(taskDb, 10, audit)
  for (const task of staleTasks) {
    const action = determineAction(task.nudge_count ?? 0)

    if (action === 'first_nudge') {
      const msg = `⏰ Task #${task.id} has been in progress for 10+ minutes with no activity. Status update? If blocked, use send_note to explain.`
      await nudgeAgent(task.to_agent, msg)
      incrementNudgeCount(taskDb, task.id)
      audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, nudge_count: 1, minutes_stuck: 10 }, task.id)
      console.log(`  Nudged ${task.to_agent} for task #${task.id} (first)`)

    } else if (action === 'second_nudge') {
      const msg = `⚠️ Task #${task.id} still stuck after 20+ minutes. Escalating to Boss in 10 minutes if no response.`
      await nudgeAgent(task.to_agent, msg)
      incrementNudgeCount(taskDb, task.id)
      audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, nudge_count: 2, minutes_stuck: 20 }, task.id)
      console.log(`  Nudged ${task.to_agent} for task #${task.id} (warning)`)

    } else {
      // Escalate to Boss
      const escalationDesc = `ESCALATION: Task #${task.id} assigned to ${task.to_agent} stuck for 30+ minutes. Original: ${task.description}`
      taskDb.createTask({ from: 'watchdog', to: 'boss', description: escalationDesc, priority: 'urgent' })
      // Cancel the stuck task
      const db = (taskDb as any).db
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(task.id)
      audit.log('watchdog', 'watchdog_escalation', { task_id: task.id, agent: task.to_agent, reason: '30+ minutes stuck' }, task.id)
      await nudgeAgent('boss', `🚨 Escalation: Task #${task.id} (${task.to_agent}) stuck 30+ min. New urgent task created for you.`)
      await postToGroup(`🚨 Escalation: Task #${task.id} (${task.to_agent}) auto-escalated to Boss after 30 minutes.`)
      console.log(`  Escalated task #${task.id} from ${task.to_agent} to Boss`)
    }
  }

  // 2. Check unclaimed pending tasks
  const unclaimed = findUnclaimedTasks(taskDb, 15)
  for (const task of unclaimed) {
    await nudgeAgent(task.to_agent, `📬 Reminder: Task #${task.id} is pending and assigned to you: ${task.description}`)
    audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, reason: 'unclaimed 15+ min' }, task.id)
    console.log(`  Reminded ${task.to_agent} about unclaimed task #${task.id}`)
  }

  // 3. Check for dead sessions
  await checkDeadSessions(audit)

  taskDb.close()
  console.log(`  Done. Stale: ${staleTasks.length}, Unclaimed: ${unclaimed.length}`)
}
```

- [ ] **Step 4: Run tests — all 6 must pass**

- [ ] **Step 5: Run full suite**

- [ ] **Step 6: Commit**

```bash
git add watchdog.ts tests/watchdog.test.ts
git commit -m "feat: watchdog script with stuck detection, escalation backoff, and dead session checks"
```

---

### Task 4: Watchdog LaunchAgent

**Files:**
- Create: `~/Library/LaunchAgents/com.threadwork.watchdog.plist`

- [ ] **Step 1: Create plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.threadwork.watchdog</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/coachstokes/.bun/bin/bun</string>
        <string>run</string>
        <string>/Users/coachstokes/.claude/mcp-servers/task-board/watchdog.ts</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>/Users/coachstokes/.claude/mcp-servers/task-board/watchdog.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/coachstokes/.claude/mcp-servers/task-board/watchdog.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/coachstokes</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Validate, load, verify**

```bash
plutil -lint ~/Library/LaunchAgents/com.threadwork.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.threadwork.watchdog.plist
launchctl list | grep watchdog
```

- [ ] **Step 3: Manual test run**

```bash
cd ~/.claude/mcp-servers/task-board && bun run watchdog.ts
```
Expected: `Watchdog running...` then `Done.` with counts

---

### Task 5: CLAUDE.md Universal Operating Manual

**Files:**
- Create: `~/.claude/CLAUDE.md`

- [ ] **Step 1: Write CLAUDE.md**

Use the exact content from section 3a of the design spec (the full markdown block starting with `# Threadwork Agent Operating Manual`). Write it to `~/.claude/CLAUDE.md`.

Note: if `~/.claude/CLAUDE.md` already exists, READ it first and APPEND the threadwork section rather than overwriting. Preserve any existing content.

- [ ] **Step 2: Verify Claude Code reads it**

The file is auto-loaded by Claude Code from the working directory's CLAUDE.md ancestry. Since agents run from `~` (home dir), `~/.claude/CLAUDE.md` is picked up.

---

### Task 6: Seed Role Memories + Boot Self-Check

**Files:**
- Create: `~/.claude/mcp-servers/task-board/seed-roles.ts`
- Modify: `~/.claude/launch-all.sh`

- [ ] **Step 1: Create seed-roles.ts**

```typescript
#!/usr/bin/env bun
// seed-roles.ts — One-time script to seed pinned role memories for all agents
import { TaskDB } from './db'
import { MemoryDB } from './memory'
import { DB_PATH } from './config'

const taskDb = new TaskDB(DB_PATH)
const mem = new MemoryDB(taskDb)

const ROLES: { agent: string; memories: string[] }[] = [
  {
    agent: 'boss',
    memories: [
      'You are Boss, the CEO and primary orchestrator of the threadwork agent team. You receive requests from the human (Stokes) and delegate work to Steve, Sadie, and Kiera. You make tiebreaker decisions when agents disagree or are blocked. You monitor team progress via list_tasks(filter="all") and query_audit_log. You keep your context clean by delegating all execution work — you plan, assign, and review.',
      'Team capabilities — Steve: general-purpose worker, full MCP access (Shopify, Gmail, Supabase, browser automation). Sadie: general-purpose worker, full MCP access. Kiera: general-purpose worker, full MCP access. All workers can spawn subagents for complex tasks. Roles will be specialized (CMO, CFO, CTO) in the future.',
    ],
  },
  {
    agent: 'steve',
    memories: [
      'You are Steve, a worker agent on the threadwork team. You report to Boss, who assigns your tasks. You execute work by claiming tasks from the task board, spawning subagents for complex work, and completing tasks with clear result summaries. Save important learnings to memory after completing tasks. If stuck, add a note to your task and escalate to Boss.',
      'Your teammates — Boss (CEO, orchestrator, delegates work), Sadie (general worker), Kiera (general worker). You can nudge teammates for data handoff or status checks. Only Boss creates top-level task assignments.',
    ],
  },
  {
    agent: 'sadie',
    memories: [
      'You are Sadie, a worker agent on the threadwork team. You report to Boss, who assigns your tasks. You execute work by claiming tasks from the task board, spawning subagents for complex work, and completing tasks with clear result summaries. Save important learnings to memory after completing tasks. If stuck, add a note to your task and escalate to Boss.',
      'Your teammates — Boss (CEO, orchestrator, delegates work), Steve (general worker), Kiera (general worker). You can nudge teammates for data handoff or status checks. Only Boss creates top-level task assignments.',
    ],
  },
  {
    agent: 'kiera',
    memories: [
      'You are Kiera, a worker agent on the threadwork team. You report to Boss, who assigns your tasks. You execute work by claiming tasks from the task board, spawning subagents for complex work, and completing tasks with clear result summaries. Save important learnings to memory after completing tasks. If stuck, add a note to your task and escalate to Boss.',
      'Your teammates — Boss (CEO, orchestrator, delegates work), Steve (general worker), Sadie (general worker). You can nudge teammates for data handoff or status checks. Only Boss creates top-level task assignments.',
    ],
  },
]

let seeded = 0
for (const role of ROLES) {
  for (const content of role.memories) {
    // Check if already seeded (avoid duplicates on re-run)
    const existing = mem.recallMemories(role.agent, { query: content.slice(0, 50), category: 'role', limit: 1 })
    // recallMemories updates tracking, so we don't use it for existence checks in production
    // But for a one-time seed script this is acceptable
    const db = (taskDb as any).db
    const exists = db.prepare(
      "SELECT id FROM memories WHERE agent = ? AND category = 'role' AND content = ?"
    ).get(role.agent, content)

    if (!exists) {
      mem.saveMemory({
        agent: role.agent,
        content,
        category: 'role',
        importance: 5,
        pinned: true,
      })
      seeded++
      console.log(`  Seeded role memory for ${role.agent}`)
    } else {
      console.log(`  Skipped (exists) role memory for ${role.agent}`)
    }
  }
}

taskDb.close()
console.log(`Done. Seeded ${seeded} new role memories.`)
```

- [ ] **Step 2: Run seed script**

```bash
cd ~/.claude/mcp-servers/task-board && bun run seed-roles.ts
```
Expected: Seeded 8 role memories (2 per agent x 4 agents)

- [ ] **Step 3: Update boot self-check in launch-all.sh**

Replace the boot briefing nudge line:
```bash
    tmux send-keys -t "$session" "Call get_boot_briefing to load your memory and context." Enter 2>/dev/null
```

With:
```bash
    tmux send-keys -t "$session" "Call get_boot_briefing to load your memory and context. Then call list_tasks with filter='mine' to check for pending work. State your name, role, and current task status." Enter 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add seed-roles.ts
git commit -m "feat: role memory seeder and boot self-check update"
```

---

### Task 7: Live Deployment and Verification

- [ ] **Step 1: Run full test suite**

Run: `cd ~/.claude/mcp-servers/task-board && bun test`
Expected: All tests pass (previous 29 + audit 6 + watchdog 6 = ~41)

- [ ] **Step 2: Verify MCP lists 12 tools**

- [ ] **Step 3: Run seed-roles.ts**

- [ ] **Step 4: Run watchdog.ts manually**

- [ ] **Step 5: Kill and relaunch tmux sessions with updated config**

- [ ] **Step 6: Verify boot self-check — agents state their name and role**

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: observability, watchdog, and onboarding v1.0 — all spec gates verified"
```
