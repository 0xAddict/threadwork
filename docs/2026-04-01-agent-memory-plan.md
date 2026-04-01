# Agent Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-agent persistent memory with importance scoring, decay, auto-extraction on task completion, and nightly consolidation to the existing task-board MCP.

**Architecture:** Extend the existing task-board MCP server. New `memory.ts` module handles CRUD/search/decay. New tables in the same SQLite DB. New tools registered in `server.ts`. Standalone `consolidate.ts` script for nightly cron. Boot briefing nudge added to `launch-all.sh`.

**Tech Stack:** Bun, TypeScript, bun:sqlite (existing DB), LaunchAgent (cron)

---

## File Structure

```
~/.claude/mcp-servers/task-board/
  memory.ts              — NEW: MemoryDB class (CRUD, search, access tracking, decay)
  consolidate.ts         — NEW: standalone nightly script (decay, archive, prune, briefings)
  briefings/             — NEW: generated boot briefing JSONs per agent
  server.ts              — MODIFY: add 5 memory tools, auto-extract in complete_task, update instructions
  db.ts                  — MODIFY: add memories + memory_archive tables to migration
  tests/
    memory.test.ts       — NEW: memory CRUD, access tracking, decay tests
    consolidate.test.ts  — NEW: consolidation logic tests

~/Library/LaunchAgents/
  com.coachstokes.claude-consolidate.plist — NEW: nightly cron

~/.claude/
  launch-all.sh          — MODIFY: add boot briefing nudge after trust prompt
```

## Spec Gate

- [ ] **SG-1:** `save_memory` creates a memory with agent, content, category, importance, pinned, timestamps
- [ ] **SG-2:** `recall_memories` searches own + shared memories with LIKE query, updates access tracking (+1 importance capped at 5, +1 access_count, updates last_accessed)
- [ ] **SG-3:** `promote_memory` changes agent field to "shared"
- [ ] **SG-4:** `pin_memory` toggles pinned status
- [ ] **SG-5:** `get_boot_briefing` returns tiered summary (role + top 5 + shared + last 5 tasks) WITHOUT updating access tracking
- [ ] **SG-6:** `complete_task` auto-extracts a task_summary memory with priority-mapped importance
- [ ] **SG-7:** Consolidation: decay reduces importance by 1 per 7-day unaccessed period for non-pinned memories
- [ ] **SG-8:** Consolidation: memories at importance 0 move to memory_archive
- [ ] **SG-9:** Consolidation: archived memories older than 90 days are pruned
- [ ] **SG-10:** Consolidation: generates briefing JSON files per agent
- [ ] **SG-11:** LaunchAgent runs consolidation at 3am daily
- [ ] **SG-12:** Boot briefing nudge fires after trust prompt in launch-all.sh
- [ ] **SG-13:** All tests pass: `bun test`
- [ ] **SG-14:** Live test: agent saves memory, recalls it, importance increases, boot briefing includes it

---

### Task 1: Add Memory Tables to Migration

**Files:**
- Modify: `~/.claude/mcp-servers/task-board/db.ts:51-73`

- [ ] **Step 1: Add memories and memory_archive tables to the migrate() method**

In `db.ts`, add the following SQL to the end of the `this.db.exec()` call inside `migrate()`, after the `notes` CREATE TABLE:

```typescript
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        pinned INTEGER NOT NULL DEFAULT 0,
        source_task_id INTEGER REFERENCES tasks(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_archive (
        id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        importance INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        source_task_id INTEGER REFERENCES tasks(id),
        created_at TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
      CREATE INDEX IF NOT EXISTS idx_memories_agent_importance ON memories(agent, importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON memory_archive(archived_at);
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd ~/.claude/mcp-servers/task-board && bun test`
Expected: 14 pass, 0 fail

- [ ] **Step 3: Verify tables are created**

