-- Migration 0010: Autonomous Board P1-WS1 — card schema additions + supporting tables
--
-- Companion to PRD.md §6 (Autonomous Kanban Board, locked) and PLAN.md §1-P1.
-- Adds 8 columns to `tasks` (the card schema) plus 3 supporting tables.
--
-- Mirrors the idempotent ALTER pattern from migrations 0008/0009 and the
-- in-process migrate() loop in db.ts (try/exec ADD COLUMN — column-exists
-- errors swallowed). This .sql file is the documentation/parity artifact;
-- db.ts performs the equivalent ALTERs at boot so a running server self-heals.
--
-- Idempotent + reversible: every statement uses IF NOT EXISTS where SQLite
-- supports it; the ADD COLUMN statements are wrapped per-statement in db.ts.
-- See 0010_autonomous_board_p1.down.sql for the reversal.

-- ---- Card schema additions (PRD §6) ----
ALTER TABLE tasks ADD COLUMN complexity_user TEXT;             -- EASY|MEDIUM|COMPLEX, user's pick at create time
ALTER TABLE tasks ADD COLUMN complexity_final TEXT;            -- post-classification class (escalate-only)
ALTER TABLE tasks ADD COLUMN classification_score TEXT;        -- JSON: {"S1":bool,...,"S5":bool,"total":int}
ALTER TABLE tasks ADD COLUMN classification_rationale TEXT;    -- cheap-LLM one-paragraph rationale
ALTER TABLE tasks ADD COLUMN tags TEXT;                        -- JSON array of type tags -> manifest lookup
ALTER TABLE tasks ADD COLUMN snoozed_until TEXT;               -- ISO8601 timestamp; NULL = not snoozed; drives the SLEEP badge
ALTER TABLE tasks ADD COLUMN reject_count INTEGER NOT NULL DEFAULT 0;  -- drives 3-reject fresh-plan rule
ALTER TABLE tasks ADD COLUMN owner TEXT;                       -- sticky worker assignment

-- updated_at + AFTER UPDATE trigger: gives the sync daemon a mutation timestamp
-- that moves on ANY update, including writes that touch ONLY the new card fields
-- (owner/reject_count/complexity_final/tags/...). Without this, a field-only
-- UPDATE moves no timestamp and is invisible to the daemon's high-water-mark
-- outbound selector — so the field never mirrors to Supabase. (Codex red-team C2.2.)
-- updated_at is written as strict ISO8601 (strftime '%Y-%m-%dT%H:%M:%fZ') so it
-- is lexically comparable to the daemon watermark (new Date().toISOString()).
-- datetime('now') would yield a space-separated value that sorts incorrectly
-- against the 'T'-separated watermark and break `updated_at > $ts`.
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
UPDATE tasks SET updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', created_at), strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at IS NULL;
CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
  AFTER UPDATE ON tasks
  FOR EACH ROW
  WHEN NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
  BEGIN
    UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
  END;
-- AFTER INSERT companion: a new row has updated_at NULL and a space-separated
-- created_at that sorts before the ISO8601 watermark, so it would be invisible
-- to outbound sync after the watermark advances. Stamp ISO8601 updated_at on insert.
CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at_insert
  AFTER INSERT ON tasks
  FOR EACH ROW
  WHEN NEW.updated_at IS NULL
  BEGIN
    UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
  END;

-- ---- Supporting table: watcher heartbeat (PRD §6, FR-3) ----
-- One row per watcher process; last_beat_at observed by existing heartbeat infra.
CREATE TABLE IF NOT EXISTS watcher_heartbeat (
  watcher_name   TEXT PRIMARY KEY,                 -- e.g. 'board-watcher'
  last_beat_at   TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'idle',     -- idle|sweeping|processing|stale
  cycle_count    INTEGER NOT NULL DEFAULT 0,
  detail         TEXT,
  metadata       TEXT,                             -- JSON
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Supporting table: Telegram conversation-state (PRD §6; Risk: callback state machine) ----
-- Pending inline-button context per card so async/out-of-order/duplicate
-- callbacks validate against current card state before acting.
CREATE TABLE IF NOT EXISTS telegram_conversation_state (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES tasks(id),
  chat_id        TEXT NOT NULL,                    -- Telegram chat (e.g. 1712539766)
  message_id     TEXT,                             -- Telegram message carrying the inline buttons
  context_kind   TEXT NOT NULL,                    -- intake|plan_approval|review|blocked|research_ask
  pending_action TEXT,                             -- JSON: button set + expected callbacks
  card_revision  INTEGER,                          -- card version the buttons were issued against (staleness check)
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending|answered|expired|superseded
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tg_convstate_task   ON telegram_conversation_state(task_id);
CREATE INDEX IF NOT EXISTS idx_tg_convstate_status ON telegram_conversation_state(status);

-- ---- Supporting table: soak prediction log (PRD §6, §12; FR-20) ----
-- One row per card transit: predicted complexity vs. actual (measured by
-- execution path, rework count, wall time) over the 48h soak window.
CREATE TABLE IF NOT EXISTS soak_prediction_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            INTEGER NOT NULL REFERENCES tasks(id),
  predicted_complexity TEXT,                       -- classifier output (EASY|MEDIUM|COMPLEX)
  actual_complexity    TEXT,                       -- measured from execution path taken
  classification_score TEXT,                       -- JSON snapshot of S1-S5 at predict time
  execution_path     TEXT,                         -- runner|harness-contract|fable-harness
  rework_count       INTEGER NOT NULL DEFAULT 0,
  wall_time_sec      INTEGER,
  predicted_at       TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT,
  notes              TEXT
);
CREATE INDEX IF NOT EXISTS idx_soak_pred_task ON soak_prediction_log(task_id);
