import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-circuit-healing-test.db'

// Helper: seed an agent_sessions row and force circuit state.
function forceCircuitState(
  db: TaskDB,
  agent: string,
  state: 'closed' | 'open' | 'half_open',
  cooldownSqlExpr: string | null,
) {
  db.run(sqlite => {
    sqlite.prepare(`
      INSERT INTO agent_sessions (agent, session_id, state, circuit_state, fault_count, cooldown_until)
      VALUES (?, ?, 'alive', ?, 5, ${cooldownSqlExpr === null ? 'NULL' : cooldownSqlExpr})
      ON CONFLICT(agent) DO UPDATE SET
        circuit_state = excluded.circuit_state,
        fault_count = 5,
        cooldown_until = ${cooldownSqlExpr === null ? 'NULL' : cooldownSqlExpr}
    `).run(agent, `claude-${agent}`, state)
  })
}

describe('isCircuitOpen auto-heal (v2-lite A2)', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('returns false and transitions to half_open when cooldown_until has elapsed', () => {
    forceCircuitState(db, 'steve', 'open', "datetime('now', '-1 seconds')")

    const isOpen = db.isCircuitOpen('steve')
    expect(isOpen).toBe(false)

    const state = db.getCircuitState('steve')
    expect(state?.circuit_state).toBe('half_open')
  })

  test('returns true when cooldown_until is still in the future', () => {
    forceCircuitState(db, 'kiera', 'open', "datetime('now', '+60 seconds')")

    const isOpen = db.isCircuitOpen('kiera')
    expect(isOpen).toBe(true)

    const state = db.getCircuitState('kiera')
    expect(state?.circuit_state).toBe('open')
  })

  test('force-closes a circuit with NULL cooldown_until and warns', () => {
    forceCircuitState(db, 'sadie', 'open', null)

    // Capture warn output to verify the emitted warning without asserting
    // a specific message format.
    const origWarn = console.warn
    let warned = false
    console.warn = (..._args: unknown[]) => { warned = true }
    try {
      const isOpen = db.isCircuitOpen('sadie')
      expect(isOpen).toBe(false)
    } finally {
      console.warn = origWarn
    }
    expect(warned).toBe(true)

    const state = db.getCircuitState('sadie')
    expect(state?.circuit_state).toBe('closed')
    expect(state?.fault_count).toBe(0)
  })

  test('closed circuit returns false without mutation', () => {
    forceCircuitState(db, 'boss', 'closed', null)
    const isOpen = db.isCircuitOpen('boss')
    expect(isOpen).toBe(false)
    const state = db.getCircuitState('boss')
    expect(state?.circuit_state).toBe('closed')
  })

  test('concurrent isCircuitOpen calls do not double-transition', () => {
    // tryHalfOpen guards `circuit_state !== 'open'`, so back-to-back calls
    // in a tight loop must only produce one transition; the second observes
    // half_open and no-ops.
    forceCircuitState(db, 'steve', 'open', "datetime('now', '-5 seconds')")

    const results = [
      db.isCircuitOpen('steve'),
      db.isCircuitOpen('steve'),
      db.isCircuitOpen('steve'),
    ]
    expect(results).toEqual([false, false, false])

    const state = db.getCircuitState('steve')
    // First call transitions open -> half_open. Subsequent calls see half_open
    // and the early `state?.circuit_state !== 'open'` guard returns false
    // without attempting to re-transition.
    expect(state?.circuit_state).toBe('half_open')
  })
})
