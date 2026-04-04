# AutoDream Memory Consolidation Daemon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 5-phase memory consolidation daemon to the threadwork task board that classifies, challenges, supersedes, deduplicates, and prunes agent memories automatically.

**Architecture:** Schema migration adds DTC columns (classification, quality, state, support/challenge counts) to existing memories table. New MemoryDB methods expose challenge/supersede/dedup primitives. A MemoryConsolidator class runs 5 phases (Orient, Gather, Validate, Consolidate, Prune) on trigger gates (time/volume/idle/lock). Daemon runs in Snoopy's session with dry-run mode for first 2 weeks.

**Tech Stack:** TypeScript, Bun, SQLite (bun:sqlite), MCP SDK (@modelcontextprotocol/sdk)

**Spec:** `docs/superpowers/specs/2026-04-05-autodream-daemon-design.md`

**Codebase root:** `/Users/coachstokes/.claude/mcp-servers/task-board`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `db.ts` | Schema migration — add DTC columns, consolidation tables, indexes |
| Modify | `memory.ts` | Memory primitives — challenge, supersede, dedup, classification inference |
| Modify | `consolidate.ts` | Classification-aware decay replacing simple 7-day decay |
| Create | `consolidator.ts` | 5-phase consolidation daemon (Orient/Gather/Validate/Consolidate/Prune) |
| Modify | `server.ts` | 4 new MCP tools (consolidate_memories, get_memory_health_report, challenge_memory, supersede_memory) |
| Modify | `snoopy-bot.ts` | setInterval trigger gate checker |
| Modify | `config.ts` | CONSOLIDATION_DRY_RUN constant |
| Modify | `tests/memory.test.ts` | Tests for challenge, supersede, dedup, classification |
| Modify | `tests/consolidate.test.ts` | Tests for classification-aware decay |
| Create | `tests/consolidator.test.ts` | Tests for 5-phase cycle, triggers, locks, health report |

---

## Task 1: Schema Migration

**Files:**
- Modify: `/Users/coachstokes/.claude/mcp-servers/task-board/db.ts:82-173`
- Modify: `/Users/coachstokes/.claude/mcp-servers/task-board/memory.ts:1-14`
- Test: `/Users/coachstokes/.claude/mcp-servers/task-board/tests/memory.test.ts`

- [ ] **Step 1: Write failing test for new columns**

Add to `tests/memory.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/test-autodream-schema.db'

describe('schema migration — DTC columns', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('memories table has DTC columns with defaults', () => {
    const m = mem.saveMemory({ agent: 'boss', content: 'test', category: 'fact' })
    expect(m.classification).toBe('operational')
    expect(m.quality).toBe(0.5)
    expect(m.state).toBe('active')
    expect(m.source_type).toBe('agent')
    expect(m.support_count).toBe(0)
    expect(m.challenge_count).toBe(0)
    expect(m.supersedes_memory_id).toBeNull()
    expect(m.last_validated).toBeTruthy()
  })

  test('consolidation_locks table exists', () => {
    const result = taskDb.run(db =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consolidation_locks'").get()
    )
    expect(result).toBeTruthy()
  })

  test('consolidation_runs table exists', () => {
    const result = taskDb.run(db =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consolidation_runs'").get()
    )
    expect(result).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: FAIL — Memory interface missing new fields, columns don't exist yet.

- [ ] **Step 3: Add DTC columns to migrate() in db.ts**

In `db.ts`, after the existing `try { ALTER TABLE tasks ADD COLUMN nudge_count ... }` block (around line 154), add:

```typescript
    // DTC memory columns (safe migration for existing DBs)
    const dtcColumns = [
      "ALTER TABLE memories ADD COLUMN classification TEXT DEFAULT 'operational'",
      "ALTER TABLE memories ADD COLUMN quality REAL DEFAULT 0.5",
      "ALTER TABLE memories ADD COLUMN state TEXT DEFAULT 'active'",
      "ALTER TABLE memories ADD COLUMN source_type TEXT DEFAULT 'agent'",
      "ALTER TABLE memories ADD COLUMN evidence TEXT",
      "ALTER TABLE memories ADD COLUMN support_count INTEGER DEFAULT 0",
      "ALTER TABLE memories ADD COLUMN challenge_count INTEGER DEFAULT 0",
      "ALTER TABLE memories ADD COLUMN supersedes_memory_id INTEGER REFERENCES memories(id)",
      "ALTER TABLE memories ADD COLUMN last_validated TEXT DEFAULT (datetime('now'))",
    ]
    for (const sql of dtcColumns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }

    // Same columns on memory_archive
    const archiveDtcColumns = [
      'ALTER TABLE memory_archive ADD COLUMN classification TEXT',
      'ALTER TABLE memory_archive ADD COLUMN quality REAL',
      'ALTER TABLE memory_archive ADD COLUMN state TEXT',
      'ALTER TABLE memory_archive ADD COLUMN source_type TEXT',
      'ALTER TABLE memory_archive ADD COLUMN evidence TEXT',
      'ALTER TABLE memory_archive ADD COLUMN support_count INTEGER DEFAULT 0',
      'ALTER TABLE memory_archive ADD COLUMN challenge_count INTEGER DEFAULT 0',
      'ALTER TABLE memory_archive ADD COLUMN supersedes_memory_id INTEGER',
      'ALTER TABLE memory_archive ADD COLUMN last_validated TEXT',
    ]
    for (const sql of archiveDtcColumns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }

    // Consolidation tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_locks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        pid INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consolidation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_reason TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        phases_completed TEXT,
        mutations INTEGER DEFAULT 0,
        dry_run INTEGER NOT NULL DEFAULT 1,
        summary TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_classification ON memories(classification);
      CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
      CREATE INDEX IF NOT EXISTS idx_memories_classification_state ON memories(classification, state);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);
      CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_memory_id);
    `)
```

- [ ] **Step 4: Update Memory interface in memory.ts**

Replace the `Memory` interface at the top of `memory.ts`:

```typescript
export type Classification = 'foundational' | 'strategic' | 'operational' | 'observational' | 'ephemeral'
export type MemoryState = 'active' | 'disputed' | 'superseded' | 'archived'
export type SourceType = 'human' | 'agent' | 'consolidation' | 'system'

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
  classification: Classification
  quality: number
  state: MemoryState
  source_type: SourceType
  evidence: string | null
  support_count: number
  challenge_count: number
  supersedes_memory_id: number | null
  last_validated: string
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: PASS for the new schema tests. Some existing tests may need `RETURNING *` to include new columns — verify all pass.

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test`
Expected: All existing tests still pass (new columns have defaults, so existing INSERT statements work unchanged).

