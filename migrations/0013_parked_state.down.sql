-- Reverse Migration 0013: drop prior_status (#13012 Sub-Sprint C2 / Item 4).
--
-- SQLite supports ALTER TABLE DROP COLUMN starting at version 3.35
-- (bun:sqlite ships >=3.40). If on an older runtime, do the table-recreate
-- dance instead.
--
-- NOTE: this only drops the prior_status column. Any rows still carrying
-- status='parked' should be unparked (or manually set back to a real status)
-- BEFORE running this, or they will be left in 'parked' with no breadcrumb to
-- restore from. After dropping the column, redeploy a db.ts WITHOUT the 0013
-- boot ALTER, or the in-process migrate() loop will re-add it on next start.

ALTER TABLE tasks DROP COLUMN prior_status;
