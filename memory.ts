import type { TaskDB, Task } from './db'

export type Classification = 'foundational' | 'strategic' | 'operational' | 'observational' | 'ephemeral'
export type MemoryState = 'proposed' | 'active' | 'disputed' | 'superseded' | 'archived'
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

export interface SaveMemoryInput {
  agent: string
  content: string
  category: string
  importance?: number
  pinned?: boolean
  source_task_id?: number
  classification?: Classification
  quality?: number
  source_type?: SourceType
  evidence?: string
  supersedes_memory_id?: number
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
  private taskDb: TaskDB

  constructor(taskDb: TaskDB) {
    this.taskDb = taskDb
  }

  normalizeContent(text: string): string {
    // NFC normalization folds composed vs decomposed accented characters
    // (e.g. 'café' as c+é vs c+e+combining-acute) into a canonical form,
    // so recall on Unicode-heavy content doesn't silently miss.
    return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
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

      const classification = input.classification ?? this.inferClassification(input.content, input.category)
      const sourceType = input.source_type ?? this.inferSourceType(input.agent)
      const quality = input.quality ?? 0.5
      const evidence = input.evidence ?? null
      const supersedes = input.supersedes_memory_id ?? null

      // Spec AC #5: agent + foundational -> proposed state
      let state: MemoryState = 'active'
      if (sourceType === 'agent' && classification === 'foundational') {
        state = 'proposed'
      }

      const stmt = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, source_task_id,
          classification, quality, state, source_type, evidence, supersedes_memory_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        quality,
        state,
        sourceType,
        evidence,
        supersedes,
      ) as Memory
    })
  }

  getMemory(id: number): Memory | null {
    return this.taskDb.run(db => db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null)
  }

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

  recallMemories(agent: string, filter: RecallFilter): Memory[] {
    return this.taskDb.run(db => {
      const conditions = ['(agent = ? OR agent = ?)', "state != 'superseded'"]
      const params: unknown[] = [agent, 'shared']

      if (filter.query) {
        const normalized = this.normalizeContent(filter.query)
        if (normalized.length > 0) {
          const tokens = normalized.split(' ').filter(t => t.length > 0)
          for (const token of tokens) {
            const escaped = token.replace(/%/g, '\\%').replace(/_/g, '\\_')
            conditions.push("LOWER(content) LIKE ? ESCAPE '\\'")
            params.push(`%${escaped}%`)
          }
        }
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

  promoteMemory(id: number): Memory | null {
    return this.taskDb.run(db => db.prepare(`
      UPDATE memories SET agent = 'shared' WHERE id = ? RETURNING *
    `).get(id) as Memory | null)
  }

  pinMemory(id: number): Memory | null {
    return this.taskDb.run(db => db.prepare(`
      UPDATE memories SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ? RETURNING *
    `).get(id) as Memory | null)
  }

  getBootBriefing(agent: string, taskDb: TaskDB): BootBriefing {
    return this.taskDb.run(db => {
      const role = db.prepare(
        `SELECT * FROM memories WHERE agent = ? AND category = 'role' AND pinned = 1 AND state = 'active' ORDER BY quality DESC, importance DESC`
      ).all(agent) as Memory[]

      const topMemories = db.prepare(
        `SELECT * FROM memories WHERE agent = ? AND category != 'role' AND state = 'active' AND quality >= 0.3 ORDER BY quality DESC, importance DESC LIMIT 5`
      ).all(agent) as Memory[]

      const sharedMemories = db.prepare(
        `SELECT * FROM memories WHERE agent = 'shared' AND state = 'active' AND quality >= 0.3 ORDER BY quality DESC, importance DESC LIMIT 5`
      ).all() as Memory[]

      const recentTasks = db.prepare(
        `SELECT * FROM tasks WHERE to_agent = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 5`
      ).all(agent) as Task[]

      return { role, topMemories, sharedMemories, recentTasks }
    })
  }

  getZeroImportanceIds(): number[] {
    return this.taskDb.run(db =>
      (db.prepare('SELECT id FROM memories WHERE importance <= 0 AND pinned = 0').all() as { id: number }[]).map(r => r.id)
    )
  }

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

  decayMemory(id: number, newImportance: number): void {
    this.taskDb.run(db => db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(newImportance, id))
  }

  archiveMemory(id: number): void {
    this.taskDb.run(db => {
      db.prepare(`
        INSERT INTO memory_archive (id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count, classification, quality, state, source_type, evidence, support_count, challenge_count, supersedes_memory_id, last_validated)
        SELECT id, agent, content, category, importance, pinned, source_task_id, created_at, last_accessed, access_count, classification, quality, state, source_type, evidence, support_count, challenge_count, supersedes_memory_id, last_validated FROM memories WHERE id = ?
      `).run(id)
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    })
  }

  getSupersededOlderThan(days: number): number[] {
    return this.taskDb.run(db =>
      (db.prepare(`
        SELECT id FROM memories
        WHERE state = 'superseded'
        AND last_accessed < datetime('now', '-' || ? || ' days')
      `).all(days) as { id: number }[]).map(r => r.id)
    )
  }

  pruneArchive(daysOld: number): number {
    return this.taskDb.run(db => {
      const result = db.prepare(`
        DELETE FROM memory_archive WHERE archived_at < datetime('now', '-' || ? || ' days')
      `).run(daysOld)
      return result.changes
    })
  }

  listAgents(): string[] {
    return this.taskDb.run(db => {
      const rows = db.prepare(
        `SELECT DISTINCT agent FROM memories WHERE agent != 'shared' ORDER BY agent`
      ).all() as { agent: string }[]
      return rows.map(r => r.agent)
    })
  }
}
