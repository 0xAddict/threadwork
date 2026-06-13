import { Database } from 'bun:sqlite'
import { DB_PATH, SUPERVISION_DEFAULTS, UNCLAIMED_CHECK_SEC } from './config'

export interface Task {
  id: number
  from_agent: string
  to_agent: string | null
  description: string
  priority: string
  // Card-lifecycle statuses (draft/backlog/review/done) coexist with the core
  // agent-task statuses. #13012 Sub-Sprint C / Item 8a adds 'review' as the
  // terminal target for executor-completed CARD rows (human [Accept] gate);
  // draft/backlog are autonomous-board pre-GO states. Widened from the original
  // 4-value union so card rows typecheck without `as` casts.
  // #13012 Sub-Sprint C2 / Item 4 adds 'parked' — a deliberate-hold state the
  // watchdog SKIPS entirely (no heartbeat-overdue faults, no escalation).
  status:
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'cancelled'
    | 'draft'
    | 'backlog'
    | 'review'
    | 'done'
    | 'parked'
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
  blocked_on: string | null
  escalation_level: number
  worker_session_id: string | null
  version: number
  is_synthetic: number
  // #1624: post-acceptance addendum marker. 1 = this synthetic sub-agent row
  // was spawned under a completed/cancelled parent (a fix shipped after a card
  // was accepted). Addendum rows are excluded from the parent's open-children
  // completion gate and from the watchdog escalation sweep so they never trip
  // L-escalation false positives. Default 0 (normal subagent / task row).
  is_addendum: number
  attempt_id: number
  result_finding_id: number | null
  // #13012 Sub-Sprint B: last non-null eta_sec persisted from write_status.
  // An eta-LESS heartbeat inherits this value for next_check_at instead of
  // snapping to the flat 120s default (false-L3-storm fix). NULL = no eta ever
  // declared (use kind-aware default).
  last_eta_sec: number | null
  // #13012 Sub-Sprint C2 / Item 4: the status held immediately before a park, so
  // unpark_task can restore it verbatim. NULL = never parked. Only meaningful
  // while status='parked' (a fresh park overwrites it; unpark leaves it as a
  // historical breadcrumb).
  prior_status: string | null
  // #13012 Sub-Sprint C / Item 8a: card-lifecycle discriminator. Autonomous-board
  // cards (web-user-created or board-classified, migration 0010 PRD §6) carry a
  // non-null complexity_user (EASY|MEDIUM|COMPLEX user pick). Plain agent tasks
  // leave it NULL. `complete_task` on a CARD row routes to 'review' (human
  // [Accept] gate) instead of jumping to 'completed'. See isCardLifecycleRow().
  complexity_user: string | null
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
  to: string | null
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

export type BlockedOn = 'human' | 'external_api' | 'upstream_task' | 'agent'

export interface UpdateHeartbeatInput {
  taskId: number
  agent: string
  detail?: string
  isProgress?: boolean
  isBlocked?: boolean
  blockedReason?: string
  blockedOn?: BlockedOn
  etaSec?: number
}

export class TaskDB {
  private db: Database
  private dbPath: string
  /**
   * Names of required feature flags that the operator has explicitly set to 0.
   * Populated during migrate() so the supervisor (watchdog) can emit a loud
   * warning over the audit + telegram channel each cycle without re-querying.
   */
  public operatorDisabledFlags: string[] = []

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
      "ALTER TABLE tasks ADD COLUMN blocked_on TEXT",
      "ALTER TABLE tasks ADD COLUMN escalation_level INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN worker_session_id TEXT",
      "ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 1",
      "ALTER TABLE tasks ADD COLUMN is_synthetic INTEGER DEFAULT 0",
    ]
    for (const sql of supervisionColumns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }

    // Phase 0 columns (Sprint 1)
    const phase0Columns = [
      "ALTER TABLE tasks ADD COLUMN attempt_id INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN result_finding_id INTEGER",
    ]
    for (const sql of phase0Columns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }

    // #823: blocked_relay_count for long-block relay cap (watchdog spam fix).
    // Counter is incremented by handleBlocked() each time a BLOCKED relay is
    // sent, and reset to 0 when a heartbeat lands AFTER blocked_at. The
    // watchdog escalates-once-and-stops once the cap is reached.
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN blocked_relay_count INTEGER NOT NULL DEFAULT 0') } catch { /* column already exists */ }

    // Migration 0011 (#1624): is_addendum marker for post-acceptance addenda.
    // A synthetic sub-agent row spawned under a COMPLETED/CANCELLED parent (a
    // fix shipped after the card was accepted) is flagged is_addendum=1 so it is
    // (a) excluded from the parent's open-children completion gate, and
    // (b) excluded from the watchdog escalation sweep — an addendum's parent is
    // already terminal, so a missing heartbeat must NOT page boss. Idempotent
    // ALTER mirroring the 0008/0009/0010 pattern; see
    // migrations/0011_addendum_marker.sql for the documentation/parity artifact.
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN is_addendum INTEGER NOT NULL DEFAULT 0') } catch { /* column already exists */ }

    // Migration 0012 (#13012 Sub-Sprint B): last_eta_sec — persisted last non-null
    // eta so an eta-LESS write_status can INHERIT the prior window instead of
    // snapping next_check_at back to the flat 120s default (the exact bug that
    // fired heartbeat-overdue L3 storms on #13012 itself + all session). Set by
    // updateHeartbeat whenever an explicit etaSec is supplied; read back when a
    // later heartbeat omits etaSec. Idempotent ALTER mirroring the
    // 0008/0009/0010/0011 pattern; see migrations/0012_last_eta_sec.sql for the
    // documentation/parity artifact.
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN last_eta_sec INTEGER') } catch { /* column already exists */ }

    // Migration 0013 (#13012 Sub-Sprint C2 / Item 4): prior_status — the status a
    // task held immediately BEFORE it was parked, so unpark_task can restore it
    // verbatim. A first-class parked state (status='parked') lets an owner
    // deliberately HOLD a task without watchdog fault-accrual or escalation
    // (distinct from in_progress, which gets heartbeat-nagged, and from
    // unclaimed/pending, which gets unclaimed-nagged). park sets
    // prior_status=<current status> + status='parked' + next_check_at=NULL;
    // unpark restores status=prior_status and re-arms next_check_at. NULL = the
    // task has never been parked. Idempotent ALTER mirroring the
    // 0008/0009/0010/0011/0012 pattern; see migrations/0013_parked_state.sql for
    // the documentation/parity artifact.
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN prior_status TEXT') } catch { /* column already exists */ }

    // Migration 0010: Autonomous Board P1-WS1 card schema additions (PRD §6).
    // Idempotent ALTERs (mirror the 0008/0009 pattern). See
    // migrations/0010_autonomous_board_p1.sql for the documentation artifact.
    const autonomousBoardColumns = [
      'ALTER TABLE tasks ADD COLUMN complexity_user TEXT',            // EASY|MEDIUM|COMPLEX, user pick
      'ALTER TABLE tasks ADD COLUMN complexity_final TEXT',           // post-classification (escalate-only)
      'ALTER TABLE tasks ADD COLUMN classification_score TEXT',       // JSON {"S1":bool..."S5":bool,"total":int}
      'ALTER TABLE tasks ADD COLUMN classification_rationale TEXT',   // cheap-LLM paragraph
      'ALTER TABLE tasks ADD COLUMN tags TEXT',                       // JSON array of type tags
      'ALTER TABLE tasks ADD COLUMN snoozed_until TEXT',              // ISO8601; NULL = not snoozed
      'ALTER TABLE tasks ADD COLUMN reject_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE tasks ADD COLUMN owner TEXT',                      // sticky worker assignment
    ]
    for (const sql of autonomousBoardColumns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }

