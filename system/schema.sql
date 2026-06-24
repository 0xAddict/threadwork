-- Threadwork task-board schema (structure only — NO row data)
-- Generated: sqlite3 tasks.db .schema  (captured 2026-06-24T11:04:37Z)
-- Restore a fresh DB:  sqlite3 new-tasks.db < system/schema.sql

CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        from_agent TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE memories (
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
      , classification TEXT DEFAULT 'operational', quality REAL DEFAULT 0.5, state TEXT DEFAULT 'active', source_type TEXT DEFAULT 'agent', evidence TEXT, support_count INTEGER DEFAULT 0, challenge_count INTEGER DEFAULT 0, supersedes_memory_id INTEGER REFERENCES memories(id), last_validated TEXT);
CREATE TABLE memory_archive (
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
      , classification TEXT, quality REAL, state TEXT, source_type TEXT, evidence TEXT, support_count INTEGER DEFAULT 0, challenge_count INTEGER DEFAULT 0, supersedes_memory_id INTEGER, last_validated TEXT);
CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        task_id INTEGER,
        memory_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE task_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE consolidation_locks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        pid INTEGER NOT NULL
      );
CREATE TABLE consolidation_runs (
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
CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL UNIQUE,
        session_id TEXT,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        state TEXT NOT NULL DEFAULT 'unknown',
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      , circuit_state TEXT DEFAULT 'closed', fault_count INTEGER DEFAULT 0, last_fault_at TEXT, last_fault_type TEXT, circuit_opened_at TEXT, cooldown_until TEXT, state_changed_at TEXT, state_source TEXT, current_task_id INTEGER, current_tool TEXT, claude_pid INTEGER);
CREATE TABLE watchdog_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        pid INTEGER
      );