Run: `bun -e "import { TaskDB } from './db'; const d = new TaskDB('/tmp/migration-test.db'); const tables = d['db'].prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all(); console.log(tables.map(t=>t.name).sort()); d.close()" && rm -f /tmp/migration-test.db*`
Expected: Output includes `memories` and `memory_archive`

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add db.ts
git commit -m "feat: add memories and memory_archive tables to migration"
```

---

### Task 2: Memory Module — CRUD and Search

**Files:**
- Create: `~/.claude/mcp-servers/task-board/memory.ts`
- Create: `~/.claude/mcp-servers/task-board/tests/memory.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/memory.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { MemoryDB } from '../memory'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/memory-test.db'

describe('MemoryDB', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  test('saveMemory creates a memory with correct fields', () => {
    const m = mem.saveMemory({
      agent: 'steve',
      content: 'Shopify API returns UTC timestamps',
      category: 'learning',
      importance: 4,
      pinned: false,
    })
    expect(m.id).toBeGreaterThan(0)
    expect(m.agent).toBe('steve')
    expect(m.content).toBe('Shopify API returns UTC timestamps')
    expect(m.category).toBe('learning')
    expect(m.importance).toBe(4)
    expect(m.pinned).toBe(0)
    expect(m.access_count).toBe(0)
  })

  test('saveMemory defaults importance to 3', () => {
    const m = mem.saveMemory({
      agent: 'steve',
      content: 'test',
      category: 'fact',
    })
    expect(m.importance).toBe(3)
  })

  test('recallMemories returns own + shared memories', () => {
    mem.saveMemory({ agent: 'steve', content: 'Steve specific', category: 'learning' })
    mem.saveMemory({ agent: 'shared', content: 'Shared knowledge', category: 'fact' })
    mem.saveMemory({ agent: 'sadie', content: 'Sadie specific', category: 'learning' })

    const results = mem.recallMemories('steve', {})
    expect(results).toHaveLength(2)
    const agents = results.map(r => r.agent).sort()
    expect(agents).toEqual(['shared', 'steve'])
  })

  test('recallMemories filters by query', () => {
    mem.saveMemory({ agent: 'steve', content: 'Shopify API returns UTC', category: 'learning' })
    mem.saveMemory({ agent: 'steve', content: 'Facebook ads convert better with urgency', category: 'learning' })

    const results = mem.recallMemories('steve', { query: 'Shopify' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('Shopify')
  })

  test('recallMemories filters by category', () => {
    mem.saveMemory({ agent: 'steve', content: 'A learning', category: 'learning' })
    mem.saveMemory({ agent: 'steve', content: 'A preference', category: 'preference' })

    const results = mem.recallMemories('steve', { category: 'learning' })
    expect(results).toHaveLength(1)
    expect(results[0].category).toBe('learning')
  })

  test('recallMemories updates access tracking', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'test', category: 'fact', importance: 3 })
    mem.recallMemories('steve', {})

    const updated = mem.getMemory(m.id)
    expect(updated!.access_count).toBe(1)
    expect(updated!.importance).toBe(4) // 3 + 1
  })

  test('recallMemories caps importance at 5', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'test', category: 'fact', importance: 5 })
    mem.recallMemories('steve', {})

    const updated = mem.getMemory(m.id)
    expect(updated!.importance).toBe(5) // stays at 5
    expect(updated!.access_count).toBe(1)
  })

  test('promoteMemory changes agent to shared', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'promote me', category: 'learning' })
    const promoted = mem.promoteMemory(m.id)
    expect(promoted!.agent).toBe('shared')
  })

  test('pinMemory toggles pin status', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'pin me', category: 'role' })
    expect(m.pinned).toBe(0)

    const pinned = mem.pinMemory(m.id)
    expect(pinned!.pinned).toBe(1)

    const unpinned = mem.pinMemory(m.id)
    expect(unpinned!.pinned).toBe(0)
  })

  test('getBootBriefing returns tiered summary without updating access', () => {
    // Role memory (pinned)
    mem.saveMemory({ agent: 'steve', content: 'You are the CTO', category: 'role', importance: 5, pinned: true })
    // High importance
    mem.saveMemory({ agent: 'steve', content: 'Important learning', category: 'learning', importance: 5 })
    // Shared
    mem.saveMemory({ agent: 'shared', content: 'Team uses Bun runtime', category: 'fact', importance: 4 })
    // Low importance (should not appear in top 5)
    mem.saveMemory({ agent: 'steve', content: 'Low value', category: 'fact', importance: 1 })

    const briefing = mem.getBootBriefing('steve', taskDb)
    expect(briefing.role).toHaveLength(1)
    expect(briefing.role[0].content).toBe('You are the CTO')
    expect(briefing.topMemories.length).toBeGreaterThanOrEqual(1)
    expect(briefing.sharedMemories).toHaveLength(1)

    // Verify access tracking was NOT updated
    const role = mem.getMemory(briefing.role[0].id)
    expect(role!.access_count).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: FAIL — `Cannot find module '../memory'`

- [ ] **Step 3: Implement memory.ts**

```typescript
// memory.ts
import type { Database } from 'bun:sqlite'
import type { TaskDB, Task } from './db'

export interface Memory {
  id: number
  agent: string
  content: string
  category: string
  importance: number
  pinned: number
  source_task_id: number | null
  created_at: string
  last_accessed: string
  access_count: number
}

export interface SaveMemoryInput {
  agent: string
  content: string
  category: string
  importance?: number
  pinned?: boolean
  source_task_id?: number
}

export interface RecallFilter {
  query?: string
  category?: string
  limit?: number
}

export interface BootBriefing {
  role: Memory[]
  topMemories: Memory[]
  sharedMemories: Memory[]
  recentTasks: Task[]
}

export class MemoryDB {
  private db: Database

  constructor(taskDb: TaskDB) {
    // Access the underlying Database instance from TaskDB
    this.db = (taskDb as any).db
  }

  saveMemory(input: SaveMemoryInput): Memory {
    const stmt = this.db.prepare(`
      INSERT INTO memories (agent, content, category, importance, pinned, source_task_id)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `)
    return stmt.get(
      input.agent,
      input.content,
      input.category,
      input.importance ?? 3,
      input.pinned ? 1 : 0,
      input.source_task_id ?? null,
    ) as Memory
  }

  getMemory(id: number): Memory | null {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null
  }

  recallMemories(agent: string, filter: RecallFilter): Memory[] {
    const conditions = ['(agent = ? OR agent = ?)']
    const params: unknown[] = [agent, 'shared']

    if (filter.query) {
      conditions.push('content LIKE ?')
      params.push(`%${filter.query}%`)
    }
    if (filter.category) {
      conditions.push('category = ?')
      params.push(filter.category)
    }

    const limit = filter.limit ?? 10
    const sql = `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY importance DESC, last_accessed DESC LIMIT ?`
    params.push(limit)

    const results = this.db.prepare(sql).all(...params) as Memory[]

    // Update access tracking for returned memories
    if (results.length > 0) {
      const ids = results.map(r => r.id)
      this.db.prepare(`
        UPDATE memories
        SET last_accessed = datetime('now'),
            access_count = access_count + 1,
            importance = MIN(importance + 1, 5)
        WHERE id IN (${ids.map(() => '?').join(',')})
      `).run(...ids)
    }

    return results
  }

  promoteMemory(id: number): Memory | null {
    return this.db.prepare(`
      UPDATE memories SET agent = 'shared' WHERE id = ? RETURNING *
    `).get(id) as Memory | null
  }

  pinMemory(id: number): Memory | null {
    return this.db.prepare(`
      UPDATE memories SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ? RETURNING *
    `).get(id) as Memory | null
  }

  getBootBriefing(agent: string, taskDb: TaskDB): BootBriefing {
    // Role memories (pinned, category=role)
    const role = this.db.prepare(
      `SELECT * FROM memories WHERE agent = ? AND category = 'role' AND pinned = 1 ORDER BY importance DESC`
    ).all(agent) as Memory[]

    // Top 5 non-role memories by importance
    const topMemories = this.db.prepare(
      `SELECT * FROM memories WHERE agent = ? AND category != 'role' ORDER BY importance DESC LIMIT 5`
    ).all(agent) as Memory[]

    // Top 5 shared memories
    const sharedMemories = this.db.prepare(
      `SELECT * FROM memories WHERE agent = 'shared' ORDER BY importance DESC LIMIT 5`
    ).all() as Memory[]

    // Last 5 completed tasks for this agent
    const recentTasks = this.db.prepare(
      `SELECT * FROM tasks WHERE to_agent = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 5`
    ).all(agent) as Task[]

    // NO access tracking updates — this is read-only
    return { role, topMemories, sharedMemories, recentTasks }
  }

  // Used by consolidation script
  getDecayCandidate(): Memory[] {
    return this.db.prepare(`
      SELECT * FROM memories
      WHERE pinned = 0
        AND last_accessed < datetime('now', '-7 days')
        AND importance > 0
    `).all() as Memory[]
  }

  decayMemory(id: number, newImportance: number): void {
    this.db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(newImportance, id)
  }

  archiveMemory(id: number): void {
    this.db.prepare(`
      INSERT INTO memory_archive (id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count)
      SELECT id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count FROM memories WHERE id = ?
    `).run(id)
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  pruneArchive(daysOld: number): number {
    const result = this.db.prepare(`
      DELETE FROM memory_archive WHERE archived_at < datetime('now', '-' || ? || ' days')
    `).run(daysOld)
    return result.changes
  }

  listAgents(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT agent FROM memories WHERE agent != 'shared' ORDER BY agent`
    ).all() as { agent: string }[]
    return rows.map(r => r.agent)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: All tests pass (previous 14 + new 11 = 25)

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add memory.ts tests/memory.test.ts
git commit -m "feat: memory module with CRUD, search, access tracking, and boot briefing"
```

---

### Task 3: Add Memory Tools to MCP Server

**Files:**
- Modify: `~/.claude/mcp-servers/task-board/server.ts`

- [ ] **Step 1: Add imports and MemoryDB initialization**

At the top of `server.ts`, after the existing imports (line 17), add:

```typescript
import { MemoryDB } from './memory'
```

After `const db = new TaskDB(DB_PATH)` (line 19), add:

```typescript
const mem = new MemoryDB(db)
```

- [ ] **Step 2: Update MCP server instructions**

Replace the instructions array (lines 25-34) with:

```typescript
    instructions: [
      `You are agent "${SELF_LABEL}". You have a shared task board and personal memory with other agents (boss, steve, sadie, kiera).`,
      'TASK TOOLS: create_task, claim_task, complete_task, list_tasks, send_note, nudge_agent',
      'MEMORY TOOLS: save_memory (store learnings), recall_memories (search your knowledge), get_boot_briefing (load context on startup)',
      'MEMORY MANAGEMENT: promote_memory (share with all agents), pin_memory (prevent decay)',
      'On startup, call get_boot_briefing to load your role, top memories, and recent task history.',
      'After completing tasks, save important learnings with save_memory.',
      'Always delegate complex work to subagents (Agent tool) to keep your context clean.',
    ].join('\n'),
```

- [ ] **Step 3: Add 5 new tool definitions to ListToolsRequestSchema handler**

After the `nudge_agent` tool definition (before the closing `]` of the tools array, line 115), add:

```typescript
    {
      name: 'save_memory',
      description: 'Save a memory/learning for yourself. Persists across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content' },
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'role'], description: 'Memory category' },
          importance: { type: 'number', description: 'Importance 1-5 (default: 3). Higher = persists longer.' },
          pinned: { type: 'boolean', description: 'Pin to prevent decay (default: false). Use for role definitions.' },
        },
        required: ['content', 'category'],
      },
    },
    {
      name: 'recall_memories',
      description: 'Search your memories and shared team knowledge. Updates access tracking (boosts importance of accessed memories).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term (matches content)' },
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'task_summary', 'role'], description: 'Filter by category' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
      },
    },
    {
      name: 'get_boot_briefing',
      description: 'Load your boot briefing: role, top memories, shared knowledge, and recent tasks. Call this on startup.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'promote_memory',
      description: 'Promote a personal memory to shared — all agents will see it.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to promote' },
        },
        required: ['memory_id'],
      },
    },
    {
      name: 'pin_memory',
      description: 'Toggle pin on a memory. Pinned memories never decay.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to pin/unpin' },
        },
        required: ['memory_id'],
      },
    },
