import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB, expireStaleDecisions } from '../decision'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-decision-expiry-test.db'

describe('expireStaleDecisions (v2-lite A1)', () => {
  let db: TaskDB
  let mem: MemoryDB
  let dec: DecisionDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
    mem = new MemoryDB(db)
    dec = new DecisionDB(db, mem)
  })

  test('does not expire a decision whose expires_at is in the future even on same day', () => {
    // Insert a decision whose expires_at is 6 hours from now (same day in UTC
    // for most test runs). This is the exact bug that killed Decision #17.
    const d = dec.openDecision('future same-day', 'ctx', 'boss')
    db.run(sqlite => {
      sqlite.prepare(
        "UPDATE decisions SET expires_at = datetime('now', '+6 hours') WHERE id = ?"
      ).run(d.id)
    })

    const expired = expireStaleDecisions(dec)
    expect(expired).toBe(0)

    const row = db.run(s => s.prepare('SELECT status FROM decisions WHERE id = ?').get(d.id) as { status: string })
    expect(row.status).toBe('open')
  })

  test('expires a decision whose expires_at is in the past', () => {
    const d = dec.openDecision('past', 'ctx', 'boss')
    db.run(sqlite => {
      sqlite.prepare(
        "UPDATE decisions SET expires_at = datetime('now', '-1 hours') WHERE id = ?"
      ).run(d.id)
    })

    const expired = expireStaleDecisions(dec)
    expect(expired).toBe(1)

    const row = db.run(s => s.prepare('SELECT status FROM decisions WHERE id = ?').get(d.id) as { status: string })
    expect(row.status).toBe('expired')
  })

  test('ignores decisions with NULL expires_at', () => {
    const d = dec.openDecision('no expiry', 'ctx', 'boss')
    // Leave expires_at NULL (default).

    const expired = expireStaleDecisions(dec)
    expect(expired).toBe(0)

    const row = db.run(s => s.prepare('SELECT status FROM decisions WHERE id = ?').get(d.id) as { status: string })
    expect(row.status).toBe('open')
  })

  test('handles malformed expires_at without crashing', () => {
    const d = dec.openDecision('malformed', 'ctx', 'boss')
    db.run(sqlite => {
      sqlite.prepare('UPDATE decisions SET expires_at = ? WHERE id = ?').run('not-a-date', d.id)
    })

    // Must not throw and must not expire the malformed row.
    let threw = false
    let count = 0
    try {
      count = expireStaleDecisions(dec)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(count).toBe(0)

    const row = db.run(s => s.prepare('SELECT status FROM decisions WHERE id = ?').get(d.id) as { status: string })
    expect(row.status).toBe('open')
  })
})
