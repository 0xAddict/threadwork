import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

// Autonomous Board P1-WS1 — schema self-heal test.
// Asserts a fresh TaskDB() (which runs migrate()) provisions the 8 new card
// columns and 3 supporting tables. This guards db.ts:migrate() so a fresh
// deploy / test DB self-heals the autonomous-board schema (PRD §6).

const TEST_DB = '/tmp/autonomous-board-schema-test.db'

const NEW_CARD_COLUMNS = [
  'complexity_user',
  'complexity_final',
  'classification_score',
  'classification_rationale',
  'tags',
  'snoozed_until',
  'reject_count',
  'owner',
]

const SUPPORTING_TABLES = [
  'watcher_heartbeat',
  'telegram_conversation_state',
  'soak_prediction_log',
]

describe('Autonomous Board P1-WS1 schema self-heal', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('migrate() provisions all 8 new card columns on a fresh DB', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cols = ((db as any).db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>)
      .map((r) => r.name)
    for (const col of NEW_CARD_COLUMNS) {
      expect(cols).toContain(col)
    }
  })

  test('reject_count defaults to 0 and is NOT NULL', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = ((db as any).db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
    const rc = info.find((r) => r.name === 'reject_count')
    expect(rc).toBeTruthy()
    expect(rc?.notnull).toBe(1)
    expect(String(rc?.dflt_value)).toContain('0')
  })

  test('migrate() provisions all 3 supporting tables on a fresh DB', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tables = ((db as any).db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name)
    for (const t of SUPPORTING_TABLES) {
      expect(tables).toContain(t)
    }
  })
})
