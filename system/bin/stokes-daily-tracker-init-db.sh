#!/bin/bash
# stokes-daily-tracker-init-db.sh — one-shot SQLite journal initialiser
#
# Creates ~/.claude/state/stokes-daily-tracker/journal.db with schema:
#   daily_entries     — one immutable row per calendar day (locked=1 once written)
#   prompts_sent      — record of every wake-prompt message sent to Stokes
#   attempted_edits   — audit trail of blocked edit attempts
#   admin_actions     — audit trail of admin bypass operations
#
# Lock enforced via BEFORE UPDATE/DELETE triggers on daily_entries WHERE locked=1.
# Run once; safe to re-run (CREATE TABLE IF NOT EXISTS).

set -euo pipefail

DB_DIR="$HOME/.claude/state/stokes-daily-tracker"
DB="$DB_DIR/journal.db"

mkdir -p "$DB_DIR"

sqlite3 "$DB" <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ── daily_entries ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT    UNIQUE NOT NULL,          -- YYYY-MM-DD
  self_report  TEXT,
  kairos_summary  TEXT,
  tiptap_summary  TEXT,
  verdict      TEXT,                             -- JSON: {verdict, confidence, ...}
  written_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  locked       INTEGER NOT NULL DEFAULT 0        -- 1 = immutable
);

-- ── prompts_sent ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompts_sent (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT    NOT NULL,
  telegram_msg_id INTEGER,
  sent_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  prompt_text     TEXT
);

-- ── attempted_edits ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attempted_edits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT    NOT NULL DEFAULT (datetime('now')),
  source_chat_id   INTEGER,
  telegram_msg_id  INTEGER,
  attempted_content TEXT,
  blocked_reason   TEXT
);

-- ── admin_actions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL DEFAULT (datetime('now')),
  action     TEXT    NOT NULL,
  target_date TEXT,
  field      TEXT,
  old_value  TEXT,
  new_value  TEXT,
  operator   TEXT    DEFAULT 'admin'
);

-- ── Lock trigger: BEFORE UPDATE ───────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS lock_daily_entries_update
  BEFORE UPDATE ON daily_entries
  FOR EACH ROW
  WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'daily_entries row is locked');
END;

-- ── Lock trigger: BEFORE DELETE ───────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS lock_daily_entries_delete
  BEFORE DELETE ON daily_entries
  FOR EACH ROW
  WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'daily_entries row is locked');
END;
SQL

# Lock down file permissions: only the owner can read/write the DB
chmod 600 "$DB"

echo "journal.db initialised at $DB"
sqlite3 "$DB" ".tables"
echo "Lock triggers:"
sqlite3 "$DB" "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='daily_entries';"