    // Migration 0010: tasks.updated_at + AFTER UPDATE trigger so the sync daemon
    // can detect ANY row mutation — including writes that touch ONLY the new card
    // fields (owner, reject_count, complexity_final, tags, ...), which move no
    // other timestamp. Without this, a field-only UPDATE is invisible to the
    // outbound high-water-mark selector and never mirrors to Supabase.
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT") } catch { /* exists */ }
    // Backfill existing rows so the column is non-null going forward.
    // NOTE: updated_at MUST be lexically comparable to the daemon's watermark
    // (new Date().toISOString(), e.g. 2026-06-10T23:02:12.459Z). SQLite's
    // datetime('now') yields a SPACE-separated value ("2026-06-10 23:02:12")
    // whose space (0x20) sorts BEFORE 'T' (0x54), breaking `updated_at > $ts`
    // string comparison. We therefore write strict ISO8601 via strftime.
    try { this.db.exec("UPDATE tasks SET updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', created_at), strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at IS NULL") } catch { /* ignore */ }
    // Trigger bumps updated_at (ISO8601) on every UPDATE. The WHEN guard prevents
    // infinite recursion: the trigger's own UPDATE sets updated_at to a new
    // value, so NEW.updated_at DISTINCT FROM OLD.updated_at and it does not re-fire.
    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
        AFTER UPDATE ON tasks
        FOR EACH ROW
        WHEN NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
        BEGIN
          UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
        END;
      `)
    } catch { /* trigger exists */ }
    // AFTER INSERT companion (Codex red-team round-2): a freshly inserted row has
    // updated_at = NULL and created_at in SQLite's space-separated format
    // ("2026-06-10 23:06:18"), whose space sorts BEFORE 'T' — so neither column
    // is lexically > the daemon's ISO8601 watermark, and a new task inserted
    // after the watermark advances is INVISIBLE to outbound sync. Stamp every
    // INSERT with an ISO8601 updated_at so new rows always mirror.
    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at_insert
        AFTER INSERT ON tasks
        FOR EACH ROW
        WHEN NEW.updated_at IS NULL
        BEGIN
          UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
        END;
      `)
    } catch { /* trigger exists */ }

    // Migration 0010: Autonomous Board P1-WS1 supporting tables.
    // watcher heartbeat row (FR-3), Telegram conversation-state (callback state
    // machine), and soak prediction log (FR-20, §12). CREATE ... IF NOT EXISTS
    // is inherently idempotent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watcher_heartbeat (
        watcher_name   TEXT PRIMARY KEY,
        last_beat_at   TEXT NOT NULL DEFAULT (datetime('now')),
        status         TEXT NOT NULL DEFAULT 'idle',
        cycle_count    INTEGER NOT NULL DEFAULT 0,
        detail         TEXT,
        metadata       TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS telegram_conversation_state (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id        INTEGER NOT NULL REFERENCES tasks(id),
        chat_id        TEXT NOT NULL,
        message_id     TEXT,
        context_kind   TEXT NOT NULL,
        pending_action TEXT,
        card_revision  INTEGER,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tg_convstate_task   ON telegram_conversation_state(task_id);
      CREATE INDEX IF NOT EXISTS idx_tg_convstate_status ON telegram_conversation_state(status);
      CREATE TABLE IF NOT EXISTS soak_prediction_log (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id              INTEGER NOT NULL REFERENCES tasks(id),
        predicted_complexity TEXT,
        actual_complexity    TEXT,
        classification_score TEXT,
        execution_path       TEXT,
        rework_count         INTEGER NOT NULL DEFAULT 0,
        wall_time_sec        INTEGER,
        predicted_at         TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at          TEXT,
        notes                TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_soak_pred_task ON soak_prediction_log(task_id);
    `)

    // Feature flags table (Sprint 1)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        flag_name TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('blackboard_enabled', 1);
      INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('progress_events_enabled', 1);
      INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('gates_enabled', 1);
    `)

    // Respect operator intent: do NOT auto-flip explicitly-disabled flags.
    // Fresh-deploy safety still works — the INSERT OR IGNORE above seeds new
    // rows at 1, so only an explicit operator downgrade (UPDATE ... enabled=0)
    // can reach this branch. We surface those names via operatorDisabledFlags
    // so the always-on supervisor (watchdog.ts) can emit a loud warning over
    // the same audit + telegram channel used by recoverExpiredCircuits.
    const requiredFlags = ['blackboard_enabled', 'progress_events_enabled', 'gates_enabled']
    const disabled: string[] = []
    for (const flag of requiredFlags) {
      const row = this.db.prepare('SELECT enabled FROM feature_flags WHERE flag_name = ?').get(flag) as { enabled: number } | null
      if (row && !row.enabled) {
        disabled.push(flag)
        // Local-process breadcrumb. Loud channel emission happens in watchdog.
        console.warn(`[task-board] Required feature flag '${flag}' is operator-disabled (enabled=0). Leaving as-is. Watchdog will surface this on the operator channel.`)
      }
    }
    this.operatorDisabledFlags = disabled

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

    // Sprint 5: Gate violations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gate_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        task_id INTEGER,
        violation_type TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_violations_agent ON gate_violations(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_violations_type ON gate_violations(violation_type);
    `)

    // State-contracts migration 0009: state-declaration columns on agent_sessions
    const stateContractCols = [
      'ALTER TABLE agent_sessions ADD COLUMN state_changed_at TEXT',
      'ALTER TABLE agent_sessions ADD COLUMN state_source TEXT',
      'ALTER TABLE agent_sessions ADD COLUMN current_task_id INTEGER',
      'ALTER TABLE agent_sessions ADD COLUMN current_tool TEXT',
      'ALTER TABLE agent_sessions ADD COLUMN claude_pid INTEGER',
    ]
    for (const sql of stateContractCols) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_agent_sessions_state_changed ON agent_sessions(state_changed_at)')
    } catch { /* index already exists */ }
    this.db.exec("UPDATE agent_sessions SET state_changed_at = last_seen_at WHERE state_changed_at IS NULL")
    this.db.exec("INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('heartbeat_v2_enabled', 0)")

    // Sprint 4: Circuit breaker columns on agent_sessions
    const circuitBreakerCols = [
      "ALTER TABLE agent_sessions ADD COLUMN circuit_state TEXT DEFAULT 'closed'",
      "ALTER TABLE agent_sessions ADD COLUMN fault_count INTEGER DEFAULT 0",
      "ALTER TABLE agent_sessions ADD COLUMN last_fault_at TEXT",
      "ALTER TABLE agent_sessions ADD COLUMN last_fault_type TEXT",
      "ALTER TABLE agent_sessions ADD COLUMN circuit_opened_at TEXT",
      "ALTER TABLE agent_sessions ADD COLUMN cooldown_until TEXT",
    ]
    for (const sql of circuitBreakerCols) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }

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

    // Watchdog alert dedup state (#615 Phase 1 — silence repeat-spam alerts)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchdog_alert_state (
        task_id INTEGER NOT NULL,
        alert_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        last_alerted_at TEXT NOT NULL DEFAULT (datetime('now')),
        fire_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (task_id, alert_type)
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

    // Sprint 3: Unified Execution Events — progress_events table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS progress_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        attempt_id INTEGER,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL
          CHECK(event_type IN ('started', 'heartbeat', 'progress', 'finding_written', 'completed', 'failed', 'abandoned')),
        percent INTEGER,
        activity TEXT,
        metrics_json TEXT,
        detail_ref INTEGER REFERENCES findings(finding_id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_progress_task ON progress_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_progress_type ON progress_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_progress_agent ON progress_events(agent_id, task_id);
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

    // Sprint 2: Blackboard — Findings and Artifacts tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        attempt_id INTEGER,
        agent_id TEXT NOT NULL,
        parent_agent_id TEXT,
        finding_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'published', 'superseded')),
        is_final INTEGER NOT NULL DEFAULT 0,
        metrics_json TEXT,
        refs_json TEXT,
        metadata_json TEXT,
        content_hash TEXT,
        priority TEXT DEFAULT 'normal',
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        finding_id INTEGER REFERENCES findings(finding_id),
        attempt_id INTEGER,
        agent_id TEXT NOT NULL,
        uri TEXT NOT NULL,
        mime_type TEXT DEFAULT 'text/plain',
        size_bytes INTEGER,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_dedup
        ON findings(task_id, attempt_id, content_hash)
        WHERE content_hash IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id);
      CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(finding_type);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_finding ON artifacts(finding_id);
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

    // v2-lite watchdog sprint (2026-04-09): nudge debounce table
    // Stores per-agent last-nudged timestamp and pending event counter.
    // Seed one row per known worker agent so tryNudge can upsert cheaply.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tw_nudge_debounce (
        agent TEXT PRIMARY KEY,
        last_nudged_at TEXT,
        pending_count INTEGER NOT NULL DEFAULT 0,
        last_urgency TEXT NOT NULL DEFAULT 'normal',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO tw_nudge_debounce (agent, pending_count, last_urgency)
        VALUES ('boss', 0, 'normal');
      INSERT OR IGNORE INTO tw_nudge_debounce (agent, pending_count, last_urgency)
        VALUES ('steve', 0, 'normal');
      INSERT OR IGNORE INTO tw_nudge_debounce (agent, pending_count, last_urgency)
        VALUES ('sadie', 0, 'normal');
      INSERT OR IGNORE INTO tw_nudge_debounce (agent, pending_count, last_urgency)
        VALUES ('kiera', 0, 'normal');
    `)

    // v2-lite watchdog sprint (2026-04-09): v_nudge_metrics_24h view
    //
    // Summarizes the last 24 hours of nudge behavior from audit_log. Reads
    // rows written by nudge.ts::nudgeAgent: action IN ('nudge_fired',
    // 'nudge_suppressed'), agent='watchdog', detail JSON with keys:
    //   target         — agent being nudged
    //   urgency        — low | normal | high | urgent
    //   reason         — window_elapsed | urgent_bypass | first | debounced | disabled
    //   pending_count  — events collapsed (for fired rows) or accumulated so far (for suppressed)
    //   window_ms_remaining — only on suppressed rows
    //
    // Columns exposed:
    //   window_start, window_end   — 24h window bounds (UTC)
    //   target                     — per-agent breakdown row
    //   nudges_fired_24h           — count of nudge_fired rows for this target
    //   nudges_suppressed_24h      — count of nudge_suppressed rows for this target
    //   suppression_rate           — suppressed / (suppressed + fired), or 0 if denom=0
    //   avg_pending_per_fire       — mean pending_count across fired rows
    //   max_pending_per_fire       — peak coalescing
    //
    // A second view v_nudge_metrics_24h_total aggregates the same columns
    // across ALL targets for the scalar "sprint success criterion" check
    // (suppression_rate >= 0.60).
    //
    // IMPORTANT: SQLite JSON1 is compiled in by default in Bun's bundled
    // sqlite, so json_extract() is safe to use here. If a future build
    // drops JSON1, these views must be replaced with a materialized table.
    this.db.exec(`
      DROP VIEW IF EXISTS v_nudge_metrics_24h;
      CREATE VIEW v_nudge_metrics_24h AS
      WITH window_bounds AS (
        SELECT
          datetime('now', '-24 hours') AS window_start,
          datetime('now') AS window_end
      ),
      scoped AS (
        SELECT
          json_extract(al.detail, '$.target') AS target,
          al.action,
          al.created_at,
          CAST(json_extract(al.detail, '$.pending_count') AS INTEGER) AS pending_count
        FROM audit_log al, window_bounds wb
        WHERE al.action IN ('nudge_fired', 'nudge_suppressed', 'nudge_sent', 'nudge_delivery_failed', 'agent_nudged')
          AND al.created_at >= wb.window_start
      )
      SELECT
        wb.window_start,
        wb.window_end,
        s.target,
        SUM(CASE WHEN s.action = 'nudge_fired' THEN 1 ELSE 0 END) AS nudges_fired_24h,
        SUM(CASE WHEN s.action = 'nudge_suppressed' THEN 1 ELSE 0 END) AS nudges_suppressed_24h,
        -- Sprint #256 gate 5: canonical delivery outcome strings.
        SUM(CASE WHEN s.action = 'nudge_sent' THEN 1 ELSE 0 END) AS nudges_sent_24h,
        SUM(CASE WHEN s.action = 'nudge_delivery_failed' THEN 1 ELSE 0 END) AS nudges_delivery_failed_24h,
        -- Legacy alias kept for metrics continuity with pre-sprint-#256 rows.
        SUM(CASE WHEN s.action = 'agent_nudged' THEN 1 ELSE 0 END) AS agent_nudged_legacy_24h,
        CASE
          WHEN (SUM(CASE WHEN s.action IN ('nudge_fired', 'nudge_suppressed') THEN 1 ELSE 0 END)) = 0 THEN 0.0
          ELSE CAST(SUM(CASE WHEN s.action = 'nudge_suppressed' THEN 1 ELSE 0 END) AS REAL)
             / CAST(SUM(CASE WHEN s.action IN ('nudge_fired', 'nudge_suppressed') THEN 1 ELSE 0 END) AS REAL)
        END AS suppression_rate,
        -- delivery_rate = sent / fired. A dispatcher that's healthy will see this
        -- hover near 1.0. If it dips below 1.0 persistently, the tmux send-keys
        -- layer is failing after the fire decision. The exact bug sprint #256
        -- was diagnosing.
        CASE
          WHEN SUM(CASE WHEN s.action = 'nudge_fired' THEN 1 ELSE 0 END) = 0 THEN 1.0
          ELSE CAST(SUM(CASE WHEN s.action = 'nudge_sent' THEN 1 ELSE 0 END) AS REAL)
             / CAST(SUM(CASE WHEN s.action = 'nudge_fired' THEN 1 ELSE 0 END) AS REAL)
        END AS delivery_rate,
        COALESCE(
          AVG(CASE WHEN s.action = 'nudge_fired' THEN s.pending_count END),
          0.0
        ) AS avg_pending_per_fire,
        COALESCE(
          MAX(CASE WHEN s.action = 'nudge_fired' THEN s.pending_count END),
          0
        ) AS max_pending_per_fire
      FROM scoped s, window_bounds wb
      WHERE s.target IS NOT NULL
      GROUP BY wb.window_start, wb.window_end, s.target
      ORDER BY s.target;

      DROP VIEW IF EXISTS v_nudge_metrics_24h_total;
      CREATE VIEW v_nudge_metrics_24h_total AS
      WITH window_bounds AS (
        SELECT
          datetime('now', '-24 hours') AS window_start,
          datetime('now') AS window_end
      ),
      scoped AS (
        SELECT
          al.action,
          al.created_at
        FROM audit_log al, window_bounds wb
        WHERE al.action IN ('nudge_fired', 'nudge_suppressed', 'nudge_sent', 'nudge_delivery_failed', 'agent_nudged')
          AND al.created_at >= wb.window_start
      )
      SELECT
        wb.window_start,
        wb.window_end,
        SUM(CASE WHEN s.action = 'nudge_fired' THEN 1 ELSE 0 END) AS nudges_fired_24h,
        SUM(CASE WHEN s.action = 'nudge_suppressed' THEN 1 ELSE 0 END) AS nudges_suppressed_24h,
        SUM(CASE WHEN s.action = 'nudge_sent' THEN 1 ELSE 0 END) AS nudges_sent_24h,
        SUM(CASE WHEN s.action = 'nudge_delivery_failed' THEN 1 ELSE 0 END) AS nudges_delivery_failed_24h,
        SUM(CASE WHEN s.action = 'agent_nudged' THEN 1 ELSE 0 END) AS agent_nudged_legacy_24h,
        CASE
          WHEN SUM(CASE WHEN s.action IN ('nudge_fired', 'nudge_suppressed') THEN 1 ELSE 0 END) = 0 THEN 0.0
          ELSE CAST(SUM(CASE WHEN s.action = 'nudge_suppressed' THEN 1 ELSE 0 END) AS REAL)
             / CAST(SUM(CASE WHEN s.action IN ('nudge_fired', 'nudge_suppressed') THEN 1 ELSE 0 END) AS REAL)
        END AS suppression_rate,
        -- delivery_rate uses fired as denominator (every fire should produce a sent)
        CASE
          WHEN SUM(CASE WHEN s.action = 'nudge_fired' THEN 1 ELSE 0 END) = 0 THEN 1.0
          ELSE CAST(SUM(CASE WHEN s.action = 'nudge_sent' THEN 1 ELSE 0 END) AS REAL)
             / CAST(SUM(CASE WHEN s.action = 'nudge_fired' THEN 1 ELSE 0 END) AS REAL)
        END AS delivery_rate
      FROM scoped s, window_bounds wb
      GROUP BY wb.window_start, wb.window_end;
    `)

  }

  createTask(input: CreateTaskInput): Task {
    return this.run(db => {
      // Auto-infer supervisor_agent when delegating (from != to, and to_agent is set)
      const supervisorAgent = (input.to !== null && input.from !== input.to) ? input.from : null
      const stmt = db.prepare(`
        INSERT INTO tasks (from_agent, to_agent, description, priority, supervisor_agent)
        VALUES ($from, $to, $description, $priority, $supervisor_agent)
        RETURNING *
      `)
      return stmt.get({
        $from: input.from,
        $to: input.to ?? null,
        $description: input.description,
        $priority: input.priority,
        $supervisor_agent: supervisorAgent,
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

      // #13012 Sub-Sprint B / Item 1 — eta_sec INHERITANCE + kind-aware default.
      //
      // BUG being fixed: previously this snapped to
      //   input.etaSec ?? task.heartbeat_timeout_sec ?? 120
      // so an eta-LESS mid-build write_status reset next_check_at to the flat
      // 120s default even when the task had earlier declared eta_sec=900 → the
      // task was judged overdue ~120s later → false heartbeat-overdue L3 storm
      // (the exact failure that fired on #13012 itself + all session).
      //
      // New precedence for the (non-blocked) next_check_at window:
      //   1. explicit input.etaSec wins (and is persisted into last_eta_sec);
      //   2. else INHERIT task.last_eta_sec (the last non-null eta) — the long
      //      window survives an eta-less heartbeat;
      //   3. else a kind-aware DEFAULT keyed off the last-known block kind:
      //      human/external_api/upstream_task → long window; agent/null → short
      //      (the task's heartbeat_timeout_sec, default 120s) — NOT a flat 120s
      //      for everything.
      const KIND_DEFAULT_LONG_SEC = 172800 // 48h — human/external_api/upstream_task
      const shortDefaultSec = task.heartbeat_timeout_sec ?? SUPERVISION_DEFAULTS.heartbeat_timeout_sec
      const kind = task.blocked_on
      const kindDefaultSec =
        (kind === 'human' || kind === 'external_api' || kind === 'upstream_task')
          ? KIND_DEFAULT_LONG_SEC
          : shortDefaultSec
      const timeoutSec = input.etaSec ?? task.last_eta_sec ?? kindDefaultSec

      // Persist an explicitly-supplied eta so a LATER eta-less heartbeat can
      // inherit it (clause 2 above). COALESCE-style: only overwrite when an
      // explicit etaSec is present; an eta-less heartbeat leaves last_eta_sec
      // untouched. Applied in BOTH branches below.
      const persistEta = input.etaSec != null
      const etaToPersist = input.etaSec ?? null

      if (input.isBlocked) {
        // blocked_on determines next_check_at behavior:
        //   agent | null → immediate watchdog pickup (existing 600s BLOCKED_TTL)
        //   human | external_api | upstream_task → explicit etaSec or 48h default
        const blockedOn = input.blockedOn ?? null
        const isLongBlock = blockedOn === 'human' || blockedOn === 'external_api' || blockedOn === 'upstream_task'
        const DEFAULT_LONG_BLOCK_SEC = 172800 // 48h
        const checkDelaySec = isLongBlock ? (input.etaSec ?? DEFAULT_LONG_BLOCK_SEC) : 0

        const stmt = db.prepare(`
          UPDATE tasks SET
            last_heartbeat_at = datetime('now'),
            ${input.isProgress !== false ? "last_progress_at = datetime('now')," : ""}
            blocked_at = datetime('now'),
            blocked_reason = ?,
            blocked_on = ?,
            ${persistEta ? "last_eta_sec = ?," : ""}
            next_check_at = datetime('now', '+' || ? || ' seconds'),
            version = version + 1
          WHERE id = ?
          RETURNING *
        `)
        const blockedParams: (string | number | null)[] = [input.blockedReason ?? null, blockedOn]
        if (persistEta) blockedParams.push(etaToPersist)
        blockedParams.push(checkDelaySec, input.taskId)
        return stmt.get(...blockedParams) as Task | null
      } else {
        // Not blocked: clear blocked fields if previously set, update heartbeat.
        //
        // #13012 Sub-Sprint B / Item 3 (write-time half): reset escalation_level
        // to 0 when a GENUINE heartbeat/progress lands, so recovery resets at
        // write time — not only at the next watchdog pass (Sub-Sprint A's
        // watchdog.ts setHealthy is the read-time complement). Gated on
        // isProgress !== false to match the existing progress semantics: a
        // no-progress bare heartbeat (progress=false) must NOT clear an
        // in-flight escalation, mirroring how last_progress_at is only bumped on
        // real progress. Scoped to the non-blocked branch — a blocked heartbeat
        // is not recovery.
        const isProgressUpdate = input.isProgress !== false
        const stmt = db.prepare(`
          UPDATE tasks SET
            last_heartbeat_at = datetime('now'),
            ${isProgressUpdate ? "last_progress_at = datetime('now')," : ""}
            ${isProgressUpdate ? "escalation_level = 0," : ""}
            ${persistEta ? "last_eta_sec = ?," : ""}
            blocked_at = NULL,
            blocked_reason = NULL,
            next_check_at = datetime('now', '+' || ? || ' seconds'),
            version = version + 1
          WHERE id = ?
          RETURNING *
        `)
        const nbParams: (string | number | null)[] = []
        if (persistEta) nbParams.push(etaToPersist)
        nbParams.push(timeoutSec, input.taskId)
        const updated = stmt.get(...nbParams) as Task | null

        // Decay fault_count on successful heartbeat (bounded at 0, not a full reset).
        // S2.1 parity: subagent tasks carry to_agent = supervisor (parent). Since subagent
        // faults do NOT charge the parent's fault_count (see watchdog.handleHeartbeatOverdue),
        // subagent heartbeats must NOT decay the parent either — otherwise the parent's
        // circuit walks downward on subagent activity without having walked upward.
        if (updated && task.kind !== 'subagent') {
          db.prepare(`
            UPDATE agent_sessions SET fault_count = MAX(0, COALESCE(fault_count, 0) - 1) WHERE agent = ?
          `).run(task.to_agent)
        }

        return updated
      }
    })
  }

  /**
   * Complete a task, but first check for open child tasks.
   * If open children exist, returns an error object with child IDs.
   * Otherwise completes normally.
   */
  completeTaskWithFinalizerCheck(id: number, result: string, agent: string): { task?: Task; error?: string; autoClosedChildren?: number[] } {
    return this.run(db => {
      // Check for open children
      // #1624: exclude is_addendum=1 rows. A post-acceptance addendum runs under
      // an already-terminal parent and must NOT block any (re-)completion path —
      // an open addendum is not a blocking child.
      const openChildren = db.prepare(`
        SELECT id, is_synthetic FROM tasks
        WHERE parent_task_id = ? AND status NOT IN ('completed', 'cancelled')
        AND is_addendum = 0
      `).all(id) as { id: number; is_synthetic: number }[]

      // Auto-close synthetic (sub-agent) children — the Agent tool has returned
      const autoClosedIds: number[] = []
      const nonSyntheticOpen: number[] = []
      for (const child of openChildren) {
        if (child.is_synthetic) {
          db.prepare(`
            UPDATE tasks SET status = 'completed', result = 'Auto-closed: parent task completed',
              completed_at = datetime('now'), next_check_at = NULL
            WHERE id = ? AND status = 'in_progress'
          `).run(child.id)
          autoClosedIds.push(child.id)
        } else {
          nonSyntheticOpen.push(child.id)
        }
      }

      if (nonSyntheticOpen.length > 0) {
        const childIds = nonSyntheticOpen.map(c => `#${c}`).join(', ')
        return {
          error: `Cannot complete task #${id}: open child tasks [${childIds}]. Complete or cancel them first.`,
        }
      }

      // #13012 Sub-Sprint C / Item 8a — card-vs-task TERMINAL semantics.
      //
      // completeTaskWithFinalizerCheck historically set status='completed'
      // UNCONDITIONALLY. For a board CARD (complexity_user IS NOT NULL — see
      // isCardLifecycleRow) that BYPASSES the human review gate: #1781 showed
      // Kiera's complete_task flipping a card straight to 'completed', which the
      // dashboard buckets as DONE — the card showed DONE on Gwei's board WITHOUT
      // his [Accept]. Cards must route executor-completion to 'review' (awaiting
      // human accept); ONLY the accept path reaches 'completed'. Plain agent
      // tasks (complexity_user NULL) still complete directly, unchanged.
      //
      // SCOPE (this batch = the terminal/review-GATE only): we decide the TARGET
      // status here. The execute→review ADVANCE transition (the [Accept] button /
      // ping affordance that moves review→completed) is Steve's #13007 (item 8d,
      // coordinated split — board-noted). This branch deliberately stops at
      // 'review'; #13007 owns the advance out of it.
      const targetRow = db.prepare(
        'SELECT complexity_user FROM tasks WHERE id = ?'
      ).get(id) as Pick<Task, 'complexity_user'> | null
      const isCard = targetRow != null && this.isCardLifecycleRow(targetRow)
      const terminalStatus = isCard ? 'review' : 'completed'

      // Complete normally — clear supervision timing fields. For a card the
      // terminal status is 'review' (human-accept gate, not done); completed_at
      // is still stamped so the row leaves the active supervision window and the
      // watchdog stops tracking it (next_check_at NULL) while it awaits accept.
      const stmt = db.prepare(`
        UPDATE tasks SET
          status = ?,
          result = ?,
          completed_at = datetime('now'),
          next_check_at = NULL,
          blocked_at = NULL,
          blocked_reason = NULL
        WHERE id = ? AND status = 'in_progress' AND to_agent = ?
        RETURNING *
      `)
      const task = stmt.get(terminalStatus, result, id, agent) as Task | null

      if (!task) return { error: undefined, task: undefined }
      return { task, autoClosedChildren: autoClosedIds.length > 0 ? autoClosedIds : undefined }
    })
  }

  /**
   * Boss override: force complete with finalizer check.
   */
  forceCompleteTaskWithFinalizerCheck(id: number, result: string): { task?: Task; error?: string; autoClosedChildren?: number[] } {
    return this.run(db => {
      // Check for open children — auto-close synthetic ones
      // #1624: exclude is_addendum=1 rows. A post-acceptance addendum runs under
      // an already-terminal parent and must NOT block any (re-)completion path —
      // an open addendum is not a blocking child.
      const openChildren = db.prepare(`
        SELECT id, is_synthetic FROM tasks
        WHERE parent_task_id = ? AND status NOT IN ('completed', 'cancelled')
        AND is_addendum = 0
      `).all(id) as { id: number; is_synthetic: number }[]

      const autoClosedIds: number[] = []
      const nonSyntheticOpen: number[] = []
      for (const child of openChildren) {
        if (child.is_synthetic) {
          db.prepare(`
            UPDATE tasks SET status = 'completed', result = 'Auto-closed: parent task completed',
              completed_at = datetime('now'), next_check_at = NULL
            WHERE id = ? AND status = 'in_progress'
          `).run(child.id)
          autoClosedIds.push(child.id)
        } else {
          nonSyntheticOpen.push(child.id)
        }
      }

      if (nonSyntheticOpen.length > 0) {
        const childIds = nonSyntheticOpen.map(c => `#${c}`).join(', ')
        return {
          error: `Cannot complete task #${id}: open child tasks [${childIds}]. Complete or cancel them first.`,
        }
      }

      // #13012 Sub-Sprint C / Item 8a — same card→review gate on the boss force
      // path. The review gate is about Gwei's human [Accept] and is independent
      // of WHO completes, so a card force-completed by boss must also land in
      // 'review', not 'completed'. Plain tasks complete directly (unchanged).
      const targetRow = db.prepare(
        'SELECT complexity_user FROM tasks WHERE id = ?'
      ).get(id) as Pick<Task, 'complexity_user'> | null
      const isCard = targetRow != null && this.isCardLifecycleRow(targetRow)
      const terminalStatus = isCard ? 'review' : 'completed'

      const stmt = db.prepare(`
        UPDATE tasks SET
          status = ?,
          result = ?,
          completed_at = datetime('now'),
          next_check_at = NULL,
          blocked_at = NULL,
          blocked_reason = NULL
        WHERE id = ? AND status = 'in_progress'
        RETURNING *
      `)
      const task = stmt.get(terminalStatus, result, id) as Task | null
      if (!task) return { error: undefined, task: undefined }
      return { task, autoClosedChildren: autoClosedIds.length > 0 ? autoClosedIds : undefined }
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
          next_check_at = datetime('now', '+' || ? || ' seconds'),
          attempt_id = COALESCE(attempt_id, 0) + 1
        WHERE id = ? AND to_agent = ? AND status = 'pending'
        RETURNING *
      `)
      return stmt.get(sessionId ?? null, hbTimeout, id, agent) as Task | null
    })
  }

  // ===========================================================================
  // #13012 Sub-Sprint C — Card state-machine + lifecycle tools (C1: 6,7,8a,8b)
  // ===========================================================================

  /**
   * #13012 Sub-Sprint C / Item 8a — card-lifecycle discriminator.
   *
   * A "board CARD" (the autonomous-board lifecycle row Gwei reviews) is
   * distinguished from a plain agent task by a non-null `complexity_user`. That
   * column is set ONLY by the autonomous-board ingestion path (web app /
   * classification, migration 0010 PRD §6) — never by create_task/delegate_task,
   * which produce plain agent tasks. Verified against prod: every web-user card
   * and every board-classified row (incl. #1781, the canonical 8a incident)
   * carries complexity_user; all plain agent/subagent tasks leave it NULL. (kind
   * is only 'task'/'subagent' and there is NO sync_source column, so
   * complexity_user is the reliable seam.)
   */
  isCardLifecycleRow(task: Pick<Task, 'complexity_user'>): boolean {
    return task.complexity_user != null && task.complexity_user !== ''
  }

  /**
   * #13012 Sub-Sprint C / Item 6 — assign/reassign a task to an agent.
   *
   * Closes the NULL-pool gap (5 strikes incl #1599/#1608): a card created
   * unassigned (to_agent=NULL) can never be claimed (claimTaskWithSession needs
   * to_agent=agent) or completed — a roach motel. This sets to_agent AND
   * supervisor_agent so the resulting row is a FULLY-CONSISTENT assignable row:
   *   - to_agent: who will claim/own it (so claim's WHERE to_agent=? matches).
   *   - supervisor_agent: the watchdog/escalation trigger needs supervisor set
   *     (delegated tasks carry supervisor; trg_require_supervision aborts an
   *     INSERT where from_agent!=to_agent AND supervisor IS NULL). This is an
   *     UPDATE so the trigger does not fire, but we set supervisor anyway so the
   *     watchdog can track it exactly like a delegated row. Mirrors what
   *     delegateTask sets (supervisor = the assigner).
   *
   * Idempotent-safe reassign: works on an already-assigned task too (changes
   * to_agent + re-supervisor). Only operates on non-terminal rows
   * (pending/draft/in_progress/backlog) — terminal rows are not reassignable.
   *
   * @param supervisor defaults to the assigner. trg_prevent_supervision_removal
   *   forbids nulling an existing supervisor on a delegated row, so we never
   *   pass NULL here.
   * @returns the updated row, or null if the task is missing/terminal.
   */
  assignTask(taskId: number, toAgent: string, supervisor: string): Task | null {
    return this.run(db => {
      const stmt = db.prepare(`
        UPDATE tasks SET
          to_agent = ?,
          supervisor_agent = ?,
          version = version + 1
        WHERE id = ?
          AND status NOT IN ('completed', 'cancelled', 'done')
        RETURNING *
      `)
      return stmt.get(toAgent, supervisor, taskId) as Task | null
    })
  }

  /**
   * #13012 Sub-Sprint C / Item 7 — GO transition (draft/approved → in_progress).
   *
   * claim_task rejects status='draft' (its WHERE requires status='pending'), so a
   * card approved via [Plan now]+GO had no legit tool path into in_progress — the
   * builder had to flip status via guarded SQLite UPDATE. This transitions an
   * approved draft (or pending) card into in_progress, setting the SAME
   * supervision fields claim would (claimed_at, heartbeat/progress timestamps,
   * next_check_at, attempt_id) so the row is properly armed for the watchdog.
   *
   * Guards preserved (NOT bypassed):
   *   - Requires a non-null to_agent (an unassigned card must be assign_task'd
   *     FIRST — Item 6 — so it has an owner; otherwise the watchdog has nobody to
   *     supervise and claim could never have run either).
   *   - Only transitions from draft/pending (a held/parked/terminal/in_progress
   *     row is rejected — no silent re-arm).
   *
   * @returns updated row, or null if not found / wrong status / unassigned.
   */
  transitionToInProgress(taskId: number, sessionId?: string): Task | null {
    return this.run(db => {
      const hbTimeout = SUPERVISION_DEFAULTS.heartbeat_timeout_sec
      const stmt = db.prepare(`
        UPDATE tasks SET
          status = 'in_progress',
          claimed_at = datetime('now'),
          worker_session_id = ?,
          last_heartbeat_at = datetime('now'),
          last_progress_at = datetime('now'),
          next_check_at = datetime('now', '+' || ? || ' seconds'),
          attempt_id = COALESCE(attempt_id, 0) + 1,
          version = version + 1
        WHERE id = ?
          AND status IN ('draft', 'pending')
          AND to_agent IS NOT NULL
        RETURNING *
      `)
      return stmt.get(sessionId ?? null, hbTimeout, taskId) as Task | null
    })
  }

  /**
   * #13012 Sub-Sprint C2 / Item 4 — PARK a task (deliberate hold).
   *
   * Today both "claim-and-idle" (an owner deliberately holding an in_progress
   * task) and "unclaimed" (a pending task nobody picked up) get nagged by the
   * watchdog — the former via heartbeat-overdue escalation, the latter via the
   * unclaimed-task sweep. A first-class parked state lets an owner deliberately
   * hold a task WITHOUT fault accrual or escalation: the watchdog SKIPS
   * status='parked' rows in both its due-task selection gate and its unclaimed
   * sweep (see watchdog.ts).
   *
   * park saves the CURRENT status into prior_status and flips status='parked',
   * then NULLs next_check_at so the durable due-time loop can never re-pick it
   * (belt-and-suspenders alongside the status gate). Only non-terminal,
   * not-already-parked rows can be parked. Returns the updated row, or null if
   * the task is missing / terminal / already parked.
   *
   * Does NOT touch supervisor_agent (so trg_prevent_supervision_removal never
   * fires) and does NOT touch any circuit-breaker / fault-count state.
   */
  parkTask(taskId: number): Task | null {
    return this.run(db => {
      const stmt = db.prepare(`
        UPDATE tasks SET
          prior_status = status,
          status = 'parked',
          next_check_at = NULL,
          version = version + 1
        WHERE id = ?
          AND status NOT IN ('completed', 'cancelled', 'done', 'parked')
        RETURNING *
      `)
      return stmt.get(taskId) as Task | null
    })
  }

  /**
   * #13012 Sub-Sprint C2 / Item 4 — UNPARK a task (resume from hold).
   *
   * Restores status = prior_status (the state captured at park time). If the
   * restored status is 'in_progress', the row is re-armed for watchdog
   * supervision (fresh heartbeat/progress timestamps + next_check_at) so the
   * resumed task is tracked exactly as a live claim would be — a parked task
   * resuming work must not be born already-overdue. For any other restored
   * status (pending/draft/backlog/...) next_check_at stays NULL (those states
   * are surfaced via their own sweeps, not the due-time loop). Only operates on
   * a row currently status='parked'. Returns the updated row, or null if the
   * task is missing or not parked.
   *
   * Falls back to 'pending' if prior_status is somehow NULL (defensive; a parked
   * row always has prior_status set by parkTask).
   */
  unparkTask(taskId: number): Task | null {
    return this.run(db => {
      const hbTimeout = SUPERVISION_DEFAULTS.heartbeat_timeout_sec
      const stmt = db.prepare(`
        UPDATE tasks SET
          status = COALESCE(prior_status, 'pending'),
          last_heartbeat_at = CASE WHEN COALESCE(prior_status, 'pending') = 'in_progress'
            THEN datetime('now') ELSE last_heartbeat_at END,
          last_progress_at = CASE WHEN COALESCE(prior_status, 'pending') = 'in_progress'
            THEN datetime('now') ELSE last_progress_at END,
          next_check_at = CASE WHEN COALESCE(prior_status, 'pending') = 'in_progress'
            THEN datetime('now', '+' || ? || ' seconds') ELSE NULL END,
          version = version + 1
        WHERE id = ? AND status = 'parked'
        RETURNING *
      `)
      return stmt.get(hbTimeout, taskId) as Task | null
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
   *
   * #1624 — post-acceptance addenda: when `is_addendum` is true, the parent may
   * be COMPLETED or CANCELLED (a fix shipped after the card was accepted). The
   * row is flagged is_addendum=1, the description is prefixed `[addendum to #N]`,
   * and next_check_at is left NULL so the watchdog never picks it up (its parent
   * is already terminal — a missing heartbeat must not page boss). When
   * `is_addendum` is false (default) the in_progress-parent requirement is
   * UNCHANGED, preserving the current refusal behavior for completed parents.
   *
   * #13012 Sub-Sprint C2 / Item 5 — PRE-GO PREP rows: when `kind` is 'prep' the
   * row records prep work done BEFORE a task goes GO (transition to in_progress).
   * spawn_subagent normally rejects a draft/un-GO'd parent (parent must be
   * in_progress), so pre-GO prep was invisible to read_status/get_children. A
   * prep row relaxes the parent-status requirement to also accept the PRE-GO
   * states (draft/pending/backlog) AS WELL AS in_progress, is flagged
   * kind='prep' + is_synthetic=1 (so the watchdog selection gate's existing
   * COALESCE(is_synthetic,0)=0 / kind!='subagent' predicate already excludes it —
   * we additionally exclude kind='prep' explicitly), and is labeled "[prep to
   * #N]" for get_children visibility. next_check_at is NULL (prep is not
   * heartbeat-supervised — its visibility is read_status + get_children, not the
   * due-time loop). Prep is mutually exclusive with addendum.
   */
  createSubagentTask(input: {
    description: string
    parent_task_id: number
    supervisor_agent: string
    heartbeat_timeout_sec?: number
    progress_timeout_sec?: number
    is_addendum?: boolean
    kind?: 'subagent' | 'prep'
  }): Task {
    return this.run(db => {
      const hbTimeout = input.heartbeat_timeout_sec ?? 180 // Sub-agents get longer heartbeat default
      const progTimeout = input.progress_timeout_sec ?? SUPERVISION_DEFAULTS.progress_timeout_sec
      const isAddendum = input.is_addendum === true
      const isPrep = input.kind === 'prep'

      if (isPrep && isAddendum) {
        throw new Error('A row cannot be both kind=prep and is_addendum (prep is PRE-GO; addendum is POST-acceptance).')
      }

      // Validate parent exists. For a normal subagent the parent must be
      // in_progress (unchanged). For an addendum the parent must be terminal
      // (completed|cancelled) — addenda only make sense AFTER acceptance; a
      // still-running parent should use a normal subagent row. For a PREP row
      // the parent may be PRE-GO (draft/pending/backlog) OR in_progress — the
      // whole point is to make work visible BEFORE the GO transition that
      // spawn_subagent would otherwise require.
      const parent = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(input.parent_task_id) as { id: number; status: string } | null
      if (!parent) {
        throw new Error(`Parent task #${input.parent_task_id} not found`)
      }
      if (isAddendum) {
        if (parent.status !== 'completed' && parent.status !== 'cancelled') {
          throw new Error(`Addendum parent #${input.parent_task_id} is ${parent.status}, not completed/cancelled. Use a normal subagent row (addendum:false) for an in-progress parent.`)
        }
      } else if (isPrep) {
        const prepOk = ['draft', 'pending', 'backlog', 'in_progress'].includes(parent.status)
        if (!prepOk) {
          throw new Error(`Prep parent #${input.parent_task_id} is ${parent.status}; prep rows attach to a PRE-GO (draft/pending/backlog) or in_progress parent, not a terminal one.`)
        }
      } else if (parent.status !== 'in_progress') {
        throw new Error(`Parent task #${input.parent_task_id} is not in_progress (status: ${parent.status})`)
      }

      // Telegram/team-group + get_children visibility: label addenda + prep rows.
      const description = isAddendum
        ? `[addendum to #${input.parent_task_id}] ${input.description}`
        : isPrep
        ? `[prep to #${input.parent_task_id}] ${input.description}`
        : input.description

      // Row kind/status: a PREP row is kind='prep', status='pending' (it is NOT a
      // claim — it is a visibility breadcrumb for pre-GO work) and next_check_at
      // NULL (never heartbeat-supervised). Addendum + normal subagent rows are
      // kind='subagent', status='in_progress'. Addendum: next_check_at NULL
      // (parent terminal). Normal: armed for heartbeat supervision.
      const rowKind = isPrep ? 'prep' : 'subagent'
      const rowStatus = isPrep ? 'pending' : 'in_progress'
      const armNextCheck = !isPrep && !isAddendum
      const stmt = db.prepare(`
        INSERT INTO tasks (
          from_agent, to_agent, description, priority,
          supervisor_agent, kind, parent_task_id,
          heartbeat_timeout_sec, progress_timeout_sec,
          status, claimed_at,
          last_heartbeat_at, last_progress_at,
          next_check_at,
          is_synthetic, is_addendum
        ) VALUES (
          $from, $to, $description, 'normal',
          $supervisor_agent, $kind, $parent_task_id,
          $heartbeat_timeout_sec, $progress_timeout_sec,
          $status, ${isPrep ? 'NULL' : "datetime('now')"},
          ${isPrep ? 'NULL' : "datetime('now')"}, ${isPrep ? 'NULL' : "datetime('now')"},
          ${armNextCheck ? "datetime('now', '+' || $heartbeat_timeout_sec || ' seconds')" : 'NULL'},
          1, $is_addendum
        )
        RETURNING *
      `)
      return stmt.get({
        $from: input.supervisor_agent,
        $to: input.supervisor_agent,
        $description: description,
        $supervisor_agent: input.supervisor_agent,
        $parent_task_id: input.parent_task_id,
        $heartbeat_timeout_sec: hbTimeout,
        $progress_timeout_sec: progTimeout,
        $is_addendum: isAddendum ? 1 : 0,
        $kind: rowKind,
        $status: rowStatus,
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


  /**
   * Declare the agent's current operational state (spec §5 step 3).
   *
   * Priority: mcp(3) > hook(2) > heartbeat(1) > boot(0).
   * A lower-priority source cannot overwrite a fresher higher-priority row
   * within the same state_changed_at second. Stale rows (>1s old) can always
   * be overwritten regardless of priority.
   *
   * Pass state=undefined for touch-only (refreshes state_changed_at without
   * changing state — used by write_status to act as a keepalive).
   */
  declareAgentState(
    agent: string,
    state: string | undefined,
    source: 'mcp' | 'hook' | 'heartbeat' | 'boot',
    opts: { taskId?: number; tool?: string; pid?: number } = {}
  ): void {
    const PRIORITY: Record<string, number> = { mcp: 3, hook: 2, heartbeat: 1, boot: 0 }
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')

    this.run(db => {
      const existing = db.prepare(
        'SELECT state, state_source, state_changed_at FROM agent_sessions WHERE agent = ?'
      ).get(agent) as { state: string; state_source: string; state_changed_at: string | null } | null

      if (state === undefined) {
        // Touch-only: refresh timestamp without changing state
        if (!existing) return
        db.prepare(
          "UPDATE agent_sessions SET state_changed_at = ?, last_seen_at = ? WHERE agent = ?"
        ).run(now, now, agent)
        return
      }

      if (existing) {
        const incomingPriority = PRIORITY[source] ?? 0
        const existingPriority = PRIORITY[existing.state_source] ?? 0
        const ageMs = existing.state_changed_at
          ? Date.now() - new Date(existing.state_changed_at.replace(' ', 'T') + 'Z').getTime()
          : Infinity

        // Lower priority cannot overwrite a fresher higher-priority row (within 1 second)
        if (incomingPriority < existingPriority && ageMs < 1000) return
      }

      db.prepare(`
        INSERT INTO agent_sessions (agent, state, state_changed_at, state_source, current_task_id, current_tool, claude_pid, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent) DO UPDATE SET
          state            = excluded.state,
          state_changed_at = excluded.state_changed_at,
          state_source     = excluded.state_source,
          current_task_id  = COALESCE(excluded.current_task_id, agent_sessions.current_task_id),
          current_tool     = excluded.current_tool,
          claude_pid       = COALESCE(excluded.claude_pid, agent_sessions.claude_pid),
          last_seen_at     = excluded.last_seen_at
      `).run(
        agent,
        state,
        now,
        source,
        opts.taskId ?? null,
        opts.tool ?? null,
        opts.pid ?? null,
        now
      )
    })
  }

  isFeatureEnabled(flagName: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM feature_flags WHERE flag_name = ?').get(flagName) as any
    return row ? !!row.enabled : false
  }

  setFeatureFlag(flagName: string, enabled: boolean): void {
    this.db.prepare('INSERT OR REPLACE INTO feature_flags (flag_name, enabled) VALUES (?, ?)').run(flagName, enabled ? 1 : 0)
  }


  // ── Sprint 2: Blackboard Findings Store ──

  writeFinding(input: {
    task_id: number
    finding_type: string
    summary: string
    agent_id: string
    attempt_id?: number
    parent_agent_id?: string
    status?: string
    is_final?: boolean
    metrics_json?: string
    refs_json?: string
    metadata_json?: string
    priority?: string
    expires_at?: string
  }): { finding_id: number } | { error: string } {
    if (!this.isFeatureEnabled('blackboard_enabled')) {
      return { error: 'Blackboard is disabled (feature flag blackboard_enabled=0). Enable it first.' }
    }
    if (input.summary.length > 1000) {
      return { error: `Summary exceeds 1000 chars (got ${input.summary.length})` }
    }
    return this.run(db => {
      // Compute content hash for dedup
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(input.summary)
      const contentHash = hasher.digest('hex').slice(0, 16)

      // Check for duplicate
      const existing = db.prepare(
        'SELECT finding_id FROM findings WHERE task_id = ? AND attempt_id = ? AND content_hash = ?'
      ).get(input.task_id, input.attempt_id ?? null, contentHash) as { finding_id: number } | null
      if (existing) {
        return { finding_id: existing.finding_id }
      }

      const stmt = db.prepare(`
        INSERT INTO findings (
          task_id, attempt_id, agent_id, parent_agent_id, finding_type,
          summary, status, is_final, metrics_json, refs_json, metadata_json,
          content_hash, priority, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING finding_id
      `)
      const row = stmt.get(
        input.task_id,
        input.attempt_id ?? null,
        input.agent_id,
        input.parent_agent_id ?? null,
        input.finding_type,
        input.summary,
        input.status ?? 'draft',
        input.is_final ? 1 : 0,
        input.metrics_json ?? null,
        input.refs_json ?? null,
        input.metadata_json ?? null,
        contentHash,
        input.priority ?? 'normal',
        input.expires_at ?? null,
      ) as { finding_id: number }
      return { finding_id: row.finding_id }
    })
  }

  readFindings(input: {
    task_id: number
    finding_type?: string
    is_final?: boolean
    limit?: number
  }): any[] {
    if (!this.isFeatureEnabled('blackboard_enabled')) {
      return []
    }
    return this.run(db => {
      const conditions = ['task_id = ?']
      const params: any[] = [input.task_id]
      if (input.finding_type) {
        conditions.push('finding_type = ?')
        params.push(input.finding_type)
      }
      if (input.is_final !== undefined) {
        conditions.push('is_final = ?')
        params.push(input.is_final ? 1 : 0)
      }
      const where = conditions.join(' AND ')
      const limit = input.limit ?? 50
      return db.prepare(
        `SELECT finding_id, task_id, attempt_id, agent_id, finding_type, summary, status, is_final, priority, created_at
         FROM findings WHERE ${where} ORDER BY created_at DESC LIMIT ?`
      ).all(...params, limit) as any[]
    })
  }

  readFindingRaw(findingId: number): any | null {
    if (!this.isFeatureEnabled('blackboard_enabled')) {
      return null
    }
    return this.run(db => {
      const finding = db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId) as any | null
      if (!finding) return null
      const artifacts = db.prepare('SELECT * FROM artifacts WHERE finding_id = ?').all(findingId) as any[]
      return { ...finding, artifacts }
    })
  }

  writeArtifact(input: {
    task_id: number
    content: string
    agent_id: string
    mime_type?: string
    attempt_id?: number
    finding_id?: number
    expires_at?: string
  }): { artifact_id: number; uri: string } | { error: string } {
    if (!this.isFeatureEnabled('blackboard_enabled')) {
      return { error: 'Blackboard is disabled (feature flag blackboard_enabled=0). Enable it first.' }
    }
    return this.run(db => {
      const fs = require('fs')
      const path = require('path')
      const artifactsDir = path.join(path.dirname(this.dbPath), 'artifacts', String(input.task_id))
      fs.mkdirSync(artifactsDir, { recursive: true })

      // Compute hash
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(input.content)
      const contentHash = hasher.digest('hex').slice(0, 16)

      // Determine extension from mime type
      const ext = (input.mime_type ?? 'text/plain').includes('json') ? '.json'
        : (input.mime_type ?? '').includes('html') ? '.html'
        : '.txt'

      // Insert to get artifact_id first
      const stmt = db.prepare(`
        INSERT INTO artifacts (
          task_id, finding_id, attempt_id, agent_id, uri, mime_type, size_bytes, content_hash, expires_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)
        RETURNING artifact_id
      `)
      const row = stmt.get(
        input.task_id,
        input.finding_id ?? null,
        input.attempt_id ?? null,
        input.agent_id,
        input.mime_type ?? 'text/plain',
        Buffer.byteLength(input.content, 'utf8'),
        contentHash,
        input.expires_at ?? null,
      ) as { artifact_id: number }

      const filename = `${row.artifact_id}${ext}`
      const filePath = path.join(artifactsDir, filename)
      fs.writeFileSync(filePath, input.content, 'utf8')

      // Update uri
      db.prepare('UPDATE artifacts SET uri = ? WHERE artifact_id = ?').run(filePath, row.artifact_id)

      return { artifact_id: row.artifact_id, uri: filePath }
    })
  }

  // ── Sprint 6: DB Hygiene + Hardening ──

  runHygiene(dryRun: boolean = true): {
    archived_tasks: number
    pruned_events: number
    expired_artifacts: number
    compressed_findings: number
    vacuumed: boolean
  } {
    return this.run(db => {
      const result = {
        archived_tasks: 0,
        pruned_events: 0,
        expired_artifacts: 0,
        compressed_findings: 0,
        vacuumed: false,
      }

      // 1. Archive completed tasks older than 14 days
      const oldTasks = db.prepare(`
        SELECT * FROM tasks
        WHERE status IN ('completed', 'cancelled')
        AND completed_at < datetime('now', '-14 days')
      `).all() as any[]
      result.archived_tasks = oldTasks.length

      if (!dryRun && oldTasks.length > 0) {
        // Create tasks_archive if not exists
        db.exec(`
          CREATE TABLE IF NOT EXISTS tasks_archive (
            id INTEGER PRIMARY KEY,
            from_agent TEXT, to_agent TEXT, description TEXT, priority TEXT,
            status TEXT, result TEXT, created_at TEXT, claimed_at TEXT, completed_at TEXT,
            archived_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `)
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO tasks_archive (id, from_agent, to_agent, description, priority, status, result, created_at, claimed_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const t of oldTasks) {
          insertStmt.run(t.id, t.from_agent, t.to_agent, t.description, t.priority, t.status, t.result, t.created_at, t.claimed_at, t.completed_at)
        }
        db.prepare("DELETE FROM tasks WHERE status IN ('completed', 'cancelled') AND completed_at < datetime('now', '-14 days')").run()
      }

      // 2. Prune progress_events older than 14 days
      const oldEvents = db.prepare("SELECT COUNT(*) as cnt FROM progress_events WHERE created_at < datetime('now', '-14 days')").get() as { cnt: number }
      result.pruned_events = oldEvents.cnt
      if (!dryRun && oldEvents.cnt > 0) {
        db.prepare("DELETE FROM progress_events WHERE created_at < datetime('now', '-14 days')").run()
      }

      // 3. Clean up expired artifacts
      const expiredArtifacts = db.prepare("SELECT COUNT(*) as cnt FROM artifacts WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").get() as { cnt: number }
      result.expired_artifacts = expiredArtifacts.cnt
      if (!dryRun && expiredArtifacts.cnt > 0) {
        // Get URIs to delete files
        const artifacts = db.prepare("SELECT artifact_id, uri FROM artifacts WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").all() as any[]
        for (const a of artifacts) {
          try { require('fs').unlinkSync(a.uri) } catch { /* file may not exist */ }
        }
        db.prepare("DELETE FROM artifacts WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run()
      }

      // 4. Compress old findings (mark as archived summary-only, clear large JSON fields)
      const oldFindings = db.prepare("SELECT COUNT(*) as cnt FROM findings WHERE created_at < datetime('now', '-7 days') AND metrics_json IS NOT NULL").get() as { cnt: number }
      result.compressed_findings = oldFindings.cnt
      if (!dryRun && oldFindings.cnt > 0) {
        db.prepare("UPDATE findings SET metrics_json = NULL, refs_json = NULL, metadata_json = NULL WHERE created_at < datetime('now', '-7 days') AND metrics_json IS NOT NULL").run()
      }

      // 5. Vacuum (only on explicit non-dry-run)
      if (!dryRun) {
        try {
          db.exec('VACUUM')
          result.vacuumed = true
        } catch { /* VACUUM can fail if in transaction */ }
      }

      return result
    })
  }

  getDbStats(): Record<string, { row_count: number; oldest?: string; newest?: string }> {
    return this.run(db => {
      const tables = ['tasks', 'notes', 'memories', 'findings', 'artifacts', 'progress_events',
        'gate_violations', 'audit_log', 'task_status_events', 'agent_sessions']
      const stats: Record<string, { row_count: number; oldest?: string; newest?: string }> = {}

      for (const table of tables) {
        try {
          const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number }
          const oldest = db.prepare(`SELECT MIN(created_at) as ts FROM ${table}`).get() as { ts: string | null }
          const newest = db.prepare(`SELECT MAX(created_at) as ts FROM ${table}`).get() as { ts: string | null }
          stats[table] = {
            row_count: count.cnt,
            oldest: oldest.ts ?? undefined,
            newest: newest.ts ?? undefined,
          }
        } catch {
          stats[table] = { row_count: 0 }
        }
      }

      // DB file size
      try {
        const fs = require('fs')
        const stat = fs.statSync(this.dbPath)
        stats['_db_file'] = { row_count: Math.round(stat.size / 1024) } // KB
      } catch {}

      return stats
    })
  }

  // ── Sprint 5: Communication Gates ──

  recordViolation(agentId: string, violationType: string, detail: string, taskId?: number): number {
    return this.run(db => {
      const row = db.prepare(`
        INSERT INTO gate_violations (agent_id, task_id, violation_type, detail)
        VALUES (?, ?, ?, ?)
        RETURNING id
      `).get(agentId, taskId ?? null, violationType, detail) as { id: number }
      return row.id
    })
  }

  getViolations(input: { agent_id?: string; last_n?: number }): any[] {
    return this.run(db => {
      const conditions: string[] = []
      const params: any[] = []
      if (input.agent_id) {
        conditions.push('agent_id = ?')
        params.push(input.agent_id)
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const limit = input.last_n ?? 50
      return db.prepare(
        `SELECT * FROM gate_violations ${where} ORDER BY created_at DESC LIMIT ?`
      ).all(...params, limit) as any[]
    })
  }

  getRecentViolationCount(agentId: string, windowHours: number = 24): number {
    return this.run(db => {
      const row = db.prepare(`
        SELECT COUNT(*) as cnt FROM gate_violations
        WHERE agent_id = ? AND created_at > datetime('now', '-' || ? || ' hours')
      `).get(agentId, windowHours) as { cnt: number }
      return row.cnt
    })
  }

  isQuarantined(agentId: string): boolean {
    if (!this.isFeatureEnabled('gates_enabled')) return false
    const count = this.getRecentViolationCount(agentId, 24)
    if (count < 5) return false

    // Check if 4 hours have passed since the last violation (auto-recovery)
    const lastViolation = this.run(db =>
      db.prepare('SELECT created_at FROM gate_violations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agentId) as { created_at: string } | null
    )
    if (lastViolation) {
      const lastTime = new Date(lastViolation.created_at + 'Z').getTime()
      const fourHoursMs = 4 * 60 * 60 * 1000
      if (Date.now() - lastTime > fourHoursMs) return false // Auto-recovery
    }
    return true
  }

  // ── Sprint 4: Circuit Breakers ──

  readonly FAULT_THRESHOLD = 3
  readonly COOLDOWN_SEC = 300 // 5 minutes

  getCircuitState(agent: string): { circuit_state: string; fault_count: number; cooldown_until: string | null } | null {
    return this.run(db => {
      return db.prepare(
        'SELECT circuit_state, fault_count, cooldown_until FROM agent_sessions WHERE agent = ?'
      ).get(agent) as { circuit_state: string; fault_count: number; cooldown_until: string | null } | null
    })
  }

  /**
   * Watchdog alert dedup. Returns true if the alert should fire, false if it
   * should be suppressed because an identical payload fired within cooldownSec.
   * Always upserts the state row on a true return so transitions are picked up.
   * (#615 Phase 1)
   */
  shouldAlert(taskId: number, alertType: string, payload: unknown, cooldownSec = 1800): boolean {
    return this.run(db => {
      const hash = String(Bun.hash(JSON.stringify(payload ?? null)))
      const existing = db.prepare(
        'SELECT payload_hash, last_alerted_at FROM watchdog_alert_state WHERE task_id = ? AND alert_type = ?'
      ).get(taskId, alertType) as { payload_hash: string; last_alerted_at: string } | undefined

      if (existing && existing.payload_hash === hash) {
        const lastAt = new Date(existing.last_alerted_at + 'Z').getTime()
        const ageSec = (Date.now() - lastAt) / 1000
        if (ageSec < cooldownSec) return false
      }

      db.prepare(`
        INSERT INTO watchdog_alert_state (task_id, alert_type, payload_hash, last_alerted_at, fire_count)
        VALUES (?, ?, ?, datetime('now'), 1)
        ON CONFLICT (task_id, alert_type) DO UPDATE SET
          payload_hash = excluded.payload_hash,
          last_alerted_at = datetime('now'),
          fire_count = fire_count + 1
      `).run(taskId, alertType, hash)
      return true
    })
  }

  recordFault(agent: string, faultType: string): { circuit_state: string; fault_count: number } {
    return this.run(db => {
      // Increment fault count, saturating at FAULT_THRESHOLD + 1.
      // #13012 FIX (C): without a cap, an abandoned in_progress task (stale
      // heartbeat, live session) re-charges a fault every watchdog tick and the
      // counter climbs unbounded into the hundreds (observed 499/500). The cap
      // keeps the metric legible and bounds the blast radius; the open-circuit
      // check below still fires at the threshold, and the decay path keeps one
      // tick of headroom (MAX(0, fault_count-1)).
      db.prepare(`
        UPDATE agent_sessions SET
          fault_count = MIN(COALESCE(fault_count, 0) + 1, ?),
          last_fault_at = datetime('now'),
          last_fault_type = ?
        WHERE agent = ?
      `).run(this.FAULT_THRESHOLD + 1, faultType, agent)

      const row = db.prepare('SELECT fault_count, circuit_state FROM agent_sessions WHERE agent = ?').get(agent) as any
      if (!row) return { circuit_state: 'closed', fault_count: 0 }

      // Check if we should open the circuit
      if (row.fault_count >= this.FAULT_THRESHOLD && row.circuit_state !== 'open') {
        db.prepare(`
          UPDATE agent_sessions SET
            circuit_state = 'open',
            circuit_opened_at = datetime('now'),
            cooldown_until = datetime('now', '+' || ? || ' seconds')
          WHERE agent = ?
        `).run(this.COOLDOWN_SEC, agent)
        return { circuit_state: 'open', fault_count: row.fault_count }
      }

      return { circuit_state: row.circuit_state ?? 'closed', fault_count: row.fault_count }
    })
  }

  tryHalfOpen(agent: string): boolean {
    return this.run(db => {
      const row = db.prepare(
        'SELECT circuit_state, cooldown_until FROM agent_sessions WHERE agent = ?'
      ).get(agent) as any
      if (!row || row.circuit_state !== 'open') return false

      // Check if cooldown has elapsed
      if (row.cooldown_until) {
        const cooldownTime = new Date(row.cooldown_until + 'Z').getTime()
        if (Date.now() < cooldownTime) return false
      }

      // Transition to half_open
      db.prepare("UPDATE agent_sessions SET circuit_state = 'half_open' WHERE agent = ?").run(agent)
      return true
    })
  }

  closeCircuit(agent: string): void {
    this.run(db => {
      db.prepare(`
        UPDATE agent_sessions SET
          circuit_state = 'closed',
          fault_count = 0,
          circuit_opened_at = NULL,
          cooldown_until = NULL
        WHERE agent = ?
      `).run(agent)
    })
  }

  reopenCircuit(agent: string): void {
    this.run(db => {
      db.prepare(`
        UPDATE agent_sessions SET
          circuit_state = 'open',
          cooldown_until = datetime('now', '+' || ? || ' seconds')
        WHERE agent = ?
      `).run(this.COOLDOWN_SEC, agent)
    })
  }

  isCircuitOpen(agent: string): boolean {
    const state = this.getCircuitState(agent)
    return state?.circuit_state === 'open'
  }

  // ── Sprint 3: Unified Execution Events ──

  private progressThrottleCache = new Map<number, number>() // task_id -> last event timestamp ms

  reportProgress(input: {
    task_id: number
    agent_id: string
    event_type: string
    percent?: number
    activity?: string
    metrics_json?: string
    attempt_id?: number
    detail_ref?: number
  }): { event_id: number } | { throttled: true; next_allowed_in_sec: number } | { error: string } {
    if (!this.isFeatureEnabled('progress_events_enabled')) {
      return { error: 'Progress events disabled (feature flag progress_events_enabled=0).' }
    }

    // 30s throttle per task (skip for started/completed/failed/abandoned which are lifecycle events)
    const lifecycleEvents = new Set(['started', 'completed', 'failed', 'abandoned'])
    if (!lifecycleEvents.has(input.event_type)) {
      const lastTime = this.progressThrottleCache.get(input.task_id) ?? 0
      const now = Date.now()
      const throttleSec = 30
      const elapsed = (now - lastTime) / 1000
      if (elapsed < throttleSec) {
        return { throttled: true, next_allowed_in_sec: Math.ceil(throttleSec - elapsed) }
      }
      this.progressThrottleCache.set(input.task_id, now)
    }

    return this.run(db => {
      const stmt = db.prepare(`
        INSERT INTO progress_events (task_id, attempt_id, agent_id, event_type, percent, activity, metrics_json, detail_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING event_id
      `)
      const row = stmt.get(
        input.task_id,
        input.attempt_id ?? null,
        input.agent_id,
        input.event_type,
        input.percent ?? null,
        input.activity ?? null,
        input.metrics_json ?? null,
        input.detail_ref ?? null,
      ) as { event_id: number }
      return { event_id: row.event_id }
    })
  }

  getProgress(input: {
    task_id: number
    last_n?: number
    event_type?: string
  }): any[] {
    if (!this.isFeatureEnabled('progress_events_enabled')) {
      return []
    }
    return this.run(db => {
      const conditions = ['task_id = ?']
      const params: any[] = [input.task_id]
      if (input.event_type) {
        conditions.push('event_type = ?')
        params.push(input.event_type)
      }
      const where = conditions.join(' AND ')
      const limit = input.last_n ?? 50
      return db.prepare(
        `SELECT * FROM progress_events WHERE ${where} ORDER BY created_at DESC LIMIT ?`
      ).all(...params, limit) as any[]
    })
  }

  /** Emit a completion event to progress_events when a task completes */
  emitCompletionEvent(taskId: number, agentId: string, attemptId?: number): void {
    if (!this.isFeatureEnabled('progress_events_enabled')) return
    try {
      this.run(db => {
        db.prepare(
          `INSERT INTO progress_events (task_id, attempt_id, agent_id, event_type, percent, activity)
           VALUES (?, ?, ?, 'completed', 100, 'Task completed')`
        ).run(taskId, attemptId ?? null, agentId)
      })
    } catch {
      // Never block completion for a progress event failure
    }
  }

  close(): void {
    this.db.close()
  }
}
