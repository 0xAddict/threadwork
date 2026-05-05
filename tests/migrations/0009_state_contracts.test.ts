import { describe, test, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'

const TASKS_DB = '/Users/coachstokes/.claude/mcp-servers/task-board/tasks.db'
const MIGRATIONS_DIR = '/Users/coachstokes/.claude/mcp-servers/task-board/migrations'
const TEST_DB = '/tmp/tasks-migration-0009-test.db'
const ROUNDTRIP_DB = '/tmp/tasks-migration-0009-roundtrip.db'

const NEW_COLS = ['state_changed_at', 'state_source', 'current_task_id', 'current_tool', 'claude_pid']

function applyMigration(db: Database, filename: string) {
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8')
  const statements = sql
    .split(';')
    .map(s => s.replace(/--[^\n]*/g, '').trim())
    .filter(s => s.length > 0)
  for (const stmt of statements) {
    db.exec(stmt)
  }
}

function getColumns(db: Database): string[] {
  const rows = db.query('PRAGMA table_info(agent_sessions)').all() as { name: string }[]
  return rows.map(r => r.name)
}

function getIndexes(db: Database): string[] {
  const rows = db.query('PRAGMA index_list(agent_sessions)').all() as { name: string }[]
  return rows.map(r => r.name)
}

function cleanDb(path: string) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch { /* ok */ }
  }
}

afterEach(() => {
  cleanDb(TEST_DB)
  cleanDb(ROUNDTRIP_DB)
})

describe('Migration 0009 — state contracts (up)', () => {
  test('adds 5 new columns to agent_sessions', () => {
    copyFileSync(TASKS_DB, TEST_DB)
    const db = new Database(TEST_DB)

    const before = getColumns(db)
    for (const col of NEW_COLS) {
      expect(before).not.toContain(col)
    }

    applyMigration(db, '0009_state_contracts.sql')

    const after = getColumns(db)
    for (const col of NEW_COLS) {
      expect(after).toContain(col)
    }

    db.close()
  })

  test('creates index idx_agent_sessions_state_changed', () => {
    copyFileSync(TASKS_DB, TEST_DB)
    const db = new Database(TEST_DB)

    applyMigration(db, '0009_state_contracts.sql')

    const indexes = getIndexes(db)
    expect(indexes).toContain('idx_agent_sessions_state_changed')

    db.close()
  })

  test('inserts heartbeat_v2_enabled feature flag with enabled=0', () => {
    copyFileSync(TASKS_DB, TEST_DB)
    const db = new Database(TEST_DB)

    applyMigration(db, '0009_state_contracts.sql')

    const flag = db.query("SELECT name, enabled FROM feature_flags WHERE name='heartbeat_v2_enabled'").get() as { name: string; enabled: number } | null
    expect(flag).not.toBeNull()
    expect(flag!.name).toBe('heartbeat_v2_enabled')
    expect(flag!.enabled).toBe(0)

    db.close()
  })

  test('backfills state_changed_at = last_seen_at for existing rows', () => {
    copyFileSync(TASKS_DB, TEST_DB)
    const db = new Database(TEST_DB)

    applyMigration(db, '0009_state_contracts.sql')

    const nullCount = db.query(
      "SELECT COUNT(*) as cnt FROM agent_sessions WHERE state_changed_at IS NULL AND last_seen_at IS NOT NULL"
    ).get() as { cnt: number }
    expect(nullCount.cnt).toBe(0)

    db.close()
  })

  test('is idempotent — INSERT OR IGNORE for feature flag', () => {
    copyFileSync(TASKS_DB, TEST_DB)
    const db = new Database(TEST_DB)

    applyMigration(db, '0009_state_contracts.sql')
    // Second apply should not throw on the INSERT OR IGNORE
    expect(() => applyMigration(db, '0009_state_contracts.sql')).not.toThrow()

    const flagCount = db.query("SELECT COUNT(*) as cnt FROM feature_flags WHERE name='heartbeat_v2_enabled'").get() as { cnt: number }
    expect(flagCount.cnt).toBe(1)

    db.close()
  })
})

describe('Migration 0009 — state contracts (down)', () => {
  test('drops all 5 new columns', () => {
    copyFileSync(TASKS_DB, TEST_DB)
    const db = new Database(TEST_DB)

    applyMigration(db, '0009_state_contracts.sql')
    applyMigration(db, '0009_state_contracts.down.sql')

    const after = getColumns(db)
    for (const col of NEW_COLS) {
      expect(after).not.toContain(col)
    }

    db.close()
  })

  test('removes heartbeat_v2_enabled feature flag', () => {
    copyFileSync(TASKS_DB, TEST_DB)
    const db = new Database(TEST_DB)

    applyMigration(db, '0009_state_contracts.sql')
    applyMigration(db, '0009_state_contracts.down.sql')

    const flag = db.query("SELECT name FROM feature_flags WHERE name='heartbeat_v2_enabled'").get()
    expect(flag).toBeNull()

    db.close()
  })
})

describe('Migration 0009 — round-trip', () => {
  test('up-down-up final schema matches single up', () => {
    // Single up on TEST_DB
    copyFileSync(TASKS_DB, TEST_DB)
    const db1 = new Database(TEST_DB)
    applyMigration(db1, '0009_state_contracts.sql')
    const singleCols = getColumns(db1).sort()
    const singleIndexes = getIndexes(db1).sort()
    db1.close()

    // Round-trip on ROUNDTRIP_DB
    copyFileSync(TASKS_DB, ROUNDTRIP_DB)
    const db2 = new Database(ROUNDTRIP_DB)
    applyMigration(db2, '0009_state_contracts.sql')
    applyMigration(db2, '0009_state_contracts.down.sql')
    applyMigration(db2, '0009_state_contracts.sql')
    const roundCols = getColumns(db2).sort()
    const roundIndexes = getIndexes(db2).sort()
    db2.close()

    expect(roundCols).toEqual(singleCols)
    expect(roundIndexes).toEqual(singleIndexes)
  })
})
