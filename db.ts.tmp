import { Database } from 'bun:sqlite'
import { DB_PATH, SUPERVISION_DEFAULTS, UNCLAIMED_CHECK_SEC } from './config'

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
  nudge_count: number
  // Supervision fields (Sprint 1 — Durable Supervision System)
  parent_task_id: number | null
  kind: string
  supervisor_agent: string | null
  last_heartbeat_at: string | null
  last_progress_at: string | null
  next_check_at: string | null
  heartbeat_timeout_sec: number
  progress_timeout_sec: number
  blocked_at: string | null
  blocked_reason: string | null
  escalation_level: number
  worker_session_id: string | null
  version: number
  is_synthetic: number
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

export interface DelegateTaskInput {
  from: string
  to: string
  description: string
  priority: string
  supervisor_agent: string
  parent_task_id?: number
  heartbeat_timeout_sec?: number
  progress_timeout_sec?: number
  kind?: string
}

export interface UpdateHeartbeatInput {
  taskId: number
  agent: string
  detail?: string
  isProgress?: boolean
  isBlocked?: boolean
  blockedReason?: string
  etaSec?: number
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
      "ALTER TABLE memories ADD COLUMN last_validated TEXT",
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

    // Supervision columns on tasks (Sprint 1 — Durable Supervision System)
    const supervisionColumns = [
      "ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)",
      "ALTER TABLE tasks ADD COLUMN kind TEXT DEFAULT 'task'",
      "ALTER TABLE tasks ADD COLUMN supervisor_agent TEXT",
      "ALTER TABLE tasks ADD COLUMN last_heartbeat_at TEXT",
      "ALTER TABLE tasks ADD COLUMN last_progress_at TEXT",
      "ALTER TABLE tasks ADD COLUMN next_check_at TEXT",
      "ALTER TABLE tasks ADD COLUMN heartbeat_timeout_sec INTEGER DEFAULT 120",
      "ALTER TABLE tasks ADD COLUMN progress_timeout_sec INTEGER DEFAULT 600",
      "ALTER TABLE tasks ADD COLUMN blocked_at TEXT",
      "ALTER TABLE tasks ADD COLUMN blocked_reason TEXT",
      "ALTER TABLE tasks ADD COLUMN escalation_level INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN worker_session_id TEXT",
      "ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 1",
      "ALTER TABLE tasks ADD COLUMN is_synthetic INTEGER DEFAULT 0",
    ]
    for (const sql of supervisionColumns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }

    // Supervision indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_next_check
        ON tasks(next_check_at)
        WHERE next_check_at IS NOT NULL AND status NOT IN ('completed', 'cancelled');

      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

