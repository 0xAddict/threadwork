-- Reverse migration 0009: drop state-contract columns and feature flag
--
-- SQLite ALTER TABLE DROP COLUMN requires version 3.35+.
-- bun:sqlite ships >=3.40 and system sqlite3 is >=3.51.
-- Rollback leaves agent_sessions in its pre-0009 shape.

-- Drop the index first — SQLite refuses to drop a column referenced by an index.
DROP INDEX IF EXISTS idx_agent_sessions_state_changed;

ALTER TABLE agent_sessions DROP COLUMN state_changed_at;
ALTER TABLE agent_sessions DROP COLUMN state_source;
ALTER TABLE agent_sessions DROP COLUMN current_task_id;
ALTER TABLE agent_sessions DROP COLUMN current_tool;
ALTER TABLE agent_sessions DROP COLUMN claude_pid;

DELETE FROM feature_flags WHERE flag_name = 'heartbeat_v2_enabled';
