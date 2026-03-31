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

export interface UpdateTaskInput {
  status?: string
}

export class TaskDB {
  private db: Database

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath)
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

  listTasks(filter?: string, agent?: string): Task[] {
    if (filter === 'mine' && agent) {
      return this.db.prepare('SELECT * FROM tasks WHERE to_agent = ? ORDER BY created_at DESC').all(agent) as Task[]
    }
    if (filter === 'pending') {
      return this.db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at DESC").all() as Task[]
    }
    if (filter === 'completed') {
      return this.db.prepare("SELECT * FROM tasks WHERE status = 'completed' ORDER BY created_at DESC").all() as Task[]
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[]
  }

  claimTask(id: number, agent: string): Task | null {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = 'in_progress', claimed_at = datetime('now')
      WHERE id = ? AND to_agent = ? AND status = 'pending'
      RETURNING *
    `)
    return stmt.get(id, agent) as Task | null
  }

  completeTask(id: number, agent: string, result: string): Task | null {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = 'completed', result = ?, completed_at = datetime('now')
      WHERE id = ? AND to_agent = ? AND status = 'in_progress'
      RETURNING *
    `)
    return stmt.get(result, id, agent) as Task | null
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