```

- [ ] **Step 4: Add tool handlers in CallToolRequestSchema**

Before the `default:` case (line 215), add these cases:

```typescript
      case 'save_memory': {
        const content = args.content as string
        const category = args.category as string
        const importance = (args.importance as number) ?? 3
        const pinned = (args.pinned as boolean) ?? false

        const memory = mem.saveMemory({
          agent: SELF_LABEL,
          content,
          category,
          importance,
          pinned,
        })

        return { content: [{ type: 'text', text: `Memory #${memory.id} saved (importance: ${memory.importance}${memory.pinned ? ', pinned' : ''})` }] }
      }

      case 'recall_memories': {
        const query = args.query as string | undefined
        const category = args.category as string | undefined
        const limit = args.limit as number | undefined

        const memories = mem.recallMemories(SELF_LABEL, { query, category, limit })

        if (memories.length === 0) {
          return { content: [{ type: 'text', text: 'No memories found.' }] }
        }

        const lines = memories.map(
          (m) => `#${m.id} [${m.category}] imp:${m.importance} ${m.pinned ? '📌' : ''} ${m.content}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'get_boot_briefing': {
        const briefing = mem.getBootBriefing(SELF_LABEL, db)
        const sections: string[] = []

        if (briefing.role.length > 0) {
          sections.push('== ROLE ==\n' + briefing.role.map(m => m.content).join('\n'))
        }
        if (briefing.topMemories.length > 0) {
          sections.push('== TOP MEMORIES ==\n' + briefing.topMemories.map(m => `[${m.category}] ${m.content}`).join('\n'))
        }
        if (briefing.sharedMemories.length > 0) {
          sections.push('== SHARED KNOWLEDGE ==\n' + briefing.sharedMemories.map(m => `[${m.category}] ${m.content}`).join('\n'))
        }
        if (briefing.recentTasks.length > 0) {
          sections.push('== RECENT TASKS ==\n' + briefing.recentTasks.map(t => `#${t.id} ${t.description} → ${t.result}`).join('\n'))
        }

        if (sections.length === 0) {
          return { content: [{ type: 'text', text: 'No memories or history yet. You are a fresh agent.' }] }
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }] }
      }

      case 'promote_memory': {
        const memoryId = args.memory_id as number
        const promoted = mem.promoteMemory(memoryId)

        if (!promoted) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        return { content: [{ type: 'text', text: `Memory #${memoryId} promoted to shared. All agents can now see it.` }] }
      }

      case 'pin_memory': {
        const memoryId = args.memory_id as number
        const toggled = mem.pinMemory(memoryId)

        if (!toggled) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        const state = toggled.pinned ? 'pinned (will not decay)' : 'unpinned (will decay normally)'
        return { content: [{ type: 'text', text: `Memory #${memoryId} ${state}.` }] }
      }
