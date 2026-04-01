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
  classification: string
  quality: number
  state: 'active' | 'disputed' | 'superseded' | 'archived'
  source_type: string
  evidence: string | null
  support_count: number
  challenge_count: number
  supersedes_memory_id: number | null
  last_validated: string | null
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
  classification?: string
  quality?: number
  state?: 'active' | 'disputed' | 'superseded'
  source_type?: string
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

const normalizeContent = (content: string): string =>
  content.trim().toLowerCase().replace(/\s+/g, ' ')

const mergeEvidence = (existing: string | null | undefined, incoming: string | null | undefined): string | null => {
  const parts = [existing?.trim(), incoming?.trim()].filter(Boolean) as string[]
  if (parts.length === 0) return null
  return Array.from(new Set(parts)).join('\n---\n')
}

const inferClassification = (input: SaveMemoryInput): string => {
  if (input.pinned || input.category === 'role') return 'foundational'
  if (input.category === 'decision' || input.category === 'calibration') return 'strategic'
  if (input.category === 'task_summary') return 'observational'
  if (input.category === 'learning' || input.category === 'fact' || input.category === 'preference') return 'operational'
  return 'operational'
}

const inferSourceType = (input: SaveMemoryInput): string => {
  if (input.source_type) return input.source_type
  if (input.supersedes_memory_id) return 'supersession'
  if (input.source_task_id) return 'task'
  return 'manual'
}

export class MemoryDB {
  private db: Database

  constructor(taskDb: TaskDB) {
    this.db = (taskDb as any).db
  }