- [ ] **Step 7: Commit**

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
git add db.ts memory.ts tests/memory.test.ts
git commit -m "feat(schema): add DTC columns, consolidation tables, and indexes"
```

---

## Task 2: Memory Primitives

**Files:**
- Modify: `/Users/coachstokes/.claude/mcp-servers/task-board/memory.ts`
- Test: `/Users/coachstokes/.claude/mcp-servers/task-board/tests/memory.test.ts`

- [ ] **Step 1: Write failing tests for normalizeContent and inferClassification**

Add to `tests/memory.test.ts`:

```typescript
describe('normalizeContent', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('collapses whitespace and trims', () => {
    expect(mem.normalizeContent('  hello   world  ')).toBe('hello world')
  })

  test('lowercases', () => {
    expect(mem.normalizeContent('Hello World')).toBe('hello world')
  })
})

describe('inferClassification', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('role category maps to foundational', () => {
    expect(mem.inferClassification('any content', 'role')).toBe('foundational')
  })

  test('preference category maps to strategic', () => {
    expect(mem.inferClassification('any content', 'preference')).toBe('strategic')
  })

  test('fact category maps to operational', () => {
    expect(mem.inferClassification('any content', 'fact')).toBe('operational')
  })

  test('task_summary category maps to observational', () => {
    expect(mem.inferClassification('any content', 'task_summary')).toBe('observational')
  })

  test('learning category maps to operational', () => {
    expect(mem.inferClassification('any content', 'learning')).toBe('operational')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: FAIL — normalizeContent and inferClassification methods don't exist.

- [ ] **Step 3: Implement normalizeContent and inferClassification in memory.ts**

Add these methods to the `MemoryDB` class:

```typescript
  normalizeContent(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase()
  }

  inferClassification(content: string, category: string): Classification {
    const CATEGORY_MAP: Record<string, Classification> = {
      role: 'foundational',
      preference: 'strategic',
      fact: 'operational',
      task_summary: 'observational',
      learning: 'operational',
    }
    return CATEGORY_MAP[category] ?? 'operational'
  }

  inferSourceType(agent: string): SourceType {
    if (agent === 'shared') return 'system'
    return 'agent'
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for challengeMemory**

Add to `tests/memory.test.ts`:

```typescript
describe('challengeMemory', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('increments challenge_count', () => {
    const m = mem.saveMemory({ agent: 'boss', content: 'test fact', category: 'fact' })
    const challenged = mem.challengeMemory(m.id, 'outdated info')
    expect(challenged).not.toBeNull()
    expect(challenged!.challenge_count).toBe(1)
  })

  test('flips to disputed when challenge_count > support_count', () => {
    const m = mem.saveMemory({ agent: 'boss', content: 'test fact', category: 'fact' })
    const challenged = mem.challengeMemory(m.id, 'outdated info')
    expect(challenged!.state).toBe('disputed')
    expect(challenged!.quality).toBeLessThan(0.5)
  })

  test('reduces quality by 0.2 when disputed, floored at 0', () => {
    const m = mem.saveMemory({ agent: 'boss', content: 'test fact', category: 'fact' })
    const c1 = mem.challengeMemory(m.id, 'reason 1')
    expect(c1!.quality).toBeCloseTo(0.3, 1)
    const c2 = mem.challengeMemory(m.id, 'reason 2')
    expect(c2!.quality).toBeCloseTo(0.1, 1)
    const c3 = mem.challengeMemory(m.id, 'reason 3')
    expect(c3!.quality).toBeCloseTo(0.0, 1)
  })

  test('returns null for nonexistent memory', () => {
    expect(mem.challengeMemory(9999, 'reason')).toBeNull()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: FAIL — challengeMemory not defined.

- [ ] **Step 7: Implement challengeMemory in memory.ts**

Add to `MemoryDB` class:

```typescript
  challengeMemory(id: number, reason: string): Memory | null {
    return this.taskDb.run(db => {
      const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null
      if (!existing) return null

      const newChallengeCount = existing.challenge_count + 1
      const shouldDispute = newChallengeCount > existing.support_count
      const newQuality = shouldDispute ? Math.max(existing.quality - 0.2, 0) : existing.quality
      const newState = shouldDispute ? 'disputed' : existing.state

      const updated = db.prepare(`
        UPDATE memories
        SET challenge_count = ?, quality = ?, state = ?, last_validated = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(newChallengeCount, newQuality, newState, id) as Memory

      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, memory_id)
        VALUES ('system', 'memory_challenged', ?, ?)
      `).run(reason, id)

      return updated
    })
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: PASS

- [ ] **Step 9: Write failing tests for supersedeMemory**

Add to `tests/memory.test.ts`:

```typescript
describe('supersedeMemory', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('marks old memory as superseded and creates replacement', () => {
    const old = mem.saveMemory({ agent: 'boss', content: 'old fact', category: 'fact' })
    const result = mem.supersedeMemory(old.id, 'new fact', 'updated info')
    expect(result).not.toBeNull()
    expect(result!.old.state).toBe('superseded')
    expect(result!.new.content).toBe('new fact')
    expect(result!.new.supersedes_memory_id).toBe(old.id)
    expect(result!.new.agent).toBe('boss')
    expect(result!.new.category).toBe('fact')
    expect(result!.new.classification).toBe(old.classification)
  })

  test('returns null for nonexistent memory', () => {
    expect(mem.supersedeMemory(9999, 'new', 'reason')).toBeNull()
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: FAIL — supersedeMemory not defined.

- [ ] **Step 11: Implement supersedeMemory in memory.ts**

Add to `MemoryDB` class:

```typescript
  supersedeMemory(oldId: number, newContent: string, reason: string): { old: Memory, new: Memory } | null {
    return this.taskDb.run(db => {
      const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(oldId) as Memory | null
      if (!existing) return null

      const old = db.prepare(`
        UPDATE memories SET state = 'superseded', last_validated = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(oldId) as Memory

      const replacement = db.prepare(`
        INSERT INTO memories (agent, content, category, classification, quality, state, source_type, support_count, supersedes_memory_id)
        VALUES (?, ?, ?, ?, 0.5, 'active', 'agent', 0, ?)
        RETURNING *
      `).get(existing.agent, newContent, existing.category, existing.classification, oldId) as Memory

      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, memory_id)
        VALUES ('system', 'memory_superseded', ?, ?)
      `).run(`${reason} | old=${oldId} new=${replacement.id}`, replacement.id)

      return { old, new: replacement }
    })
  }
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: PASS

- [ ] **Step 13: Write failing test for content dedup on save**

Add to `tests/memory.test.ts`:

```typescript
describe('saveMemory dedup', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('duplicate content bumps support_count instead of creating new', () => {
    const m1 = mem.saveMemory({ agent: 'boss', content: 'Same content here', category: 'fact' })
    const m2 = mem.saveMemory({ agent: 'boss', content: 'same  content  here', category: 'fact' })
    expect(m2.id).toBe(m1.id)
    expect(m2.support_count).toBe(1)
  })

  test('different agent same content creates new memory', () => {
    const m1 = mem.saveMemory({ agent: 'boss', content: 'Same content', category: 'fact' })
    const m2 = mem.saveMemory({ agent: 'steve', content: 'Same content', category: 'fact' })
    expect(m2.id).not.toBe(m1.id)
  })
})
```

- [ ] **Step 14: Run test to verify it fails**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: FAIL — saveMemory creates duplicates, doesn't check for existing.

- [ ] **Step 15: Update saveMemory with dedup logic**

Replace the `saveMemory` method in `memory.ts`:

```typescript
  saveMemory(input: SaveMemoryInput): Memory {
    return this.taskDb.run(db => {
      // Dedup check: normalize content and look for existing active memory
      const normalized = this.normalizeContent(input.content)
      const existing = db.prepare(`
        SELECT * FROM memories
        WHERE agent = ? AND state = 'active'
        AND LOWER(TRIM(REPLACE(content, '  ', ' '))) = ?
      `).get(input.agent, normalized) as Memory | null

      if (existing) {
        return db.prepare(`
          UPDATE memories SET support_count = support_count + 1, last_accessed = datetime('now')
          WHERE id = ?
          RETURNING *
        `).get(existing.id) as Memory
      }

      const classification = this.inferClassification(input.content, input.category)
      const sourceType = this.inferSourceType(input.agent)

      const stmt = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, source_task_id, classification, source_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `)
      return stmt.get(
        input.agent,
        input.content,
        input.category,
        input.importance ?? 3,
        input.pinned ? 1 : 0,
        input.source_task_id ?? null,
        classification,
        sourceType,
      ) as Memory
    })
  }
```

- [ ] **Step 16: Run test to verify it passes**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/memory.test.ts`
Expected: PASS

- [ ] **Step 17: Update recallMemories, getBootBriefing, getDecayCandidate, archiveMemory**

In `memory.ts`, update these methods:

**recallMemories** — add state filter and quality sorting:
```typescript
  recallMemories(agent: string, filter: RecallFilter): Memory[] {
    return this.taskDb.run(db => {
      const conditions = ['(agent = ? OR agent = ?)', "state != 'superseded'"]
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
      const sql = `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY quality DESC, importance DESC, last_accessed DESC LIMIT ?`
      params.push(limit)

      const results = db.prepare(sql).all(...params) as Memory[]

      if (results.length > 0) {
        const ids = results.map(r => r.id)
        db.prepare(`
          UPDATE memories
          SET last_accessed = datetime('now'),
              access_count = access_count + 1,
              importance = MIN(importance + 1, 5)
          WHERE id IN (${ids.map(() => '?').join(',')})
        `).run(...ids)
      }

      return results
    })
  }
```

**getBootBriefing** — filter by state='active', sort by quality:
```typescript
  getBootBriefing(agent: string, taskDb: TaskDB): BootBriefing {
    return this.taskDb.run(db => {
      const role = db.prepare(
        `SELECT * FROM memories WHERE agent = ? AND category = 'role' AND pinned = 1 AND state = 'active' ORDER BY quality DESC, importance DESC`
      ).all(agent) as Memory[]

      const topMemories = db.prepare(
        `SELECT * FROM memories WHERE agent = ? AND category != 'role' AND state = 'active' ORDER BY quality DESC, importance DESC LIMIT 5`
      ).all(agent) as Memory[]

      const sharedMemories = db.prepare(
        `SELECT * FROM memories WHERE agent = 'shared' AND state = 'active' ORDER BY quality DESC, importance DESC LIMIT 5`
      ).all() as Memory[]

      const recentTasks = db.prepare(
        `SELECT * FROM tasks WHERE to_agent = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 5`
      ).all(agent) as Task[]

      return { role, topMemories, sharedMemories, recentTasks }
    })
  }
```

**getDecayCandidate** — exclude foundational and superseded:
```typescript
  getDecayCandidate(): Memory[] {
    return this.taskDb.run(db => db.prepare(`
      SELECT * FROM memories
      WHERE pinned = 0
        AND last_accessed < datetime('now', '-1 days')
        AND importance > 0
        AND classification != 'foundational'
        AND state != 'superseded'
    `).all() as Memory[])
  }
```

**archiveMemory** — copy new columns:
```typescript
  archiveMemory(id: number): void {
    this.taskDb.run(db => {
      db.prepare(`
        INSERT INTO memory_archive (id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count, classification, quality, state, source_type, evidence, support_count, challenge_count, supersedes_memory_id, last_validated)
        SELECT id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count, classification, quality, state, source_type, evidence, support_count, challenge_count, supersedes_memory_id, last_validated FROM memories WHERE id = ?
      `).run(id)
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    })
  }
```

- [ ] **Step 18: Run full test suite**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test`
Expected: All tests pass.

- [ ] **Step 19: Commit**

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
git add memory.ts tests/memory.test.ts
git commit -m "feat(memory): add challenge, supersede, dedup, and classification primitives"
```

---

## Task 3: Classification-Aware Decay

**Files:**
- Modify: `/Users/coachstokes/.claude/mcp-servers/task-board/consolidate.ts`
- Test: `/Users/coachstokes/.claude/mcp-servers/task-board/tests/consolidate.test.ts`

- [ ] **Step 1: Write failing tests for classification-aware decay**

Add to `tests/consolidate.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { runDecay, runArchive, getDecayWindowDays } from '../consolidate'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/test-autodream-consolidate.db'

describe('getDecayWindowDays', () => {
  test('foundational returns Infinity', () => {
    const m = { classification: 'foundational', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(Infinity)
  })

  test('strategic returns 14', () => {
    const m = { classification: 'strategic', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(14)
  })

  test('operational returns 7', () => {
    const m = { classification: 'operational', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(7)
  })

  test('observational returns 3', () => {
    const m = { classification: 'observational', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(3)
  })

  test('ephemeral returns 1', () => {
    const m = { classification: 'ephemeral', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(1)
  })

  test('disputed halves window', () => {
    const m = { classification: 'operational', state: 'disputed', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(4) // ceil(7/2)
  })

  test('low quality halves window', () => {
    const m = { classification: 'operational', state: 'active', quality: 0.2, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(4) // ceil(7/2)
  })

  test('challenge > support halves window', () => {
    const m = { classification: 'strategic', state: 'active', quality: 0.5, challenge_count: 3, support_count: 1 } as any
    expect(getDecayWindowDays(m)).toBe(7) // ceil(14/2)
  })

  test('multiple modifiers stack', () => {
    const m = { classification: 'operational', state: 'disputed', quality: 0.2, challenge_count: 3, support_count: 0 } as any
    // 7 -> 4 (disputed) -> 2 (low quality) -> 1 (challenged)
    expect(getDecayWindowDays(m)).toBe(1)
  })
})

describe('runArchive sweeps superseded', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('archives superseded memories older than 7 days', () => {
    const m = mem.saveMemory({ agent: 'boss', content: 'old fact', category: 'fact' })
    // Manually set state to superseded and backdate
    taskDb.run(db => {
      db.prepare("UPDATE memories SET state = 'superseded', last_accessed = datetime('now', '-8 days') WHERE id = ?").run(m.id)
    })
    const archived = runArchive(mem)
    expect(archived).toBeGreaterThanOrEqual(1)
    expect(mem.getMemory(m.id)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/consolidate.test.ts`
Expected: FAIL — getDecayWindowDays not exported, new logic not implemented.

- [ ] **Step 3: Implement classification-aware decay in consolidate.ts**

Replace the `runDecay` function and add `getDecayWindowDays`:

```typescript
import type { Memory } from './memory'

export function getDecayWindowDays(memory: Pick<Memory, 'classification' | 'state' | 'quality' | 'challenge_count' | 'support_count'>): number {
  const BASE_WINDOWS: Record<string, number> = {
    foundational: Infinity,
    strategic: 14,
    operational: 7,
    observational: 3,
    ephemeral: 1,
  }
  let window = BASE_WINDOWS[memory.classification] ?? 7
  if (window === Infinity) return Infinity
  if (memory.state === 'disputed') window = Math.ceil(window / 2)
  if (memory.quality < 0.3) window = Math.ceil(window / 2)
  if (memory.challenge_count > memory.support_count) window = Math.ceil(window / 2)
  return Math.max(window, 1)
}

export function runDecay(mem: MemoryDB): number {
  const candidates = mem.getDecayCandidate()
  let count = 0

  for (const m of candidates) {
    const decayWindow = getDecayWindowDays(m)
    if (decayWindow === Infinity) continue

    const lastAccessed = new Date(m.last_accessed + 'Z')
    const now = new Date()
    const daysSinceAccess = Math.floor((now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24))

    if (daysSinceAccess <= decayWindow) continue

    const decayPeriods = Math.floor(daysSinceAccess / decayWindow)
    const newImportance = Math.max(m.importance - decayPeriods, 0)

    if (newImportance !== m.importance) {
      mem.decayMemory(m.id, newImportance)
      count++
    }
  }

  return count
}
```

Update `runArchive` to also sweep superseded:

```typescript
export function runArchive(mem: MemoryDB): number {
  const zeroIds = mem.getZeroImportanceIds()
  for (const id of zeroIds) {
    mem.archiveMemory(id)
  }

  // Also sweep superseded memories older than 7 days
  const superseded = mem.getSupersededOlderThan(7)
  for (const id of superseded) {
    mem.archiveMemory(id)
  }

  return zeroIds.length + superseded.length
}
```

Add `getSupersededOlderThan` to `memory.ts`:

```typescript
  getSupersededOlderThan(days: number): number[] {
    return this.taskDb.run(db =>
      (db.prepare(`
        SELECT id FROM memories
        WHERE state = 'superseded'
        AND last_accessed < datetime('now', '-' || ? || ' days')
      `).all(days) as { id: number }[]).map(r => r.id)
    )
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/consolidate.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
git add consolidate.ts memory.ts tests/consolidate.test.ts
git commit -m "feat(decay): classification-aware decay with tiered windows and modifiers"
```

---

## Task 4: Consolidator Daemon

**Files:**
- Create: `/Users/coachstokes/.claude/mcp-servers/task-board/consolidator.ts`
- Create: `/Users/coachstokes/.claude/mcp-servers/task-board/tests/consolidator.test.ts`

- [ ] **Step 1: Write failing tests for lock acquire/release and health report**

Create `tests/consolidator.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { MemoryConsolidator } from '../consolidator'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/test-autodream-consolidator.db'

describe('MemoryConsolidator', () => {
  let taskDb: TaskDB
  let mem: MemoryDB
  let consolidator: MemoryConsolidator

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
    consolidator = new MemoryConsolidator(mem, taskDb, true, 50)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  test('acquireLock succeeds when no lock exists', () => {
    expect(consolidator.acquireLock()).toBe(true)
    consolidator.releaseLock()
  })

  test('acquireLock fails when lock already held', () => {
    expect(consolidator.acquireLock()).toBe(true)
    expect(consolidator.acquireLock()).toBe(false)
    consolidator.releaseLock()
  })

  test('releaseLock frees the lock', () => {
    consolidator.acquireLock()
    consolidator.releaseLock()
    expect(consolidator.acquireLock()).toBe(true)
    consolidator.releaseLock()
  })

  test('getHealthReport returns valid stats', () => {
    mem.saveMemory({ agent: 'boss', content: 'fact 1', category: 'fact' })
    mem.saveMemory({ agent: 'boss', content: 'fact 2', category: 'preference' })
    const report = consolidator.getHealthReport()
    expect(report.totalActive).toBe(2)
    expect(report.byClassification.operational).toBe(1)
    expect(report.byClassification.strategic).toBe(1)
    expect(report.avgQuality).toBeCloseTo(0.5, 1)
    expect(report.disputeRate).toBe(0)
  })

  test('run completes a dry-run cycle', async () => {
    mem.saveMemory({ agent: 'boss', content: 'a fact to consolidate', category: 'fact' })
    const result = await consolidator.run('test')
    expect(result.dryRun).toBe(true)
    expect(result.phasesCompleted).toContain('orient')
    expect(result.phasesCompleted).toContain('gather')
    expect(result.phasesCompleted).toContain('validate')
    expect(result.phasesCompleted).toContain('consolidate')
    expect(result.phasesCompleted).toContain('prune')
    expect(result.runId).toBeGreaterThan(0)
  })

  test('checkTriggers returns time trigger after 6h', () => {
    // Insert a consolidation_run 7 hours ago
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO consolidation_runs (trigger_reason, started_at, completed_at, dry_run, mutations)
        VALUES ('test', datetime('now', '-7 hours'), datetime('now', '-7 hours'), 1, 0)
      `).run()
    })
    const triggers = consolidator.checkTriggers()
    expect(triggers.time).toBe(true)
  })

  test('checkTriggers returns false for time when run is recent', () => {
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO consolidation_runs (trigger_reason, started_at, completed_at, dry_run, mutations)
        VALUES ('test', datetime('now', '-1 hours'), datetime('now', '-1 hours'), 1, 0)
      `).run()
    })
    const triggers = consolidator.checkTriggers()
    expect(triggers.time).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/consolidator.test.ts`
Expected: FAIL — consolidator.ts doesn't exist.

- [ ] **Step 3: Create consolidator.ts with full implementation**

Create `/Users/coachstokes/.claude/mcp-servers/task-board/consolidator.ts`:

```typescript
import type { TaskDB } from './db'
import type { MemoryDB, Memory, Classification } from './memory'
import { runDecay, runArchive, runPrune, getDecayWindowDays } from './consolidate'

export interface ConsolidationResult {
  runId: number
  triggerReason: string
  phasesCompleted: string[]
  mutations: number
  dryRun: boolean
  summary: string
  durationMs: number
}

export interface HealthReport {
  totalActive: number
  byClassification: Record<string, number>
  byState: Record<string, number>
  disputeRate: number
  avgQuality: number
  lastRunAt: string | null
  lastRunMutations: number | null
}

export interface TriggerGates {
  time: boolean
  volume: boolean
  idle: boolean
  lock: boolean
}

interface Signal {
  type: 'stale' | 'duplicate' | 'disputed' | 'cluster'
  memoryIds: number[]
  reason: string
}

interface ValidatedAction {
  type: 'challenge' | 'supersede' | 'merge'
  targetId: number
  confidence: number
  reason: string
  newContent?: string
  survivorId?: number
}

interface Mutation {
  type: string
  memoryId: number
  before: Partial<Memory>
  after: Partial<Memory>
  reason: string
}

const HARD_TIME_LIMIT_MS = 15 * 60 * 1000 // 15 minutes
const TRIGGER_INTERVAL_HOURS = 6
const VOLUME_THRESHOLD = 25
const DISPUTE_RATE_THRESHOLD = 0.15
const IDLE_MINUTES = 45
const LOCK_LEASE_MINUTES = 10
const CONFIDENCE_THRESHOLD = 0.6

export class MemoryConsolidator {
  private lockId: number | null = null

  constructor(
    private mem: MemoryDB,
    private taskDb: TaskDB,
    private dryRun: boolean = true,
    private maxMutationsPerRun: number = 50,
  ) {}

  acquireLock(): boolean {
    return this.taskDb.run(db => {
      // Clean expired locks
      db.prepare("DELETE FROM consolidation_locks WHERE expires_at < datetime('now')").run()

      // Check for existing lock
      const existing = db.prepare('SELECT id FROM consolidation_locks LIMIT 1').get()
      if (existing) return false

      const result = db.prepare(`
        INSERT INTO consolidation_locks (agent, expires_at, pid)
        VALUES ('consolidator', datetime('now', '+${LOCK_LEASE_MINUTES} minutes'), ?)
        RETURNING id
      `).get(process.pid) as { id: number } | null

      if (result) {
        this.lockId = result.id
        return true
      }
      return false
    })
  }

  releaseLock(): void {
    if (this.lockId == null) return
    this.taskDb.run(db => {
      db.prepare('DELETE FROM consolidation_locks WHERE id = ?').run(this.lockId)
    })
    this.lockId = null
  }

  getHealthReport(): HealthReport {
    return this.taskDb.run(db => {
      const byClass = db.prepare(`
        SELECT classification, COUNT(*) as cnt FROM memories WHERE state = 'active' GROUP BY classification
      `).all() as { classification: string, cnt: number }[]

      const byState = db.prepare(`
        SELECT state, COUNT(*) as cnt FROM memories GROUP BY state
      `).all() as { state: string, cnt: number }[]

      const stats = db.prepare(`
        SELECT COUNT(*) as total, AVG(quality) as avg_q,
               SUM(CASE WHEN state = 'disputed' THEN 1 ELSE 0 END) as disputed_count
        FROM memories WHERE state != 'superseded'
      `).get() as { total: number, avg_q: number | null, disputed_count: number }

      const lastRun = db.prepare(`
        SELECT completed_at, mutations FROM consolidation_runs
        WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1
      `).get() as { completed_at: string, mutations: number } | null

      const classMap: Record<string, number> = {}
      for (const r of byClass) classMap[r.classification] = r.cnt

      const stateMap: Record<string, number> = {}
      for (const r of byState) stateMap[r.state] = r.cnt

      return {
        totalActive: stats.total,
        byClassification: classMap,
        byState: stateMap,
        disputeRate: stats.total > 0 ? stats.disputed_count / stats.total : 0,
        avgQuality: stats.avg_q ?? 0,
        lastRunAt: lastRun?.completed_at ?? null,
        lastRunMutations: lastRun?.mutations ?? null,
      }
    })
  }

  checkTriggers(): TriggerGates {
    return this.taskDb.run(db => {
      // Time gate: 6h since last successful run
      const lastRun = db.prepare(`
        SELECT completed_at FROM consolidation_runs
        WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1
      `).get() as { completed_at: string } | null

      let timeTrigger = true
      if (lastRun) {
        const lastRunTime = new Date(lastRun.completed_at + 'Z')
        const hoursSince = (Date.now() - lastRunTime.getTime()) / (1000 * 60 * 60)
        timeTrigger = hoursSince >= TRIGGER_INTERVAL_HOURS
      }

      // Volume gate: >25 new or >15% disputed
      const stats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN state = 'disputed' THEN 1 ELSE 0 END) as disputed
        FROM memories WHERE state != 'superseded'
      `).get() as { total: number, disputed: number }

      const recentCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM memories
        WHERE created_at > datetime('now', '-6 hours') AND state = 'active'
      `).get() as { cnt: number }

      const volumeTrigger = recentCount.cnt > VOLUME_THRESHOLD ||
        (stats.total > 0 && stats.disputed / stats.total > DISPUTE_RATE_THRESHOLD)

      // Idle gate: no task_status_events in 45min
      const recentStatus = db.prepare(`
        SELECT COUNT(*) as cnt FROM task_status_events
        WHERE created_at > datetime('now', '-${IDLE_MINUTES} minutes')
      `).get() as { cnt: number }
      const idleTrigger = recentStatus.cnt === 0

      // Lock gate: no unexpired lock
      db.prepare("DELETE FROM consolidation_locks WHERE expires_at < datetime('now')").run()
      const lockExists = db.prepare('SELECT id FROM consolidation_locks LIMIT 1').get()
      const lockTrigger = !lockExists

      return { time: timeTrigger, volume: volumeTrigger, idle: idleTrigger, lock: lockTrigger }
    })
  }

  async run(triggerReason: string): Promise<ConsolidationResult> {
    const startTime = Date.now()
    const phasesCompleted: string[] = []
    let mutations = 0

    if (!this.acquireLock()) {
      return { runId: 0, triggerReason, phasesCompleted: [], mutations: 0, dryRun: this.dryRun, summary: 'Could not acquire lock', durationMs: 0 }
    }

    // Create run record
    const runId = this.taskDb.run(db => {
      const r = db.prepare(`
        INSERT INTO consolidation_runs (trigger_reason, dry_run) VALUES (?, ?)
        RETURNING id
      `).get(triggerReason, this.dryRun ? 1 : 0) as { id: number }
      return r.id
    })

    try {
      // Phase 1: Orient
      const health = this.getHealthReport()
      phasesCompleted.push('orient')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 2: Gather
      const signals = this.gather(health)
      phasesCompleted.push('gather')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 3: Validate
      const actions = this.validate(signals)
      phasesCompleted.push('validate')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 4: Consolidate
      const muts = this.consolidate(actions, runId)
      mutations = muts.length
      phasesCompleted.push('consolidate')

      if (Date.now() - startTime > HARD_TIME_LIMIT_MS) throw new Error('Time limit exceeded')

      // Phase 5: Prune/Index
      const decayed = runDecay(this.mem)
      const archived = runArchive(this.mem)
      const pruned = runPrune(this.mem)
      phasesCompleted.push('prune')

      const summary = `Orient: ${health.totalActive} active, ${health.disputeRate.toFixed(2)} dispute rate. Gathered ${signals.length} signals, validated ${actions.length} actions, executed ${mutations} mutations (dry_run=${this.dryRun}). Decay: ${decayed}, Archive: ${archived}, Prune: ${pruned}.`

      // Record completion
      this.taskDb.run(db => {
        db.prepare(`
          UPDATE consolidation_runs
          SET completed_at = datetime('now'), phases_completed = ?, mutations = ?, summary = ?
          WHERE id = ?
        `).run(JSON.stringify(phasesCompleted), mutations, summary, runId)
      })

      return {
        runId,
        triggerReason,
        phasesCompleted,
        mutations,
        dryRun: this.dryRun,
        summary,
        durationMs: Date.now() - startTime,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.taskDb.run(db => {
        db.prepare(`
          UPDATE consolidation_runs
          SET completed_at = datetime('now'), phases_completed = ?, mutations = ?, error = ?
          WHERE id = ?
        `).run(JSON.stringify(phasesCompleted), mutations, errorMsg, runId)
      })
      return {
        runId,
        triggerReason,
        phasesCompleted,
        mutations,
        dryRun: this.dryRun,
        summary: `Error: ${errorMsg}`,
        durationMs: Date.now() - startTime,
      }
    } finally {
      this.releaseLock()
    }
  }

  private gather(health: HealthReport): Signal[] {
    return this.taskDb.run(db => {
      const signals: Signal[] = []

      // Find stale memories past their decay window
      const allActive = db.prepare(`
        SELECT * FROM memories WHERE state = 'active' AND pinned = 0
      `).all() as Memory[]

      for (const m of allActive) {
        const window = getDecayWindowDays(m)
        if (window === Infinity) continue
        const lastAccessed = new Date(m.last_accessed + 'Z')
        const daysSince = (Date.now() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince > window * 2) {
          signals.push({ type: 'stale', memoryIds: [m.id], reason: `${daysSince.toFixed(0)}d since access, window=${window}d` })
        }
      }

      // Find duplicate content (same normalized content, different IDs)
      const dupes = db.prepare(`
        SELECT m1.id as id1, m2.id as id2
        FROM memories m1
        JOIN memories m2 ON m1.id < m2.id
          AND m1.agent = m2.agent
          AND m1.state = 'active'
          AND m2.state = 'active'
          AND LOWER(TRIM(m1.content)) = LOWER(TRIM(m2.content))
        LIMIT 50
      `).all() as { id1: number, id2: number }[]

      for (const d of dupes) {
        signals.push({ type: 'duplicate', memoryIds: [d.id1, d.id2], reason: 'identical normalized content' })
      }

      // Find heavily disputed memories
      const disputed = db.prepare(`
        SELECT id FROM memories
        WHERE state = 'disputed' AND challenge_count > support_count + 2
        LIMIT 20
      `).all() as { id: number }[]

      for (const d of disputed) {
        signals.push({ type: 'disputed', memoryIds: [d.id], reason: 'heavily disputed, challenge_count >> support_count' })
      }

      return signals
    })
  }

  private validate(signals: Signal[]): ValidatedAction[] {
    return this.taskDb.run(db => {
      const actions: ValidatedAction[] = []
      const eligible = db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE state = \'active\'').get() as { cnt: number }
      const maxActions = Math.ceil(eligible.cnt * 0.15)

      for (const signal of signals) {
        if (actions.length >= maxActions || actions.length >= this.maxMutationsPerRun) break

        if (signal.type === 'stale') {
          const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(signal.memoryIds[0]) as Memory | null
          if (!m) continue
          // Block foundational and strategic
          if (m.classification === 'foundational' || m.classification === 'strategic') {
            db.prepare(`INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('consolidator', 'consolidation_blocked', ?, ?)`).run(
              `Blocked: ${m.classification} memory, reason: ${signal.reason}`, m.id
            )
            continue
          }
          const confidence = this.calcConfidence(m)
          if (confidence < CONFIDENCE_THRESHOLD) continue
          actions.push({ type: 'challenge', targetId: m.id, confidence, reason: signal.reason })
        }

        if (signal.type === 'duplicate') {
          const m1 = db.prepare('SELECT * FROM memories WHERE id = ?').get(signal.memoryIds[0]) as Memory | null
          const m2 = db.prepare('SELECT * FROM memories WHERE id = ?').get(signal.memoryIds[1]) as Memory | null
          if (!m1 || !m2) continue
          if (m1.classification === 'foundational' || m1.classification === 'strategic') continue
          const survivor = m1.quality >= m2.quality ? m1 : m2
          const victim = survivor.id === m1.id ? m2 : m1
          actions.push({ type: 'merge', targetId: victim.id, survivorId: survivor.id, confidence: 1.0, reason: signal.reason })
        }

        if (signal.type === 'disputed') {
          const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(signal.memoryIds[0]) as Memory | null
          if (!m) continue
          if (m.classification === 'foundational' || m.classification === 'strategic') continue
          actions.push({ type: 'challenge', targetId: m.id, confidence: 0.9, reason: signal.reason })
        }
      }

      return actions
    })
  }

  private calcConfidence(m: Memory): number {
    const accessScore = Math.min(m.access_count / 10, 1) * 0.3
    const supportRatio = m.support_count + m.challenge_count > 0
      ? m.support_count / (m.support_count + m.challenge_count)
      : 0.5
    const supportScore = supportRatio * 0.4
    const qualityScore = m.quality * 0.3
    return Math.max(0, Math.min(1, accessScore + supportScore + qualityScore))
  }

  private consolidate(actions: ValidatedAction[], runId: number): Mutation[] {
    const mutations: Mutation[] = []

    for (const action of actions) {
      if (this.dryRun) {
        // Log proposed action but don't execute
        this.taskDb.run(db => {
          db.prepare(`INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('consolidator', 'consolidation_dry_run', ?, ?)`).run(
            `Would ${action.type} memory ${action.targetId}: ${action.reason} (confidence=${action.confidence.toFixed(2)})`, action.targetId
          )
        })
        mutations.push({ type: action.type, memoryId: action.targetId, before: {}, after: {}, reason: `[DRY RUN] ${action.reason}` })
        continue
      }

      if (action.type === 'challenge') {
        const before = this.mem.getMemory(action.targetId)
        const after = this.mem.challengeMemory(action.targetId, `[consolidator run=${runId}] ${action.reason}`)
        if (before && after) {
          mutations.push({
            type: 'challenge',
            memoryId: action.targetId,
            before: { state: before.state, quality: before.quality, challenge_count: before.challenge_count },
            after: { state: after.state, quality: after.quality, challenge_count: after.challenge_count },
            reason: action.reason,
          })
        }
      }

      if (action.type === 'merge' && action.survivorId != null) {
        const victim = this.mem.getMemory(action.targetId)
        if (victim) {
          // Bump survivor support_count, then archive victim
          this.taskDb.run(db => {
            db.prepare('UPDATE memories SET support_count = support_count + 1 WHERE id = ?').run(action.survivorId)
            db.prepare("UPDATE memories SET state = 'superseded' WHERE id = ?").run(action.targetId)
            db.prepare(`INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('consolidator', 'consolidation_merge', ?, ?)`).run(
              `Merged into ${action.survivorId}, run=${runId}`, action.targetId
            )
          })
          mutations.push({
            type: 'merge',
            memoryId: action.targetId,
            before: { state: 'active' },
            after: { state: 'superseded' },
            reason: `Merged into #${action.survivorId}`,
          })
        }
      }
    }

    return mutations
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test tests/consolidator.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
git add consolidator.ts tests/consolidator.test.ts
git commit -m "feat(consolidator): 5-phase memory consolidation daemon with triggers and locks"
```

---

## Task 5: MCP Tools

**Files:**
- Modify: `/Users/coachstokes/.claude/mcp-servers/task-board/server.ts`

- [ ] **Step 1: Read current server.ts to find tool registration pattern**

Read: `/Users/coachstokes/.claude/mcp-servers/task-board/server.ts`
Look for the pattern used by existing tools (e.g., `save_memory`, `recall_memories`) to match the registration style.

- [ ] **Step 2: Add imports at top of server.ts**

```typescript
import { MemoryConsolidator } from './consolidator'
```

- [ ] **Step 3: Add 4 new tool definitions to the ListToolsRequestSchema handler**

Add to the tools array (match existing indentation/style):

```typescript
    {
      name: 'challenge_memory',
      description: 'Challenge a memory — increments challenge_count, may flip to disputed state. Use when a memory is outdated or contradicted.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to challenge' },
          reason: { type: 'string', description: 'Why this memory is being challenged' },
        },
        required: ['memory_id', 'reason'],
      },
    },
    {
      name: 'supersede_memory',
      description: 'Replace an outdated memory with new content. Marks old as superseded, creates replacement with lineage link.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          old_memory_id: { type: 'number', description: 'The memory ID to supersede' },
          new_content: { type: 'string', description: 'The replacement content' },
          reason: { type: 'string', description: 'Why this memory is being superseded' },
        },
        required: ['old_memory_id', 'new_content', 'reason'],
      },
    },
    {
      name: 'consolidate_memories',
      description: 'Trigger a memory consolidation run. Runs the 5-phase daemon cycle (Orient, Gather, Validate, Consolidate, Prune).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          scope: { type: 'string', description: 'Scope: all, operational, or agent:NAME', default: 'all' },
          dry_run: { type: 'boolean', description: 'If true, log proposed changes without executing', default: true },
          max_changes: { type: 'number', description: 'Maximum mutations per run', default: 50 },
        },
      },
    },
    {
      name: 'get_memory_health_report',
      description: 'Get memory system health stats: counts by classification/state, dispute rate, average quality, last consolidation run info.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
```

- [ ] **Step 4: Add tool handlers to the CallToolRequestSchema handler**

Add cases for the 4 new tools (match existing switch/case style):

```typescript
      case 'challenge_memory': {
        const memoryId = Number(args.memory_id)
        const reason = String(args.reason ?? '')
        const result = mem.challengeMemory(memoryId, reason)
        if (!result) return { content: [{ type: 'text', text: `Memory #${memoryId} not found.` }] }
        auditLog(SELF_LABEL, 'memory_challenged', `${reason} | quality=${result.quality} state=${result.state}`, undefined, memoryId)
        return { content: [{ type: 'text', text: `Challenged memory #${memoryId}. State: ${result.state}, Quality: ${result.quality.toFixed(2)}, Challenges: ${result.challenge_count}, Supports: ${result.support_count}` }] }
      }

      case 'supersede_memory': {
        const oldId = Number(args.old_memory_id)
        const newContent = String(args.new_content ?? '')
        const reason = String(args.reason ?? '')
        const result = mem.supersedeMemory(oldId, newContent, reason)
        if (!result) return { content: [{ type: 'text', text: `Memory #${oldId} not found.` }] }
        auditLog(SELF_LABEL, 'memory_superseded', `${reason} | old=#${oldId} new=#${result.new.id}`, undefined, result.new.id)
        return { content: [{ type: 'text', text: `Superseded memory #${oldId} → #${result.new.id}. Old state: ${result.old.state}. New content saved.` }] }
      }

      case 'consolidate_memories': {
        const dryRun = args.dry_run !== false
        const maxChanges = Number(args.max_changes ?? 50)
        const consolidator = new MemoryConsolidator(mem, taskDb, dryRun, maxChanges)
        const result = await consolidator.run(`manual trigger by ${SELF_LABEL}`)
        auditLog(SELF_LABEL, 'consolidation_triggered', result.summary)
        return { content: [{ type: 'text', text: result.summary }] }
      }

      case 'get_memory_health_report': {
        const consolidator = new MemoryConsolidator(mem, taskDb)
        const report = consolidator.getHealthReport()
        const lines = [
          `Total active: ${report.totalActive}`,
          `By classification: ${JSON.stringify(report.byClassification)}`,
          `By state: ${JSON.stringify(report.byState)}`,
          `Dispute rate: ${(report.disputeRate * 100).toFixed(1)}%`,
          `Avg quality: ${report.avgQuality.toFixed(2)}`,
          `Last run: ${report.lastRunAt ?? 'never'} (${report.lastRunMutations ?? 0} mutations)`,
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
```

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test`
Expected: All pass (MCP tools are tested via integration tests, not unit tests for the handler wiring).

- [ ] **Step 6: Commit**

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
git add server.ts
git commit -m "feat(mcp): add consolidate_memories, get_memory_health_report, challenge_memory, supersede_memory tools"
```

---

## Task 6: Config and Snoopy Integration

**Files:**
- Modify: `/Users/coachstokes/.claude/mcp-servers/task-board/config.ts`
- Modify: `/Users/coachstokes/.claude/mcp-servers/task-board/snoopy-bot.ts`

- [ ] **Step 1: Add CONSOLIDATION_DRY_RUN to config.ts**

Add to the end of `config.ts`:

```typescript
// Consolidation daemon config
export const CONSOLIDATION_DRY_RUN = true // Flip to false after 2-week validation
export const CONSOLIDATION_CHECK_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
```

- [ ] **Step 2: Read current snoopy-bot.ts**

Read: `/Users/coachstokes/.claude/mcp-servers/task-board/snoopy-bot.ts`

- [ ] **Step 3: Add daemon trigger loop to snoopy-bot.ts**

Update `snoopy-bot.ts` to include the consolidation trigger:

```typescript
import { TaskDB } from './db'
import { MemoryDB } from './memory'
import { MemoryConsolidator } from './consolidator'
import { DB_PATH, CONSOLIDATION_DRY_RUN, CONSOLIDATION_CHECK_INTERVAL_MS, TELEGRAM_GROUP_ID, getTelegramToken } from './config'

const taskDb = new TaskDB(DB_PATH)
const mem = new MemoryDB(taskDb)
const consolidator = new MemoryConsolidator(mem, taskDb, CONSOLIDATION_DRY_RUN)

async function postToTelegram(text: string): Promise<void> {
  const token = getTelegramToken()
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_GROUP_ID, text }),
    })
  } catch { /* best effort */ }
}

async function checkAndRun(): Promise<void> {
  const triggers = consolidator.checkTriggers()
  const reasons: string[] = []
  if (triggers.time) reasons.push('time')
  if (triggers.volume) reasons.push('volume')
  if (triggers.idle) reasons.push('idle')

  if (reasons.length === 0 || !triggers.lock) return

  const triggerReason = `auto: ${reasons.join('+')}`
  console.log(`[consolidator] Triggered: ${triggerReason}`)

  const result = await consolidator.run(triggerReason)
  console.log(`[consolidator] ${result.summary}`)

  if (result.mutations > 5 || !CONSOLIDATION_DRY_RUN) {
    await postToTelegram(`[Consolidator] ${result.summary}`)
  }
}

// Start the trigger check loop
setInterval(checkAndRun, CONSOLIDATION_CHECK_INTERVAL_MS)
console.log(`[consolidator] Daemon started (dry_run=${CONSOLIDATION_DRY_RUN}, interval=${CONSOLIDATION_CHECK_INTERVAL_MS / 1000}s)`)
```

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
git add config.ts snoopy-bot.ts
git commit -m "feat(snoopy): consolidation daemon integration with trigger loop and Telegram alerts"
```

---

## Task 7: End-to-End Validation

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun test`
Expected: All tests pass — existing + new.

- [ ] **Step 2: Verify MCP tools load**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun run server.ts --help 2>&1 | head -5`
(Just verify it starts without import errors. If server.ts requires MCP transport, verify by checking for syntax/import errors instead:)
Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun build --target=bun consolidator.ts 2>&1`
Expected: No errors.

- [ ] **Step 3: Test dry-run consolidation against live DB**

Run: `cd /Users/coachstokes/.claude/mcp-servers/task-board && bun -e "
import { TaskDB } from './db'
import { MemoryDB } from './memory'
import { MemoryConsolidator } from './consolidator'
import { DB_PATH } from './config'

const taskDb = new TaskDB(DB_PATH)
const mem = new MemoryDB(taskDb)
const c = new MemoryConsolidator(mem, taskDb, true, 50)

console.log('Health report:', JSON.stringify(c.getHealthReport(), null, 2))
c.run('validation test').then(r => {
  console.log('Run result:', JSON.stringify(r, null, 2))
  taskDb.close()
})
"`
Expected: Health report with real stats, run completes all 5 phases in dry-run mode.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
cd /Users/coachstokes/.claude/mcp-servers/task-board
git add -A
git commit -m "fix: end-to-end validation fixes for autodream daemon"
```
