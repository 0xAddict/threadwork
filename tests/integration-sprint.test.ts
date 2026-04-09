import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB, expireStaleDecisions } from '../decision'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-sprint-integration-test.db'

describe('v2-lite sprint integration smoke', () => {
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

  test('A1: decision with 6-hour expiry stays open past the multi-cycle sweep', () => {
    const d = dec.openDecision('#17b replay', 'sprint integration', 'boss')
    db.run(sqlite => {
      sqlite.prepare(
        "UPDATE decisions SET expires_at = datetime('now', '+6 hours') WHERE id = ?"
      ).run(d.id)
    })

    // Simulate 5 consecutive watchdog cycles hitting expireStaleDecisions —
    // the pre-fix bug would have killed the row on the first cycle.
    for (let i = 0; i < 5; i++) {
      const expired = expireStaleDecisions(dec)
      expect(expired).toBe(0)
    }

    const row = db.run(s =>
      s.prepare('SELECT status FROM decisions WHERE id = ?').get(d.id) as { status: string }
    )
    expect(row.status).toBe('open')
  })

  test('A2: fresh circuit auto-heals on delegate-path after cooldown elapses', () => {
    // Seed open circuit with an already-past cooldown.
    db.run(sqlite => {
      sqlite.prepare(`
        INSERT INTO agent_sessions (agent, session_id, state, circuit_state, fault_count, cooldown_until)
        VALUES ('steve', 'claude-steve', 'alive', 'open', 5, datetime('now', '-5 seconds'))
        ON CONFLICT(agent) DO UPDATE SET
          circuit_state = 'open',
          fault_count = 5,
          cooldown_until = datetime('now', '-5 seconds')
      `).run()
    })

    // Delegate-path check: before the fix, this returns true forever.
    const openBefore = db.isCircuitOpen('steve')
    expect(openBefore).toBe(false) // auto-healed

    const state = db.getCircuitState('steve')
    expect(state?.circuit_state).toBe('half_open')

    // Closing via completeTask path — simulate: closeCircuit should succeed.
    db.closeCircuit('steve')
    const closed = db.getCircuitState('steve')
    expect(closed?.circuit_state).toBe('closed')
    expect(closed?.fault_count).toBe(0)
  })

  test('B1+B5: migrations landed — tw_nudge_debounce seeded, stall_miss_count present', () => {
    // Table exists and is seeded with 4 worker agents.
    const rows = db.run(s =>
      s.prepare('SELECT agent FROM tw_nudge_debounce ORDER BY agent').all() as Array<{ agent: string }>
    )
    const agents = rows.map(r => r.agent).sort()
    expect(agents).toContain('boss')
    expect(agents).toContain('steve')
    expect(agents).toContain('sadie')
    expect(agents).toContain('kiera')

    // stall_miss_count column exists on tasks (otherwise the pragma query
    // would not list it).
    const cols = db.run(s => s.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
    const names = cols.map(c => c.name)
    expect(names).toContain('stall_miss_count')
  })
})
