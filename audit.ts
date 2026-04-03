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
  private taskDb: TaskDB

  constructor(taskDb: TaskDB) {
    this.taskDb = taskDb
  }

  log(agent: string, action: string, detail?: object, taskId?: number, memoryId?: number): void {
    this.taskDb.run(db =>
      db.prepare(
        'INSERT INTO audit_log (agent, action, detail, task_id, memory_id) VALUES (?, ?, ?, ?, ?)'
      ).run(agent, action, detail ? JSON.stringify(detail) : null, taskId ?? null, memoryId ?? null)
    )
  }

  query(filter: AuditFilter): AuditEntry[] {
    return this.taskDb.run(db => {
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
      return db.prepare(
        `SELECT * FROM audit_log${where} ORDER BY created_at DESC LIMIT ?`
      ).all(...params, limit) as AuditEntry[]
    })
  }

  getAgentActivity(agent: string, minutes: number): AuditEntry[] {
    return this.taskDb.run(db =>
      db.prepare(
        "SELECT * FROM audit_log WHERE agent = ? AND created_at >= datetime('now', '-' || ? || ' minutes') ORDER BY created_at DESC"
      ).all(agent, minutes) as AuditEntry[]
    )
  }
}