      CREATE INDEX IF NOT EXISTS idx_tasks_supervisor ON tasks(supervisor_agent);
    `)

    // Agent sessions table (Sprint 1 — Durable Supervision System)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL UNIQUE,
        session_id TEXT,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        state TEXT NOT NULL DEFAULT 'unknown',
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)

    // Watchdog lease table (Sprint 1 — Durable Supervision System)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchdog_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        pid INTEGER
      );
    `)

    // Supervision triggers: require supervisor_agent when from_agent != to_agent
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_require_supervision
      BEFORE INSERT ON tasks
      WHEN NEW.from_agent != NEW.to_agent AND NEW.supervisor_agent IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'Delegation requires supervisor_agent when from_agent != to_agent');
      END;
    `)

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_prevent_supervision_removal
      BEFORE UPDATE ON tasks
      WHEN OLD.supervisor_agent IS NOT NULL AND NEW.supervisor_agent IS NULL
        AND OLD.from_agent != OLD.to_agent
      BEGIN
        SELECT RAISE(ABORT, 'Cannot remove supervisor_agent from a delegated task');
      END;
    `)

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

    // Decision record tables (Phase 5a)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        context TEXT,
        opened_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open','positions','critique','finalized','expired','cancelled')),
        finalized_by TEXT,
        outcome TEXT,
        outcome_rationale TEXT,
        expires_at TEXT,
        memory_id INTEGER,
        task_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        finalized_at TEXT
      );

      CREATE TABLE IF NOT EXISTS decision_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        agent TEXT NOT NULL,
        position TEXT NOT NULL,
        rationale TEXT,
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS decision_critiques (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        position_id INTEGER REFERENCES decision_positions(id),
        agent TEXT NOT NULL,
        critique TEXT NOT NULL,
        severity TEXT DEFAULT 'observation'
          CHECK(severity IN ('observation','concern','blocker')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
      CREATE INDEX IF NOT EXISTS idx_decision_positions_decision ON decision_positions(decision_id);
      CREATE INDEX IF NOT EXISTS idx_decision_critiques_decision ON decision_critiques(decision_id);
    `)

    // Debrief daemon tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS debrief_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        tasks_reviewed INTEGER DEFAULT 0,
        memories_reviewed INTEGER DEFAULT 0,
        decision_id INTEGER REFERENCES decisions(id),
        synthesis TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS debrief_locks (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
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

  /**
   * Create a delegated task with full supervision fields.
   * Sets supervisor_agent, next_check_at, heartbeat/progress timeouts, kind, and parent_task_id.
   */
  delegateTask(input: DelegateTaskInput): Task {
    return this.run(db => {
      const hbTimeout = input.heartbeat_timeout_sec ?? SUPERVISION_DEFAULTS.heartbeat_timeout_sec
      const progTimeout = input.progress_timeout_sec ?? SUPERVISION_DEFAULTS.progress_timeout_sec
      const kind = input.kind ?? 'task'

      // If parent_task_id is provided, validate parent exists and is in_progress
      if (input.parent_task_id != null) {
        const parent = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(input.parent_task_id) as { id: number; status: string } | null
        if (!parent) {
          throw new Error(`Parent task #${input.parent_task_id} not found`)
        }
        if (parent.status !== 'in_progress') {
          throw new Error(`Parent task #${input.parent_task_id} is not in_progress (status: ${parent.status})`)
        }
      }

      const stmt = db.prepare(`
        INSERT INTO tasks (
          from_agent, to_agent, description, priority,
          supervisor_agent, kind, parent_task_id,
          heartbeat_timeout_sec, progress_timeout_sec,
          next_check_at
        ) VALUES (
          $from, $to, $description, $priority,
          $supervisor_agent, $kind, $parent_task_id,
          $heartbeat_timeout_sec, $progress_timeout_sec,
          datetime('now', '+' || $unclaimed_check_sec || ' seconds')
        )
        RETURNING *
      `)
      return stmt.get({
        $from: input.from,
        $to: input.to,
        $description: input.description,
        $priority: input.priority,
        $supervisor_agent: input.supervisor_agent,
        $kind: kind,
        $parent_task_id: input.parent_task_id ?? null,
        $heartbeat_timeout_sec: hbTimeout,
        $progress_timeout_sec: progTimeout,
        $unclaimed_check_sec: UNCLAIMED_CHECK_SEC,
      }) as Task
    })
  }

  /**
   * Update heartbeat for a task being worked on.
   * - Always updates last_heartbeat_at
   * - If isProgress, updates last_progress_at
   * - If isBlocked, sets blocked_at and blocked_reason, sets next_check_at to now
   * - Recomputes next_check_at based on heartbeat_timeout_sec (or etaSec if provided)
   * - Increments version
   */
  updateHeartbeat(input: UpdateHeartbeatInput): Task | null {
    return this.run(db => {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId) as Task | null
      if (!task) return null

      // Determine the timeout for next_check_at
      const timeoutSec = input.etaSec ?? task.heartbeat_timeout_sec ?? SUPERVISION_DEFAULTS.heartbeat_timeout_sec

      if (input.isBlocked) {
        // Blocked: set blocked fields and next_check_at to now (for immediate watchdog pickup)
        const stmt = db.prepare(`
          UPDATE tasks SET
            last_heartbeat_at = datetime('now'),
            ${input.isProgress !== false ? "last_progress_at = datetime('now')," : ""}
            blocked_at = datetime('now'),
            blocked_reason = ?,
            next_check_at = datetime('now'),
            version = version + 1
          WHERE id = ?
          RETURNING *
        `)
        return stmt.get(input.blockedReason ?? null, input.taskId) as Task | null
      } else {
        // Not blocked: clear blocked fields if previously set, update heartbeat
        const stmt = db.prepare(`
          UPDATE tasks SET
            last_heartbeat_at = datetime('now'),
            ${input.isProgress !== false ? "last_progress_at = datetime('now')," : ""}
            blocked_at = NULL,
            blocked_reason = NULL,
            next_check_at = datetime('now', '+' || ? || ' seconds'),
            version = version + 1
          WHERE id = ?
          RETURNING *
        `)
        return stmt.get(timeoutSec, input.taskId) as Task | null
      }
    })
  }

  /**
   * Complete a task, but first check for open child tasks.
   * If open children exist, returns an error object with child IDs.
   * Otherwise completes normally.
   */
  completeTaskWithFinalizerCheck(id: number, result: string, agent: string): { task?: Task; error?: string } {
    return this.run(db => {
      // Check for open children
      const openChildren = db.prepare(`
        SELECT id FROM tasks
        WHERE parent_task_id = ? AND status NOT IN ('completed', 'cancelled')
      `).all(id) as { id: number }[]

      if (openChildren.length > 0) {
        const childIds = openChildren.map(c => `#${c.id}`).join(', ')
        return {
          error: `Cannot complete task #${id}: open child tasks [${childIds}]. Complete or cancel them first.`,
        }
      }

      // Complete normally — clear supervision timing fields
      const stmt = db.prepare(`
        UPDATE tasks SET
          status = 'completed',
          result = ?,
          completed_at = datetime('now'),
          next_check_at = NULL,
          blocked_at = NULL,
          blocked_reason = NULL
        WHERE id = ? AND status = 'in_progress' AND to_agent = ?
        RETURNING *
      `)
      const task = stmt.get(result, id, agent) as Task | null

      if (!task) return { error: undefined, task: undefined }
      return { task }
    })
  }

  /**
   * Boss override: force complete with finalizer check.
   */
  forceCompleteTaskWithFinalizerCheck(id: number, result: string): { task?: Task; error?: string } {
    return this.run(db => {
      // Check for open children
      const openChildren = db.prepare(`
        SELECT id FROM tasks
        WHERE parent_task_id = ? AND status NOT IN ('completed', 'cancelled')
      `).all(id) as { id: number }[]

      if (openChildren.length > 0) {
        const childIds = openChildren.map(c => `#${c.id}`).join(', ')
        return {
          error: `Cannot complete task #${id}: open child tasks [${childIds}]. Complete or cancel them first.`,
        }
      }

      const stmt = db.prepare(`
        UPDATE tasks SET
          status = 'completed',
          result = ?,
          completed_at = datetime('now'),
          next_check_at = NULL,
          blocked_at = NULL,
          blocked_reason = NULL
        WHERE id = ? AND status = 'in_progress'
        RETURNING *
      `)
      const task = stmt.get(result, id) as Task | null
      if (!task) return { error: undefined, task: undefined }
      return { task }
    })
  }

  /**
   * Claim a task and also bind it to a session with heartbeat timing.
   */
  claimTaskWithSession(id: number, agent: string, sessionId?: string): Task | null {
    return this.run(db => {
      const hbTimeout = SUPERVISION_DEFAULTS.heartbeat_timeout_sec
      const stmt = db.prepare(`
        UPDATE tasks SET
          status = 'in_progress',
          claimed_at = datetime('now'),
          worker_session_id = ?,
          last_heartbeat_at = datetime('now'),
          last_progress_at = datetime('now'),
          next_check_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ? AND to_agent = ? AND status = 'pending'
        RETURNING *
      `)
      return stmt.get(sessionId ?? null, hbTimeout, id, agent) as Task | null
    })
  }

  /**
   * Get all child tasks of a parent task.
   * @param includeCompleted If false, excludes completed/cancelled children. Default: true.
   */
  getChildTasks(taskId: number, includeCompleted: boolean = true): Task[] {
    return this.run(db => {
      if (includeCompleted) {
        return db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC').all(taskId) as Task[]
      }
      return db.prepare(
        "SELECT * FROM tasks WHERE parent_task_id = ? AND status NOT IN ('completed', 'cancelled') ORDER BY created_at ASC"
      ).all(taskId) as Task[]
    })
  }

  /**
   * Get the lineage chain from a task up to the root (following parent_task_id).
   * Returns [task, parent, grandparent, ...] up to the root.
   */
  getTaskLineage(taskId: number): Task[] {
    return this.run(db => {
      const lineage: Task[] = []
      let currentId: number | null = taskId
      const seen = new Set<number>() // Guard against cycles

      while (currentId != null && !seen.has(currentId)) {
        seen.add(currentId)
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(currentId) as Task | null
        if (!task) break
        lineage.push(task)
        currentId = task.parent_task_id
      }

      return lineage
    })
  }

  /**
   * Create a synthetic sub-agent child task.
   * Used to track Agent tool invocations as durable task rows.
   * The task is immediately set to in_progress (sub-agents start working right away).
   */
  createSubagentTask(input: {
    description: string
    parent_task_id: number
    supervisor_agent: string
    heartbeat_timeout_sec?: number
    progress_timeout_sec?: number
  }): Task {
    return this.run(db => {
      const hbTimeout = input.heartbeat_timeout_sec ?? 180 // Sub-agents get longer heartbeat default
      const progTimeout = input.progress_timeout_sec ?? SUPERVISION_DEFAULTS.progress_timeout_sec

      // Validate parent exists and is in_progress
      const parent = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(input.parent_task_id) as { id: number; status: string } | null
      if (!parent) {
        throw new Error(`Parent task #${input.parent_task_id} not found`)
      }
      if (parent.status !== 'in_progress') {
        throw new Error(`Parent task #${input.parent_task_id} is not in_progress (status: ${parent.status})`)
      }

      const stmt = db.prepare(`
        INSERT INTO tasks (
          from_agent, to_agent, description, priority,
          supervisor_agent, kind, parent_task_id,
          heartbeat_timeout_sec, progress_timeout_sec,
          status, claimed_at,
          last_heartbeat_at, last_progress_at,
          next_check_at,
          is_synthetic
        ) VALUES (
          $from, $to, $description, 'normal',
          $supervisor_agent, 'subagent', $parent_task_id,
          $heartbeat_timeout_sec, $progress_timeout_sec,
          'in_progress', datetime('now'),
          datetime('now'), datetime('now'),
          datetime('now', '+' || $heartbeat_timeout_sec || ' seconds'),
          1
        )
        RETURNING *
      `)
      return stmt.get({
        $from: input.supervisor_agent,
        $to: input.supervisor_agent,
        $description: input.description,
        $supervisor_agent: input.supervisor_agent,
        $parent_task_id: input.parent_task_id,
        $heartbeat_timeout_sec: hbTimeout,
        $progress_timeout_sec: progTimeout,
      }) as Task
    })
  }

  /**
   * Close a synthetic sub-agent task by marking it completed.
   * Clears next_check_at so the watchdog stops monitoring it.
   */
  closeSubagentTask(taskId: number, result: string): Task | null {
    return this.run(db => {
      const stmt = db.prepare(`
        UPDATE tasks SET
          status = 'completed',
          result = ?,
          completed_at = datetime('now'),
          next_check_at = NULL,
          blocked_at = NULL,
          blocked_reason = NULL
        WHERE id = ? AND is_synthetic = 1 AND status = 'in_progress'
        RETURNING *
      `)
      return stmt.get(result, taskId) as Task | null
    })
  }

  /**
   * Cancel a synthetic sub-agent task (e.g., when the sub-agent fails or is interrupted).
   */
  cancelSubagentTask(taskId: number, reason: string): Task | null {
    return this.run(db => {
      const stmt = db.prepare(`
        UPDATE tasks SET
          status = 'cancelled',
          result = ?,
          completed_at = datetime('now'),
          next_check_at = NULL,
          blocked_at = NULL,
          blocked_reason = NULL
        WHERE id = ? AND is_synthetic = 1 AND status = 'in_progress'
        RETURNING *
      `)
      return stmt.get(reason, taskId) as Task | null
    })
  }

  /**
   * Upsert an agent session record.
   */
  upsertAgentSession(agent: string, sessionId: string, state: string): void {
    this.run(db => {
      db.prepare(`
        INSERT INTO agent_sessions (agent, session_id, last_seen_at, state)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(agent) DO UPDATE SET
          session_id = excluded.session_id,
          last_seen_at = datetime('now'),
          state = excluded.state
      `).run(agent, sessionId, state)
    })
  }

  close(): void {
    this.db.close()
  }
}