```

- [ ] **Step 5: Add auto-extraction in complete_task handler**

In the `complete_task` case, after `await postToGroup(formatTaskCompleted(task))` (around line 161) and before the return statement, add:

```typescript
        // Auto-extract task summary as memory
        const priorityToImportance: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 }
        mem.saveMemory({
          agent: SELF_LABEL,
          content: `Task #${task.id}: ${task.description} → Result: ${result}`,
          category: 'task_summary',
          importance: priorityToImportance[task.priority] ?? 2,
          source_task_id: task.id,
        })
```

- [ ] **Step 6: Verify all tests pass**

Run: `cd ~/.claude/mcp-servers/task-board && bun test`
Expected: All tests pass (25+)

- [ ] **Step 7: Verify MCP lists all 11 tools**

Run: `printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | AGENT_LABEL=boss /Users/coachstokes/.bun/bin/bun server.ts 2>/dev/null | tail -1 | python3 -c "import json,sys; d=json.load(sys.stdin); tools=[t['name'] for t in d['result']['tools']]; print(f'{len(tools)} tools:', ', '.join(sorted(tools)))"`
Expected: `11 tools: claim_task, complete_task, create_task, get_boot_briefing, list_tasks, nudge_agent, pin_memory, promote_memory, recall_memories, save_memory, send_note`

- [ ] **Step 8: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add server.ts
git commit -m "feat: add 5 memory tools and auto-extraction to MCP server"
```

