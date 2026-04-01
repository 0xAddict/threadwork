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

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath, { create: true })
    this.db.prepare('PRAGMA journal_mode=WAL').run()
    this.db.prepare('PRAGMA busy_timeout=5000').run()
    this.migrate()
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
        classification TEXT NOT NULL DEFAULT 'operational',
        quality REAL NOT NULL DEFAULT 0.6,
        state TEXT NOT NULL DEFAULT 'active',
        source_type TEXT NOT NULL DEFAULT 'manual',
        evidence TEXT,
        support_count INTEGER NOT NULL DEFAULT 1,
        challenge_count INTEGER NOT NULL DEFAULT 0,
        supersedes_memory_id INTEGER REFERENCES memories(id),
        last_validated TEXT,
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
        classification TEXT NOT NULL DEFAULT 'operational',
        quality REAL NOT NULL DEFAULT 0.6,
        state TEXT NOT NULL DEFAULT 'archived',
        source_type TEXT NOT NULL DEFAULT 'manual',
        evidence TEXT,
        support_count INTEGER NOT NULL DEFAULT 1,
        challenge_count INTEGER NOT NULL DEFAULT 0,
        supersedes_memory_id INTEGER,
        last_validated TEXT,
        created_at TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
      CREATE INDEX IF NOT EXISTS idx_memories_agent_importance ON memories(agent, importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
      CREATE INDEX IF NOT EXISTS idx_memories_classification ON memories(classification);
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

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        created_by TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'open',
        final_summary TEXT,
        final_rationale TEXT,
        final_confidence REAL,
        chosen_position_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS decision_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        agent TEXT NOT NULL,
        stance TEXT NOT NULL DEFAULT 'proposal',
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS decision_critiques (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        position_id INTEGER NOT NULL REFERENCES decision_positions(id),
        agent TEXT NOT NULL,
        dimension TEXT NOT NULL DEFAULT 'contrarian',
        summary TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
      CREATE INDEX IF NOT EXISTS idx_decisions_created_by ON decisions(created_by);
      CREATE INDEX IF NOT EXISTS idx_positions_decision ON decision_positions(decision_id);
      CREATE INDEX IF NOT EXISTS idx_positions_agent ON decision_positions(agent);
      CREATE INDEX IF NOT EXISTS idx_critiques_decision ON decision_critiques(decision_id);
      CREATE INDEX IF NOT EXISTS idx_critiques_position ON decision_critiques(position_id);
    `)

    // Add nudge_count column if missing (safe migration for existing DBs)
    try {
      this.db.exec('ALTER TABLE tasks ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0')
    } catch {
      // Column already exists
    }

    const safeAlterStatements = [
      "ALTER TABLE memories ADD COLUMN classification TEXT NOT NULL DEFAULT 'operational'",
      "ALTER TABLE memories ADD COLUMN quality REAL NOT NULL DEFAULT 0.6",
      "ALTER TABLE memories ADD COLUMN state TEXT NOT NULL DEFAULT 'active'",
      "ALTER TABLE memories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'",
      "ALTER TABLE memories ADD COLUMN evidence TEXT",
      "ALTER TABLE memories ADD COLUMN support_count INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE memories ADD COLUMN challenge_count INTEGER NOT NULL DEFAULT 0",
      'ALTER TABLE memories ADD COLUMN supersedes_memory_id INTEGER',
      'ALTER TABLE memories ADD COLUMN last_validated TEXT',
      "ALTER TABLE memory_archive ADD COLUMN classification TEXT NOT NULL DEFAULT 'operational'",
      "ALTER TABLE memory_archive ADD COLUMN quality REAL NOT NULL DEFAULT 0.6",
      "ALTER TABLE memory_archive ADD COLUMN state TEXT NOT NULL DEFAULT 'archived'",
      "ALTER TABLE memory_archive ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'",
      'ALTER TABLE memory_archive ADD COLUMN evidence TEXT',
      "ALTER TABLE memory_archive ADD COLUMN support_count INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE memory_archive ADD COLUMN challenge_count INTEGER NOT NULL DEFAULT 0",
      'ALTER TABLE memory_archive ADD COLUMN supersedes_memory_id INTEGER',
      'ALTER TABLE memory_archive ADD COLUMN last_validated TEXT',
    ]

    for (const statement of safeAlterStatements) {
      try {
        this.db.exec(statement)
      } catch {
        // Column already exists.
      }
    }

    this.db.exec(`
      UPDATE memories
      SET last_validated = COALESCE(last_validated, created_at),
          state = COALESCE(state, 'active'),
          source_type = COALESCE(source_type, 'manual'),
          classification = COALESCE(classification, 'operational');

      UPDATE memory_archive
      SET last_validated = COALESCE(last_validated, created_at),
          state = COALESCE(state, 'archived'),
          source_type = COALESCE(source_type, 'manual'),
          classification = COALESCE(classification, 'operational');
    `)
  }

  createTask(input: CreateTaskInput): Task {
    const stmt = this.db.prepare(`
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
  }

  getTask(id: number): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?')
    return stmt.get(id) as Task | null
  }

  listTasks(filter: ListFilter = {}): Task[] {
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
    return this.db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC`).all(...params) as Task[]
  }

  claimTask(id: number, agent: string): Task | null {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = 'in_progress', claimed_at = datetime('now')
      WHERE id = ? AND to_agent = ? AND status = 'pending'
      RETURNING *
    `)
    return stmt.get(id, agent) as Task | null
  }

  completeTask(id: number, result: string): Task | null {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = 'completed', result = ?, completed_at = datetime('now')
      WHERE id = ? AND status = 'in_progress'
      RETURNING *
    `)
    return stmt.get(result, id) as Task | null
  }

  addNote(taskId: number, fromAgent: string, message: string): Note {
    const stmt = this.db.prepare(`
      INSERT INTO notes (task_id, from_agent, message)
      VALUES (?, ?, ?)
      RETURNING *
    `)
    return stmt.get(taskId, fromAgent, message) as Note
  }

  getNotes(taskId: number): Note[] {
    return this.db.prepare('SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as Note[]
  }

  close(): void {
    this.db.close()
  }
}
