-- Down-migration 0010: reverse Autonomous Board P1-WS1 schema additions.
--
-- SQLite supports DROP COLUMN (>= 3.35.0). Each is wrapped per-statement by
-- the runner (try/exec) so a partially-applied migration reverses cleanly.

DROP TABLE IF EXISTS soak_prediction_log;
DROP TABLE IF EXISTS telegram_conversation_state;
DROP TABLE IF EXISTS watcher_heartbeat;

DROP TRIGGER IF EXISTS trg_tasks_updated_at_insert;
DROP TRIGGER IF EXISTS trg_tasks_updated_at;
ALTER TABLE tasks DROP COLUMN updated_at;
ALTER TABLE tasks DROP COLUMN owner;
ALTER TABLE tasks DROP COLUMN reject_count;
ALTER TABLE tasks DROP COLUMN snoozed_until;
ALTER TABLE tasks DROP COLUMN tags;
ALTER TABLE tasks DROP COLUMN classification_rationale;
ALTER TABLE tasks DROP COLUMN classification_score;
ALTER TABLE tasks DROP COLUMN complexity_final;
ALTER TABLE tasks DROP COLUMN complexity_user;
