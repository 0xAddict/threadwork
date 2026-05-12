import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

// Step 1 of state-contracts redesign (spec §5 Step 1, §2 STATE MODEL).
// Verifies the additive migration to agent_sessions ships exactly the 5
// new columns and the heartbeat_v2_enabled feature flag, and is idempotent.
//
// Test isolation: uses a temp-file SQLite DB; never touches production tasks.db.

const TEST_DB = '/tmp/state-contracts-migration-test.db'

type ColInfo = { name: string; type: string; dflt_value: string | null; notnull: number }

function tableInfo(rawDb: Database, table: string): ColInfo[] {
  return rawDb.query(`PRAGMA table_info(${table})`).all() as ColInfo[]
}

function flagRow(rawDb: Database, name: string): { flag_name: string; enabled: number } | null {
  return rawDb
    .query('SELECT flag_name, enabled FROM feature_flags WHERE flag_name = ?')
    .get(name) as { flag_name: string; enabled: number } | null
}

function cleanup() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix) } catch {}
  }
}

describe('Migration 0009 — state-contracts columns on agent_sessions', () => {
  let db: TaskDB

  beforeEach(() => {
    cleanup()
    db = new TaskDB(TEST_DB)
  })

  afterEach(() => {
    ;(db as any).db?.close()
    cleanup()
  })

  test('adds state_changed_at TEXT column', () => {
    const cols = tableInfo((db as any).db, 'agent_sessions')
    const col = cols.find(c => c.name === 'state_changed_at')
    expect(col).toBeDefined()
    expect(col!.type).toBe('TEXT')
    // Additive ALTER (no NOT NULL constraint — must allow NULL for backfill semantics)
    expect(col!.notnull).toBe(0)
  })

  test('adds state_source TEXT column', () => {
    const cols = tableInfo((db as any).db, 'agent_sessions')
    const col = cols.find(c => c.name === 'state_source')
    expect(col).toBeDefined()
    expect(col!.type).toBe('TEXT')
    expect(col!.notnull).toBe(0)
  })

  test('adds current_task_id INTEGER column', () => {
    const cols = tableInfo((db as any).db, 'agent_sessions')
    const col = cols.find(c => c.name === 'current_task_id')
    expect(col).toBeDefined()
    expect(col!.type).toBe('INTEGER')
    expect(col!.notnull).toBe(0)
  })

  test('adds current_tool TEXT column', () => {
    const cols = tableInfo((db as any).db, 'agent_sessions')
    const col = cols.find(c => c.name === 'current_tool')
    expect(col).toBeDefined()
    expect(col!.type).toBe('TEXT')
    expect(col!.notnull).toBe(0)
  })

  test('adds claude_pid INTEGER column', () => {
    const cols = tableInfo((db as any).db, 'agent_sessions')
    const col = cols.find(c => c.name === 'claude_pid')
    expect(col).toBeDefined()
    expect(col!.type).toBe('INTEGER')
    expect(col!.notnull).toBe(0)
  })

  test('all 5 new columns exist together (sanity)', () => {
    const cols = tableInfo((db as any).db, 'agent_sessions')
    const names = cols.map(c => c.name)
    for (const expected of ['state_changed_at', 'state_source', 'current_task_id', 'current_tool', 'claude_pid']) {
      expect(names).toContain(expected)
    }
  })

  test('creates idx_agent_sessions_state_changed index', () => {
    const idx = ((db as any).db as Database)
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_sessions_state_changed'")
      .get()
    expect(idx).not.toBeNull()
  })
})

describe('Migration 0009 — heartbeat_v2_enabled feature flag', () => {
  let db: TaskDB

  beforeEach(() => {
    cleanup()
    db = new TaskDB(TEST_DB)
  })

  afterEach(() => {
    ;(db as any).db?.close()
    cleanup()
  })

  test('inserts heartbeat_v2_enabled flag', () => {
    const row = flagRow((db as any).db, 'heartbeat_v2_enabled')
    expect(row).not.toBeNull()
    expect(row!.flag_name).toBe('heartbeat_v2_enabled')
  })

  test('heartbeat_v2_enabled defaults to 0 (off)', () => {
    const row = flagRow((db as any).db, 'heartbeat_v2_enabled')
    expect(row!.enabled).toBe(0)
  })
})

describe('Migration 0009 — idempotency', () => {
  beforeEach(cleanup)
  afterEach(cleanup)

  test('running migration twice in a row does not error', () => {
    // First run — fresh DB.
    const first = new TaskDB(TEST_DB)
    ;(first as any).db?.close()

    // Second run — same file, migrations re-execute. Must be a no-op.
    let secondError: unknown = null
    let second: TaskDB | null = null
    try {
      second = new TaskDB(TEST_DB)
    } catch (err) {
      secondError = err
    }
    expect(secondError).toBeNull()
    expect(second).not.toBeNull()

    // After second run: schema still correct, flag still present, flag still 0.
    const cols = tableInfo((second as any).db, 'agent_sessions')
    const names = cols.map(c => c.name)
    for (const expected of ['state_changed_at', 'state_source', 'current_task_id', 'current_tool', 'claude_pid']) {
      expect(names).toContain(expected)
    }
    const flag = flagRow((second as any).db, 'heartbeat_v2_enabled')
    expect(flag!.enabled).toBe(0)

    ;(second as any).db?.close()
  })

  test('flag is preserved (not reset) if operator flipped it on between runs', () => {
    // First run — seeds flag at 0.
    const first = new TaskDB(TEST_DB)
    const rawFirst = (first as any).db as Database
    // Operator flips the flag on out-of-band.
    rawFirst.exec("UPDATE feature_flags SET enabled = 1 WHERE flag_name = 'heartbeat_v2_enabled'")
    expect(flagRow(rawFirst, 'heartbeat_v2_enabled')!.enabled).toBe(1)
    rawFirst.close()

    // Second run — INSERT OR IGNORE must NOT clobber operator value.
    const second = new TaskDB(TEST_DB)
    expect(flagRow((second as any).db, 'heartbeat_v2_enabled')!.enabled).toBe(1)
    ;(second as any).db?.close()
  })

  test('backfill sets state_changed_at = last_seen_at for pre-existing rows', () => {
    // Simulate "old" DB where agent_sessions row was written before migration 0009.
    // We do this by:
    //   1. Run migrations (creates the column).
    //   2. NULL it out to mimic a row that existed pre-migration.
    //   3. Re-run migrations — backfill UPDATE in db.ts:361 should restore it.
    const first = new TaskDB(TEST_DB)
    const raw = (first as any).db as Database
    raw.exec("INSERT INTO agent_sessions (agent, state, last_seen_at, started_at) VALUES ('legacy', 'unknown', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')")
    raw.exec("UPDATE agent_sessions SET state_changed_at = NULL WHERE agent = 'legacy'")
    raw.close()

    const second = new TaskDB(TEST_DB)
    const row = ((second as any).db as Database)
      .query("SELECT state_changed_at, last_seen_at FROM agent_sessions WHERE agent = 'legacy'")
      .get() as { state_changed_at: string; last_seen_at: string }
    expect(row.state_changed_at).toBe(row.last_seen_at)
    ;(second as any).db?.close()
  })
})
