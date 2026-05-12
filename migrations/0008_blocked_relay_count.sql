-- Migration 0008: blocked_relay_count column for watchdog spam fix (#823)
--
-- Adds a counter that tracks how many times the watchdog has re-relayed a
-- BLOCKED status to a supervisor without an intervening heartbeat. The
-- watchdog enforces a cap (LONG_BLOCK_RELAY_CAP, default 3) and then
-- escalates-once-and-stops, instead of relaying every 48h forever.
--
-- The counter is reset to 0 when a heartbeat lands AFTER blocked_at.
--
-- Note: db.ts also performs the equivalent ALTER inside its in-process
-- migrate() loop (try/exec ADD COLUMN). This .sql file is the documentation
-- artifact for parity with migration 0007.

ALTER TABLE tasks ADD COLUMN blocked_relay_count INTEGER NOT NULL DEFAULT 0;
