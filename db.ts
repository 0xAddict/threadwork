import { Database } from 'bun:sqlite'
import { DB_PATH } from './config'

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

export interface UpdateTaskInput {
  status?: string
}

export class TaskDB {
  private db: Database
  private dbPath: string

  constructor(dbPath: string = DB_PATH) {
    this.dbPath = dbPath
    this.db = this.openDb()
    this.migrate()
  }

  private openDb(): Database {
    const db = new Database(this.dbPath, { create: true })
    db.prepare('PRAGMA journal_mode=WAL').run()
    db.prepare('PRAGMA busy_timeout=5000').run()
    return db
  }

  /** Get the current database handle (used by MemoryDB/AuditLog) */
  getHandle(): Database {
    return this.db
  }

  /** Reconnect if the current handle is broken */
  private reconnect(): void {
    try { this.db.close() } catch {}
    this.db = this.openDb()
  }

  /** Run a callback, retrying once with a fresh connection on disk I/O error */
  run<T>(fn: (db: Database) => T): T {
    try {
      return fn(this.db)
    } catch (err: any) {
      if (err?.message?.includes('disk I/O error')) {
        this.reconnect()
        return fn(this.db)
      }
      throw err
    }
  }

  private migrate(): void {
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
    `)

    // Add nudge_count column if missing (safe migration for existing DBs)
    try {
      this.db.exec('ALTER TABLE tasks ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0')
    } catch {
      // Column already exists
    }
  }

  createTask(input: CreateTaskInput): Task {
    return this.run(db => {
      const stmt = db.prepare(`
        INSERT INTO tasks (from_agent, to_agent, description, priority)
        VALUES ($from, $to, $description, $priority)
        RETURNING *
      `)
      return stmt.get({
        $from: input.from,
        $to: input.to,
        $description: input.description,
        $priority: input.priority,
      }) as Task
    })
  }

  getTask(id: number): Task | null {
    return this.run(db => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null)
  }

  listTasks(filter: ListFilter = {}): Task[] {
    return this.run(db => {
      const conditions: string[] = []
      const params: unknown[] = []

      if (filter.assignee) {
        conditions.push('to_agent = ?')
        params.push(filter.assignee)
      }
      if (filter.status) {
        conditions.push('status = ?')
        params.push(filter.status)
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      return db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC`).all(...params) as Task[]
    })
  }

  claimTask(id: number, agent: string): Task | null {
    return this.run(db => {
      const stmt = db.prepare(`
        UPDATE tasks SET status = 'in_progress', claimed_at = datetime('now')
        WHERE id = ? AND to_agent = ? AND status = 'pending'
        RETURNING *
      `)
      return stmt.get(id, agent) as Task | null
    })
  }

  completeTask(id: number, result: string): Task | null {
    return this.run(db => {
      const stmt = db.prepare(`
        UPDATE tasks SET status = 'completed', result = ?, completed_at = datetime('now')
        WHERE id = ? AND status = 'in_progress'
        RETURNING *
      `)
      return stmt.get(result, id) as Task | null
    })
  }

  addNote(taskId: number, fromAgent: string, message: string): Note {
    return this.run(db => {
      const stmt = db.prepare(`
        INSERT INTO notes (task_id, from_agent, message)
        VALUES (?, ?, ?)
        RETURNING *
      `)
      return stmt.get(taskId, fromAgent, message) as Note
    })
  }

  getNotes(taskId: number): Note[] {
    return this.run(db => db.prepare('SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as Note[])
  }

  close(): void {
    this.db.close()
  }
}