CREATE TABLE decisions (
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
CREATE TABLE decision_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        agent TEXT NOT NULL,
        position TEXT NOT NULL,
        rationale TEXT,
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE decision_critiques (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        position_id INTEGER REFERENCES decision_positions(id),
        agent TEXT NOT NULL,
        critique TEXT NOT NULL,
        severity TEXT DEFAULT 'observation'
          CHECK(severity IN ('observation','concern','blocker')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE debrief_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        tasks_reviewed INTEGER DEFAULT 0,
        memories_reviewed INTEGER DEFAULT 0,
        decision_id INTEGER REFERENCES decisions(id),
        synthesis TEXT,
        error TEXT
      );
CREATE TABLE debrief_locks (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
CREATE TABLE feature_flags (
        flag_name TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
CREATE TABLE progress_events (
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
CREATE TABLE findings (
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
CREATE TABLE artifacts (
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
CREATE TABLE gate_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        task_id INTEGER,
        violation_type TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE managed_bots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          intended_username TEXT NOT NULL,
          display_name TEXT,
          token TEXT,
          bot_id INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          recovered_at TEXT,
          error_log TEXT
        );
CREATE TABLE tw_nudge_debounce (
        agent TEXT PRIMARY KEY,
        last_nudged_at TEXT,
        pending_count INTEGER NOT NULL DEFAULT 0,
        last_urgency TEXT NOT NULL DEFAULT 'normal',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE watchdog_alert_state (
        task_id INTEGER NOT NULL,
        alert_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        last_alerted_at TEXT NOT NULL DEFAULT (datetime('now')),
        fire_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (task_id, alert_type)
      );
CREATE TABLE IF NOT EXISTS "tasks" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL DEFAULT 'web-user',
  to_agent TEXT,                          -- nullable: NULL = backlog/unassigned
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  parent_task_id INTEGER REFERENCES tasks_new(id),
  kind TEXT DEFAULT 'task',
  supervisor_agent TEXT,
  last_heartbeat_at TEXT,
  last_progress_at TEXT,
  next_check_at TEXT,
  heartbeat_timeout_sec INTEGER DEFAULT 120,
  progress_timeout_sec INTEGER DEFAULT 600,
  blocked_at TEXT,
  blocked_reason TEXT,
  escalation_level INTEGER DEFAULT 0,
  worker_session_id TEXT,
  version INTEGER DEFAULT 1,
  is_synthetic INTEGER DEFAULT 0,
  attempt_id INTEGER DEFAULT 0,
  result_finding_id INTEGER,
  stall_miss_count INTEGER NOT NULL DEFAULT 0,
  blocked_on TEXT
, blocked_relay_count INTEGER NOT NULL DEFAULT 0, complexity_user TEXT, complexity_final TEXT, classification_score TEXT, classification_rationale TEXT, tags TEXT, snoozed_until TEXT, reject_count INTEGER NOT NULL DEFAULT 0, owner TEXT, updated_at TEXT, is_addendum INTEGER NOT NULL DEFAULT 0, last_eta_sec INTEGER, prior_status TEXT, archived_at TEXT);
CREATE TABLE tasks_archive (
            id INTEGER PRIMARY KEY,
            from_agent TEXT, to_agent TEXT, description TEXT, priority TEXT,
            status TEXT, result TEXT, created_at TEXT, claimed_at TEXT, completed_at TEXT,
            archived_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
CREATE INDEX idx_memories_agent ON memories(agent);
CREATE INDEX idx_memories_agent_importance ON memories(agent, importance DESC);
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_archive_archived_at ON memory_archive(archived_at);
CREATE INDEX idx_audit_agent ON audit_log(agent);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_task ON audit_log(task_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_status_agent_task ON task_status_events(agent, task_id, created_at);
CREATE INDEX idx_status_created ON task_status_events(created_at);
CREATE INDEX idx_memories_classification ON memories(classification);
CREATE INDEX idx_memories_state ON memories(state);
CREATE INDEX idx_memories_classification_state ON memories(classification, state);
CREATE INDEX idx_memories_last_accessed ON memories(last_accessed);
CREATE INDEX idx_memories_supersedes ON memories(supersedes_memory_id);
CREATE INDEX idx_decisions_status ON decisions(status);
CREATE INDEX idx_decision_positions_decision ON decision_positions(decision_id);
CREATE INDEX idx_decision_critiques_decision ON decision_critiques(decision_id);
CREATE INDEX idx_progress_task ON progress_events(task_id, created_at);
CREATE INDEX idx_progress_type ON progress_events(event_type);
CREATE INDEX idx_progress_agent ON progress_events(agent_id, task_id);
CREATE UNIQUE INDEX idx_findings_dedup
        ON findings(task_id, attempt_id, content_hash)
        WHERE content_hash IS NOT NULL;
CREATE INDEX idx_findings_task ON findings(task_id);
CREATE INDEX idx_findings_type ON findings(finding_type);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE INDEX idx_artifacts_finding ON artifacts(finding_id);
CREATE INDEX idx_violations_agent ON gate_violations(agent_id, created_at);
CREATE INDEX idx_violations_type ON gate_violations(violation_type);
CREATE INDEX idx_managed_bots_username ON managed_bots(intended_username);
CREATE INDEX idx_managed_bots_bot_id ON managed_bots(bot_id);
CREATE INDEX idx_managed_bots_status ON managed_bots(status);
CREATE INDEX idx_tasks_next_check
  ON tasks(next_check_at)
  WHERE next_check_at IS NOT NULL AND status NOT IN ('completed', 'cancelled');
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_supervisor ON tasks(supervisor_agent);
CREATE INDEX idx_agent_sessions_state_changed ON agent_sessions(state_changed_at);
CREATE TRIGGER trg_require_supervision
  BEFORE INSERT ON tasks
  WHEN NEW.to_agent IS NOT NULL
    AND NEW.from_agent != NEW.to_agent
    AND NEW.supervisor_agent IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'Delegation requires supervisor_agent when from_agent != to_agent');
  END;
CREATE TRIGGER trg_prevent_supervision_removal
  BEFORE UPDATE ON tasks
  WHEN OLD.supervisor_agent IS NOT NULL
    AND NEW.supervisor_agent IS NULL
    AND OLD.to_agent IS NOT NULL
    AND OLD.from_agent != OLD.to_agent
  BEGIN
    SELECT RAISE(ABORT, 'Cannot remove supervisor_agent from a delegated task');
  END;
CREATE TABLE watcher_heartbeat (
  watcher_name   TEXT PRIMARY KEY,
  last_beat_at   TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'idle',
  cycle_count    INTEGER NOT NULL DEFAULT 0,
  detail         TEXT,
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE telegram_conversation_state (
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
CREATE INDEX idx_tg_convstate_task   ON telegram_conversation_state(task_id);
CREATE INDEX idx_tg_convstate_status ON telegram_conversation_state(status);
CREATE TABLE soak_prediction_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            INTEGER NOT NULL REFERENCES tasks(id),
  predicted_complexity TEXT,
  actual_complexity    TEXT,
  classification_score TEXT,
  execution_path     TEXT,
  rework_count       INTEGER NOT NULL DEFAULT 0,
  wall_time_sec      INTEGER,
  predicted_at       TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT,
  notes              TEXT
);
CREATE INDEX idx_soak_pred_task ON soak_prediction_log(task_id);
CREATE TRIGGER trg_tasks_updated_at AFTER UPDATE ON tasks FOR EACH ROW WHEN NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at BEGIN UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_tasks_updated_at_insert AFTER INSERT ON tasks FOR EACH ROW WHEN NEW.updated_at IS NULL BEGIN UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TABLE watcher_processed_pings (
      card_id        INTEGER NOT NULL,
      card_revision  INTEGER NOT NULL,
      pinged_at      TEXT NOT NULL DEFAULT (datetime('now')),
      message_id     TEXT,
      PRIMARY KEY (card_id, card_revision)
    );
CREATE TABLE planning_pipeline_state (
      card_id    INTEGER PRIMARY KEY,
      state      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , revision_direction TEXT);
CREATE TABLE pipeline_directives (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id       INTEGER NOT NULL,
      cycle_seq     INTEGER NOT NULL,            -- monotonic per (card,kind); rework cycles
      kind          TEXT    NOT NULL,
      expected_from TEXT    NOT NULL,            -- the tasks.status the consuming transition asserts
      to_status     TEXT,                        -- the tasks.status the consumption sets (NULL = no change)
      nonce_hash    TEXT    NOT NULL,            -- SHA-256(plaintext nonce); the plaintext lives only in the published button/note
      issued_by     TEXT    NOT NULL DEFAULT 'board-watcher',
      issued_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      consumed_at   TEXT,                        -- NULL = OPEN; non-NULL = spent (single-use)
      consumed_note_id INTEGER,                  -- notes.id of the sentinel that consumed it
      superseded_at TEXT,                        -- set when a newer directive invalidates this one
      UNIQUE (card_id, cycle_seq, kind)
    );
CREATE INDEX idx_pd_open
      ON pipeline_directives(card_id, kind)
      WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE TABLE pipeline_cutover (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
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
      ORDER BY s.target
/* v_nudge_metrics_24h(window_start,window_end,target,nudges_fired_24h,nudges_suppressed_24h,nudges_sent_24h,nudges_delivery_failed_24h,agent_nudged_legacy_24h,suppression_rate,delivery_rate,avg_pending_per_fire,max_pending_per_fire) */;
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
      GROUP BY wb.window_start, wb.window_end
/* v_nudge_metrics_24h_total(window_start,window_end,nudges_fired_24h,nudges_suppressed_24h,nudges_sent_24h,nudges_delivery_failed_24h,agent_nudged_legacy_24h,suppression_rate,delivery_rate) */;
