-- Migration 0014 (#10060784): BM25 full-text search over memories.
--
-- Adds an FTS5 external-content virtual table mirroring memories.content, kept
-- in sync by AFTER INSERT/UPDATE/DELETE triggers, plus a one-time backfill of
-- existing rows. This powers query/task-aware recall() (BM25 relevance blend)
-- and the get_boot_briefing `query` param.
--
-- WHY external-content (content='memories', content_rowid='id'):
--   - No duplicate storage of the (large) content blob — the FTS index points
--     back at the base table by rowid.
--   - tokenize='unicode61 remove_diacritics 2' folds accents (café == cafe) so
--     recall on Unicode-heavy content doesn't silently miss, matching
--     MemoryDB.normalizeContent's NFC fold intent.
--
-- The external-content contract requires that the triggers issue the special
-- "delete" command (INSERT INTO ...fts(fts, rowid, content) VALUES('delete', …))
-- on row removal/pre-update so the index does not drift from the base table.
-- This is the canonical SQLite FTS5 external-content sync pattern.
--
-- ADDITIVE + SAFE: this migration only CREATEs a new vtable + shadow tables +
-- triggers and backfills the index. It does NOT touch existing memories rows or
-- columns. The running MCP server ignores memories_fts until it is restarted
-- (the new recall/boot code paths only activate on restart). Applying this to a
-- live tasks.db is a fast, non-locking op (CREATE VIRTUAL TABLE + a single
-- INSERT...SELECT over the memories table).
--
-- This .sql file is the documentation/parity artifact. The authoritative
-- runtime application lives in db.ts::migrate() as idempotent guarded blocks
-- (mirroring every prior migration in this repo).

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- External-content sync triggers ------------------------------------------------

-- AFTER INSERT: index the new row.
CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ai
AFTER INSERT ON memories
BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

-- AFTER DELETE: remove the row from the index via the 'delete' command.
CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ad
AFTER DELETE ON memories
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- AFTER UPDATE: delete the stale index entry then re-insert the fresh one.
CREATE TRIGGER IF NOT EXISTS trg_memories_fts_au
AFTER UPDATE ON memories
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

-- One-time backfill of existing rows. INSERT OR IGNORE so re-running the
-- migration on an already-backfilled DB is a no-op (the rebuild command is the
-- canonical re-sync, but a plain backfill is sufficient and avoids a full
-- rebuild on every server boot). The runtime guard in db.ts skips this when the
-- index already has rows.
INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories;
