-- Migration 0009: state-contract columns for heartbeat v2 redesign
--
-- Adds 5 columns to agent_sessions so Claude Code hooks and MCP tools
-- can declare the agent's current operational state. The heartbeat daemon
-- reads these columns before falling back to LLM classification.
--
-- Mirrors the ALTER pattern from migration 0008 (blocked_relay_count)
-- and the circuit-breaker columns added inline in db.ts:347-358.

ALTER TABLE agent_sessions ADD COLUMN state_changed_at TEXT;
ALTER TABLE agent_sessions ADD COLUMN state_source TEXT;
ALTER TABLE agent_sessions ADD COLUMN current_task_id INTEGER;
ALTER TABLE agent_sessions ADD COLUMN current_tool TEXT;
ALTER TABLE agent_sessions ADD COLUMN claude_pid INTEGER;

CREATE INDEX IF NOT EXISTS idx_agent_sessions_state_changed ON agent_sessions(state_changed_at);

-- Backfill: any existing row gets state_changed_at = last_seen_at
UPDATE agent_sessions SET state_changed_at = last_seen_at WHERE state_changed_at IS NULL;

-- Feature flag for v2 daemon rollout (INSERT OR IGNORE — idempotent on re-run)
-- Note: feature_flags table uses flag_name (not name) per db.ts:282
INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('heartbeat_v2_enabled', 0);
