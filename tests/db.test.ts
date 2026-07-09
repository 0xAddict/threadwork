import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/task-board-test.db'

// P5 (ATM-025): both new write-ordering / directed-messaging flags default OFF.
describe('P5 write-ordering / directed-messaging feature flags (ATM-025)', () => {
  let flagsDbPath: string

  beforeEach(() => {
    flagsDbPath = `/tmp/p5-flags-${crypto.randomUUID()}.db`
  })

  test('a fresh TaskDB seeds memory_write_ordering_enabled and directed_messaging_enabled both false', () => {
    const db = new TaskDB(flagsDbPath)
    try {
      expect(db.isFeatureEnabled('memory_write_ordering_enabled')).toBe(false)
      expect(db.isFeatureEnabled('directed_messaging_enabled')).toBe(false)
    } finally {
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(flagsDbPath + suffix) } catch {}
      }
    }
  })
})

describe('TaskDB', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('createTask returns a task with id and pending status', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'Update landing page', priority: 'normal' })
    expect(task.id).toBeGreaterThan(0)
    expect(task.status).toBe('pending')
    expect(task.from_agent).toBe('boss')
    expect(task.to_agent).toBe('steve')
    expect(task.description).toBe('Update landing page')
  })

  test('claimTask sets status to in_progress', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    const claimed = db.claimTask(task.id, 'steve')
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.claimed_at).toBeTruthy()
  })

  test('claimTask fails on already claimed task', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')
    const second = db.claimTask(task.id, 'sadie')
    expect(second).toBeNull()
  })

  test('completeTask sets status to completed with result', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')
    const completed = db.completeTask(task.id, 'Done — updated hero text', 'steve')
    expect(completed?.status).toBe('completed')
    expect(completed?.result).toBe('Done — updated hero text')
    expect(completed?.completed_at).toBeTruthy()
  })

  test('listTasks filters by assignee', () => {
    db.createTask({ from: 'boss', to: 'steve', description: 'task 1', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'sadie', description: 'task 2', priority: 'normal' })
    const steveTasks = db.listTasks({ assignee: 'steve' })
    expect(steveTasks).toHaveLength(1)
    expect(steveTasks[0].to_agent).toBe('steve')
  })

  test('listTasks filters by status', () => {
    const t = db.createTask({ from: 'boss', to: 'steve', description: 'task 1', priority: 'normal' })
    db.createTask({ from: 'boss', to: 'steve', description: 'task 2', priority: 'normal' })
    db.claimTask(t.id, 'steve')
    const pending = db.listTasks({ status: 'pending' })
    expect(pending).toHaveLength(1)
  })

  test('addNote appends a note to a task', () => {
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.addNote(task.id, 'boss', 'Make sure to update the CTA too')
    const notes = db.getNotes(task.id)
    expect(notes).toHaveLength(1)
    expect(notes[0].from_agent).toBe('boss')
    expect(notes[0].message).toBe('Make sure to update the CTA too')
  })
})

describe('fault_count decay on successful heartbeat', () => {
  let db: TaskDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    db = new TaskDB(TEST_DB)
  })

  test('successful heartbeat decrements fault_count by 1', () => {
    // Register agent with fault_count=3
    db.upsertAgentSession('steve', 'sess-1', 'active')
    db.run(d => {
      d.prepare('UPDATE agent_sessions SET fault_count = 3 WHERE agent = ?').run('steve')
    })

    // Create and claim a task for steve
    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')

    // First successful (non-blocked) heartbeat -> fault_count should go from 3 to 2
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    let state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(2)

    // Second successful heartbeat -> 2 to 1
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(1)

    // Third -> 1 to 0
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(0)

    // Fourth -> bounded at 0, should NOT go negative
    db.updateHeartbeat({ taskId: task.id, agent: 'steve' })
    state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(0)
  })

  test('blocked heartbeat does NOT decay fault_count', () => {
    db.upsertAgentSession('steve', 'sess-1', 'active')
    db.run(d => {
      d.prepare('UPDATE agent_sessions SET fault_count = 3 WHERE agent = ?').run('steve')
    })

    const task = db.createTask({ from: 'boss', to: 'steve', description: 'test', priority: 'normal' })
    db.claimTask(task.id, 'steve')

    // Blocked heartbeat should NOT decay
    db.updateHeartbeat({ taskId: task.id, agent: 'steve', isBlocked: true, blockedReason: 'waiting on API' })
    const state = db.getCircuitState('steve')
    expect(state?.fault_count).toBe(3)
  })
})

