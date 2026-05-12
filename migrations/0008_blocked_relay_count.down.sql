-- Reverse Migration 0008: drop blocked_relay_count.
--
-- SQLite supports ALTER TABLE DROP COLUMN starting at version 3.35
-- (bun:sqlite ships >=3.40). If on an older runtime, do the table-recreate
-- dance instead.

ALTER TABLE tasks DROP COLUMN blocked_relay_count;