  saveMemory(input: SaveMemoryInput): Memory {
    const classification = input.classification ?? inferClassification(input)
    const quality = Math.max(0.05, Math.min(1, input.quality ?? 0.6))
    const sourceType = inferSourceType(input)
    const normalized = normalizeContent(input.content)

    const existing = this.db.prepare(`
      SELECT * FROM memories
      WHERE agent = ?
        AND category = ?
        AND state != 'superseded'
        AND LOWER(TRIM(content)) = ?
      LIMIT 1
    `).get(
      input.agent,
      input.category,
      normalized,
    ) as Memory | null

    if (existing) {
      return this.db.prepare(`
        UPDATE memories
        SET importance = ?,
            pinned = ?,
            classification = ?,
            quality = ?,
            state = ?,
            source_type = ?,
            evidence = ?,
            support_count = support_count + 1,
            source_task_id = COALESCE(source_task_id, ?),
            supersedes_memory_id = COALESCE(supersedes_memory_id, ?),
            last_accessed = datetime('now'),
            last_validated = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(
        Math.max(existing.importance, input.importance ?? 3),
        existing.pinned || input.pinned ? 1 : 0,
        classification,
        Math.max(existing.quality, quality),
        existing.state === 'disputed' && quality >= 0.75 ? 'active' : existing.state,
        existing.source_type === 'manual' ? sourceType : existing.source_type,
        mergeEvidence(existing.evidence, input.evidence),
        input.source_task_id ?? null,
        input.supersedes_memory_id ?? null,
        existing.id,
      ) as Memory
    }

    return this.db.prepare(`
      INSERT INTO memories (
        agent,
        content,
        category,
        importance,
        pinned,
        source_task_id,
        classification,
        quality,
        state,
        source_type,
        evidence,
        support_count,
        challenge_count,
        supersedes_memory_id,
        last_validated
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, datetime('now'))
      RETURNING *
    `).get(
      input.agent,
      input.content.trim(),
      input.category,
      input.importance ?? 3,
      input.pinned ? 1 : 0,
      input.source_task_id ?? null,
      classification,
      quality,
      input.state ?? 'active',
      sourceType,
      input.evidence ?? null,
      input.supersedes_memory_id ?? null,
    ) as Memory
  }

  getMemory(id: number): Memory | null {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | null
  }

  recallMemories(agent: string, filter: RecallFilter): Memory[] {
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
    const sql = `
      SELECT * FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE WHEN state = 'active' THEN 0 ELSE 1 END,
        importance DESC,
        quality DESC,
        last_accessed DESC
      LIMIT ?
    `
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
      UPDATE memories
      SET agent = 'shared',
          last_validated = datetime('now')
      WHERE id = ?
      RETURNING *
    `).get(id) as Memory | null
  }

  pinMemory(id: number): Memory | null {
    return this.db.prepare(`
      UPDATE memories
      SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END,
          classification = CASE WHEN pinned = 0 THEN 'foundational' ELSE classification END,
          last_validated = datetime('now')
      WHERE id = ?
      RETURNING *
    `).get(id) as Memory | null
  }

  challengeMemory(id: number, reason: string, confidence: number = 0.7): Memory | null {
    const current = this.getMemory(id)
    if (!current) return null

    const normalizedConfidence = Math.max(0.05, Math.min(1, confidence))
    const penalty = Math.min(0.35, Math.max(0.05, normalizedConfidence * 0.2))
    const nextChallengeCount = current.challenge_count + 1
    const nextQuality = Number(Math.max(0.05, current.quality - penalty).toFixed(2))
    const nextState =
      current.state === 'superseded'
        ? current.state
        : nextChallengeCount > current.support_count || nextQuality < 0.45
          ? 'disputed'
          : current.state

    return this.db.prepare(`
      UPDATE memories
      SET challenge_count = ?,
          quality = ?,
          state = ?,
          evidence = ?,
          last_validated = datetime('now')
      WHERE id = ?
      RETURNING *
    `).get(
      nextChallengeCount,
      nextQuality,
      nextState,
      mergeEvidence(current.evidence, `CHALLENGE: ${reason}`),
      id,
    ) as Memory
  }

  supersedeMemory(id: number, input: Omit<SaveMemoryInput, 'agent' | 'category'> & { content: string }): Memory | null {
    const current = this.getMemory(id)
    if (!current) return null

    this.db.prepare(`
      UPDATE memories
      SET state = 'superseded',
          last_validated = datetime('now'),
          evidence = ?
      WHERE id = ?
    `).run(
      mergeEvidence(current.evidence, input.evidence ? `SUPERSEDED: ${input.evidence}` : 'SUPERSEDED'),
      id,
    )

    return this.saveMemory({
      agent: current.agent,
      category: current.category,
      content: input.content,
      importance: input.importance ?? Math.max(current.importance, 3),
      pinned: input.pinned ?? !!current.pinned,
      classification: input.classification ?? current.classification,
      quality: input.quality ?? Math.max(current.quality, 0.7),
      source_type: input.source_type ?? 'supersession',
      evidence: input.evidence,
      supersedes_memory_id: id,
    })
  }

  getBootBriefing(agent: string, taskDb: TaskDB): BootBriefing {
    // Role memories (pinned, category=role) — NO access tracking
    const role = this.db.prepare(
      `SELECT * FROM memories
       WHERE agent = ? AND category = 'role' AND pinned = 1 AND state = 'active'
       ORDER BY importance DESC, quality DESC`
    ).all(agent) as Memory[]

    // Top 5 non-role memories by importance — NO access tracking
    const topMemories = this.db.prepare(
      `SELECT * FROM memories
       WHERE agent = ? AND category != 'role' AND state != 'superseded'
       ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END, importance DESC, quality DESC, COALESCE(last_validated, created_at) DESC
       LIMIT 5`
    ).all(agent) as Memory[]

    // Top 5 shared memories — NO access tracking
    const sharedMemories = this.db.prepare(
      `SELECT * FROM memories
       WHERE agent = 'shared' AND state != 'superseded'
       ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END, importance DESC, quality DESC, COALESCE(last_validated, created_at) DESC
       LIMIT 5`
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
        AND classification != 'foundational'
        AND state != 'superseded'
        AND importance > 0
    `).all() as Memory[]
  }

  decayMemory(id: number, newImportance: number): void {
    this.db.prepare(`
      UPDATE memories
      SET importance = ?,
          last_validated = datetime('now')
      WHERE id = ?
    `).run(newImportance, id)
  }

  archiveMemory(id: number): void {
    this.db.prepare(`
      INSERT INTO memory_archive (
        id,
        agent,
        content,
        category,
        importance,
        pinned,
        source_task_id,
        classification,
        quality,
        state,
        source_type,
        evidence,
        support_count,
        challenge_count,
        supersedes_memory_id,
        last_validated,
        created_at,
        last_accessed,
        access_count
      )
      SELECT
        id,
        agent,
        content,
        category,
        importance,
        pinned,
        source_task_id,
        classification,
        quality,
        CASE WHEN state = 'superseded' THEN 'archived' ELSE state END,
        source_type,
        evidence,
        support_count,
        challenge_count,
        supersedes_memory_id,
        last_validated,
        created_at,
        last_accessed,
        access_count
      FROM memories
      WHERE id = ?
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