---

### Task 4: Consolidation Script

**Files:**
- Create: `~/.claude/mcp-servers/task-board/consolidate.ts`
- Create: `~/.claude/mcp-servers/task-board/tests/consolidate.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/consolidate.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { runDecay, runArchive, runPrune, generateBriefing } from '../consolidate'
import { unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs'

const TEST_DB = '/tmp/consolidate-test.db'
const TEST_BRIEFING_DIR = '/tmp/consolidate-briefings'

describe('consolidation', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
    // Clean briefing dir
    try { Bun.spawnSync(['rm', '-rf', TEST_BRIEFING_DIR]) } catch {}
    mkdirSync(TEST_BRIEFING_DIR, { recursive: true })
  })

  test('runDecay reduces importance for old unaccessed memories', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'old memory', category: 'fact', importance: 3 })
    // Manually backdate last_accessed by 14 days
    const db = (taskDb as any).db
    db.prepare("UPDATE memories SET last_accessed = datetime('now', '-14 days') WHERE id = ?").run(m.id)

    const decayed = runDecay(mem)
    expect(decayed).toBe(1)

    const updated = mem.getMemory(m.id)
    expect(updated!.importance).toBe(1) // 3 - 2 (14 days = 2 decay periods)
  })

  test('runDecay does not touch pinned memories', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'pinned', category: 'role', importance: 3, pinned: true })
    const db = (taskDb as any).db
    db.prepare("UPDATE memories SET last_accessed = datetime('now', '-30 days') WHERE id = ?").run(m.id)

    const decayed = runDecay(mem)
    expect(decayed).toBe(0)

    const updated = mem.getMemory(m.id)
    expect(updated!.importance).toBe(3) // unchanged
  })

  test('runArchive moves importance-0 memories to archive', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'dead memory', category: 'fact', importance: 0 })

    const archived = runArchive(mem)
    expect(archived).toBe(1)

    const gone = mem.getMemory(m.id)
    expect(gone).toBeNull()
  })

  test('runPrune deletes old archived memories', () => {
    // Insert directly into archive with old date
    const db = (taskDb as any).db
    db.prepare(`
      INSERT INTO memory_archive (agent, content, category, importance, pinned, created_at, last_accessed, access_count, archived_at)
      VALUES ('steve', 'ancient', 'fact', 0, 0, datetime('now', '-120 days'), datetime('now', '-120 days'), 0, datetime('now', '-91 days'))
    `).run()

    const pruned = runPrune(mem, 90)
    expect(pruned).toBe(1)
  })

  test('generateBriefing writes JSON file for agent', () => {
    mem.saveMemory({ agent: 'steve', content: 'CTO role', category: 'role', importance: 5, pinned: true })
    mem.saveMemory({ agent: 'steve', content: 'Key learning', category: 'learning', importance: 4 })

    generateBriefing('steve', mem, taskDb, TEST_BRIEFING_DIR)

    const filePath = `${TEST_BRIEFING_DIR}/steve.json`
    expect(existsSync(filePath)).toBe(true)

    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(data.role).toHaveLength(1)
    expect(data.topMemories.length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/consolidate.test.ts`
