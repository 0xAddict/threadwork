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

    // Task status events table (replaces JSONL status files)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_status_agent_task ON task_status_events(agent, task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_status_created ON task_status_events(created_at);
    `)
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

  completeTask(id: number, result: string, agent: string): Task | null {
    return this.run(db => {
      const stmt = db.prepare(`
        UPDATE tasks SET status = 'completed', result = ?, completed_at = datetime('now')
        WHERE id = ? AND status = 'in_progress' AND to_agent = ?
        RETURNING *
      `)
      return stmt.get(result, id, agent) as Task | null
    })
  }

  /** Boss override: complete any in_progress task regardless of assignee */
  forceCompleteTask(id: number, result: string): Task | null {
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
