-- Reverse Migration 0012: drop last_eta_sec (#13012 Sub-Sprint B).
--
-- SQLite supports ALTER TABLE DROP COLUMN starting at version 3.35
-- (bun:sqlite ships >=3.40). If on an older runtime, do the table-recreate
-- dance instead.
--
-- NOTE: after dropping the column, redeploy a db.ts WITHOUT the 0012 boot ALTER,
-- or the in-process migrate() loop will re-add it on next start.

ALTER TABLE tasks DROP COLUMN last_eta_sec;