Expected: FAIL — `Cannot find module '../consolidate'`

- [ ] **Step 3: Implement consolidate.ts**

```typescript
#!/usr/bin/env bun
// consolidate.ts — Nightly memory consolidation script
// Run standalone: bun consolidate.ts
// Or import functions for testing

import { TaskDB } from './db'
import { MemoryDB } from './memory'
import { DB_PATH } from './config'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const BRIEFING_DIR = join(
  process.env.HOME ?? '/tmp',
  '.claude',
  'mcp-servers',
  'task-board',
  'briefings',
)

export function runDecay(mem: MemoryDB): number {
  const candidates = mem.getDecayCandidate()
  let count = 0

  for (const m of candidates) {
    const lastAccessed = new Date(m.last_accessed + 'Z')
    const now = new Date()
    const daysSinceAccess = Math.floor((now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24))
    const decayPeriods = Math.floor(daysSinceAccess / 7)
    const newImportance = Math.max(m.importance - decayPeriods, 0)

    if (newImportance !== m.importance) {
      mem.decayMemory(m.id, newImportance)
      count++
    }
  }

  return count
}

export function runArchive(mem: MemoryDB): number {
  const db = (mem as any).db
  const candidates = db.prepare('SELECT id FROM memories WHERE importance <= 0 AND pinned = 0').all() as { id: number }[]

  for (const c of candidates) {
    mem.archiveMemory(c.id)
  }

  return candidates.length
}

export function runPrune(mem: MemoryDB, daysOld: number = 90): number {
  return mem.pruneArchive(daysOld)
}

export function generateBriefing(
  agent: string,
  mem: MemoryDB,
  taskDb: TaskDB,
  briefingDir: string = BRIEFING_DIR,
): void {
  const briefing = mem.getBootBriefing(agent, taskDb)
  mkdirSync(briefingDir, { recursive: true })
  writeFileSync(join(briefingDir, `${agent}.json`), JSON.stringify(briefing, null, 2))
}

// Run as standalone script when executed directly
const isMainScript = process.argv[1]?.endsWith('consolidate.ts')
if (isMainScript) {
  console.log('Starting nightly consolidation...')

  const taskDb = new TaskDB(DB_PATH)
  const mem = new MemoryDB(taskDb)

  const decayed = runDecay(mem)
  console.log(`Decayed: ${decayed} memories`)

  const archived = runArchive(mem)
  console.log(`Archived: ${archived} memories`)

  const pruned = runPrune(mem)
  console.log(`Pruned: ${pruned} archived memories`)

  const agents = mem.listAgents()
  for (const agent of agents) {
    generateBriefing(agent, mem, taskDb)
    console.log(`Generated briefing for ${agent}`)
  }

  taskDb.close()
  console.log('Consolidation complete.')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.claude/mcp-servers/task-board && bun test tests/consolidate.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: All tests pass (30+)

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add consolidate.ts tests/consolidate.test.ts
git commit -m "feat: nightly consolidation script with decay, archive, prune, and briefing generation"
```

