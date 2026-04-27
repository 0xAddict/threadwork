-- Migration 0007: Make to_agent nullable (backlog column support, #232)
-- SQLite requires full table recreation to change column constraints.
-- This migration also updates triggers to handle NULL to_agent correctly.
--
-- Also fixes the latent from_agent NOT NULL issue exposed by web-created tasks
-- (inbound sync path inserts without from_agent).

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- Step 1: Create new table with to_agent nullable
CREATE TABLE tasks_new (
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
  parent_task_id INTEGER REFERENCES tasks(id),
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
);

-- Step 2: Copy all existing data
INSERT INTO tasks_new SELECT * FROM tasks;

-- Step 3: Drop old table
DROP TABLE tasks;

-- Step 4: Rename new table
ALTER TABLE tasks_new RENAME TO tasks;

-- Step 5: Recreate indexes
CREATE INDEX idx_tasks_next_check
  ON tasks(next_check_at)
  WHERE next_check_at IS NOT NULL AND status NOT IN ('completed', 'cancelled');

CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_supervisor ON tasks(supervisor_agent);

-- Step 6: Recreate triggers (updated to handle NULL to_agent)
-- trg_require_supervision: only fires when to_agent is NOT NULL and differs from from_agent
CREATE TRIGGER trg_require_supervision
  BEFORE INSERT ON tasks
  WHEN NEW.to_agent IS NOT NULL
    AND NEW.from_agent != NEW.to_agent
    AND NEW.supervisor_agent IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'Delegation requires supervisor_agent when from_agent != to_agent');
  END;

-- trg_prevent_supervision_removal: same guard, only fires if to_agent is set
CREATE TRIGGER trg_prevent_supervision_removal
  BEFORE UPDATE ON tasks
  WHEN OLD.supervisor_agent IS NOT NULL
    AND NEW.supervisor_agent IS NULL
    AND OLD.to_agent IS NOT NULL
    AND OLD.from_agent != OLD.to_agent
  BEGIN
    SELECT RAISE(ABORT, 'Cannot remove supervisor_agent from a delegated task');
  END;

COMMIT;
PRAGMA foreign_keys = ON;