// T4 (ATM-022/REQ-021): reward_consumer_enabled feature flag — default OFF,
// idempotent seed. Sits next to the P8 ternary_reward_enabled flag in
// db.ts migrate(); this is the EPIC-05 prereq flag gating the future
// reward-consumer / memory-importance learning loop (scaffolded in a later
// T4 packet — this packet only lays the flag + cursor-table foundation).
describe('T4 reward_consumer_enabled feature flag (ATM-022)', () => {
  let flagPath: string

  beforeEach(() => {
    flagPath = `/tmp/t4-reward-flag-${crypto.randomUUID()}.db`
  })

  test('a fresh TaskDB seeds reward_consumer_enabled to false (OFF)', () => {
    const db = new TaskDB(flagPath)
    try {
      expect(db.isFeatureEnabled('reward_consumer_enabled')).toBe(false)
      const row = db.run(d =>
        d.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'reward_consumer_enabled'").get(),
      ) as { enabled: number } | null
      expect(row).not.toBeNull()
      expect(row!.enabled).toBe(0)
    } finally {
      db.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(flagPath + suffix) } catch {}
      }
    }
  })

  test('flipping the flag ON then re-migrating (fresh TaskDB against the same file) does not clobber it back to 0', () => {
    const first = new TaskDB(flagPath)
    first.setFeatureFlag('reward_consumer_enabled', true)
    first.close()

    const second = new TaskDB(flagPath) // constructor re-runs migrate()
    try {
      expect(second.isFeatureEnabled('reward_consumer_enabled')).toBe(true)
    } finally {
      second.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(flagPath + suffix) } catch {}
      }
    }
  })
})

// T4 (ATM-006/REQ-006): reward_consumption_cursor table — durable,
// keyed-by-consumer high-water-mark cursor. Sits next to the P8
// ternary_rewards table in db.ts migrate(); this is the STABLE cross-spec
// read contract a future T1 retention/pruning consumer must honor (column
// names + defaults are exact-verbatim per the packet spec).
describe('T4 reward_consumption_cursor table + seed (ATM-006)', () => {
  let cursorPath: string

  beforeEach(() => {
    cursorPath = `/tmp/t4-reward-cursor-${crypto.randomUUID()}.db`
  })

  test('a fresh migrate() creates reward_consumption_cursor with the documented columns', () => {
    const db = new TaskDB(cursorPath)
    try {
      const columns = db.run(d => d.prepare("PRAGMA table_info('reward_consumption_cursor')").all()) as {
        name: string
        notnull: number
        dflt_value: string | null
      }[]
      const columnNames = columns.map(c => c.name).sort()
      expect(columnNames).toEqual(
        ['consumer', 'last_consumed_reward_id', 'claimed_by', 'claimed_at', 'updated_at'].sort(),
      )
      const lastConsumed = columns.find(c => c.name === 'last_consumed_reward_id')
      expect(lastConsumed).toBeDefined()
      expect(lastConsumed!.notnull).toBe(1)
      expect(String(lastConsumed!.dflt_value)).toContain('0')
    } finally {
      db.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(cursorPath + suffix) } catch {}
      }
    }
  })

  test('a fresh migrate() seeds exactly one row for the memory_importance consumer', () => {
    const db = new TaskDB(cursorPath)
    try {
      const rows = db.run(d => d.prepare('SELECT * FROM reward_consumption_cursor').all()) as {
        consumer: string
        last_consumed_reward_id: number
        claimed_by: string | null
        claimed_at: string | null
        updated_at: string
      }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].consumer).toBe('memory_importance')
      expect(rows[0].last_consumed_reward_id).toBe(0)
      expect(rows[0].claimed_by).toBeNull()
      expect(rows[0].claimed_at).toBeNull()
      expect(rows[0].updated_at).not.toBeNull()
    } finally {
      db.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(cursorPath + suffix) } catch {}
      }
    }
  })

  test('re-migrating (fresh TaskDB against the same file) is idempotent — still exactly one row, values unchanged', () => {
    const first = new TaskDB(cursorPath)
    first.run(d =>
      d
        .prepare(
          "UPDATE reward_consumption_cursor SET last_consumed_reward_id = 42, claimed_by = 'someone', claimed_at = datetime('now') WHERE consumer = 'memory_importance'",
        )
        .run(),
    )
    first.close()

    const second = new TaskDB(cursorPath) // constructor re-runs migrate()
    try {
      const rows = second.run(d => d.prepare('SELECT * FROM reward_consumption_cursor').all()) as {
        consumer: string
        last_consumed_reward_id: number
        claimed_by: string | null
      }[]
      // INSERT OR IGNORE must not have re-inserted/reset the seeded row.
      expect(rows).toHaveLength(1)
      expect(rows[0].consumer).toBe('memory_importance')
      expect(rows[0].last_consumed_reward_id).toBe(42)
      expect(rows[0].claimed_by).toBe('someone')
    } finally {
      second.close()
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(cursorPath + suffix) } catch {}
      }
    }
  })
})