---

### Task 5: LaunchAgent for Nightly Consolidation

**Files:**
- Create: `~/Library/LaunchAgents/com.coachstokes.claude-consolidate.plist`

- [ ] **Step 1: Create the LaunchAgent plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.coachstokes.claude-consolidate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/coachstokes/.bun/bin/bun</string>
        <string>run</string>
        <string>/Users/coachstokes/.claude/mcp-servers/task-board/consolidate.ts</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/coachstokes/.claude/mcp-servers/task-board/consolidate.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/coachstokes/.claude/mcp-servers/task-board/consolidate.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/coachstokes</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Validate and load the plist**

Run: `plutil -lint ~/Library/LaunchAgents/com.coachstokes.claude-consolidate.plist`
Expected: OK

Run: `launchctl load ~/Library/LaunchAgents/com.coachstokes.claude-consolidate.plist`
Expected: no error

- [ ] **Step 3: Verify it's registered**

Run: `launchctl list | grep claude-consolidate`
Expected: Shows the job

- [ ] **Step 4: Test manual run**

Run: `bun run /Users/coachstokes/.claude/mcp-servers/task-board/consolidate.ts`
Expected: `Starting nightly consolidation...` followed by counts and `Consolidation complete.`

---

### Task 6: Boot Briefing Nudge in launch-all.sh

