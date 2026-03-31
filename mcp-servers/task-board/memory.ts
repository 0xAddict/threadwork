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
    // Role memories (pinned, category=role) — NO access tracking
    const role = this.db.prepare(
      `SELECT * FROM memories WHERE agent = ? AND category = 'role' AND pinned = 1 ORDER BY importance DESC`
    ).all(agent) as Memory[]

    // Top 5 non-role memories by importance — NO access tracking
    const topMemories = this.db.prepare(
      `SELECT * FROM memories WHERE agent = ? AND category != 'role' ORDER BY importance DESC LIMIT 5`
    ).all(agent) as Memory[]

    // Top 5 shared memories — NO access tracking
    const sharedMemories = this.db.prepare(
      `SELECT * FROM memories WHERE agent = 'shared' ORDER BY importance DESC LIMIT 5`
    ).all() as Memory[]

    // Last 5 completed tasks
    const recentTasks = this.db.prepare(
      `SELECT * FROM tasks WHERE to_agent = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 5`
    ).all(agent) as Task[]

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