**Files:**
- Modify: `~/.claude/launch-all.sh:40-41`

- [ ] **Step 1: Update the launch loop to add boot briefing nudge**

Replace the trust prompt auto-accept block (lines 40-41):

```bash
  # Auto-accept the workspace trust prompt after delay
  (sleep $TRUST_DELAY && tmux send-keys -t "$session" Enter 2>/dev/null) &
```

With:

```bash
  # Auto-accept the workspace trust prompt, then load boot briefing
  (
    sleep $TRUST_DELAY
    tmux send-keys -t "$session" Enter 2>/dev/null
    sleep 12
    tmux send-keys -t "$session" "Call get_boot_briefing to load your memory and context." Enter 2>/dev/null
  ) &
```

- [ ] **Step 2: Verify the script is syntactically valid**

Run: `zsh -n ~/.claude/launch-all.sh`
Expected: No output (no syntax errors)

---

### Task 7: Live Deployment and Verification

- [ ] **Step 1: Run full test suite**

Run: `cd ~/.claude/mcp-servers/task-board && bun test`
Expected: All tests pass (30+)

- [ ] **Step 2: Kill tmux sessions and relaunch with updated pool script**

```bash
tmux kill-server 2>/dev/null
rm -f ~/.claude/channels/telegram/locks/*.lock
LOCK_ID=$(echo -n "8792104238:AAEClHlQuwE6yHmE7FJ1haAuFAwheXL8M24" | shasum -a 256 | cut -c1-12)
echo "EXTERNAL" > ~/.claude/channels/telegram/locks/${LOCK_ID}.lock
```

Launch one test agent:
```bash
tmux new-session -d -s claude-steve
tmux send-keys -t claude-steve 'source ~/.claude/telegram-pool.sh' Enter
sleep 6 && tmux send-keys -t claude-steve Enter
```

- [ ] **Step 3: Verify MCP loaded with memory tools**

Check: `tmux capture-pane -t claude-steve -p | grep task-board`
Expected: task-board MCP visible in session

- [ ] **Step 4: Test save_memory and recall_memories via Steve**

Send to Steve's tmux:
```
Save a memory with save_memory: content="Shopify API returns UTC timestamps, always convert to PDT for daily reports", category="learning", importance=4
```

Wait for response, then:
```
Recall memories with recall_memories, query="Shopify"
```

Verify: Memory is returned with importance 5 (4 + 1 from access)

- [ ] **Step 5: Test get_boot_briefing**

Send to Steve: `Call get_boot_briefing`

Verify: Returns the saved memory in top memories section

- [ ] **Step 6: Test auto-extraction on task completion**

Create and complete a task through Steve to verify the task_summary memory is auto-created.

- [ ] **Step 7: Run consolidation manually**

Run: `bun run consolidate.ts`
Verify: Briefing JSON created at `briefings/steve.json`

- [ ] **Step 8: Final commit**

```bash
cd ~/.claude/mcp-servers/task-board
git add -A
git commit -m "feat: agent memory system v1.0 — deployed and verified"
```

---

## Spec Gate Verification Checklist

- [ ] **SG-1:** save_memory creates with correct fields
- [ ] **SG-2:** recall_memories searches own + shared, updates tracking
- [ ] **SG-3:** promote_memory changes to shared
- [ ] **SG-4:** pin_memory toggles pin
- [ ] **SG-5:** get_boot_briefing returns tiered summary, no tracking update
- [ ] **SG-6:** complete_task auto-extracts task_summary memory
- [ ] **SG-7:** Decay reduces importance per 7-day period
- [ ] **SG-8:** Importance 0 → archived
- [ ] **SG-9:** Archive > 90 days → pruned
- [ ] **SG-10:** Generates briefing JSONs per agent
- [ ] **SG-11:** LaunchAgent registered for 3am
- [ ] **SG-12:** Boot briefing nudge in launch-all.sh
- [ ] **SG-13:** All tests pass
- [ ] **SG-14:** Live end-to-end: save → recall → importance boost → boot briefing includes it
