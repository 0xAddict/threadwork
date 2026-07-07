// tests/failure-classification-watchdog-integration.test.ts — P6 Stage 5,
// EPIC-03 integration coverage for watchdog.ts's additive, flag-gated,
// try/catch-swallowed failure-classification call sites.
//
// ATM-014: drives the watchdog's fault (:557 crash / :662 timeout / :959
// session-crash), blocked (:368, all 5 blocked_on cases), and dead-session
// (:568) call sites against a fixture TaskDB with the flag ON, asserting the
// expected failure_classifications rows appear; then the same drivers with
// the flag OFF, asserting ZERO rows and unchanged watchdog behavior
// (agent_sessions/tasks mutations + the exact ESCALATION L{n} string).
//
// ATM-015: regression-lock — recordFault()'s signature, the
// agent_sessions.(last_fault_type/circuit_state/fault_count) and
// tasks.(blocked_reason/blocked_on/escalation_level) column semantics, and
// determineAction() are unchanged; a thrown persistence error at each of the
// 5 call sites leaves the pre-existing mutations completing identically
// (fault-injection, not just happy-path).
//
// Uses ONLY temp dbs (/tmp/p6-watchdog-*.db) — never the live board db. All
// private watchdog methods are invoked directly via `as any` (the smallest
// units that hit each call site), per the P6 Stage 5 generator brief.

import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { TaskDB, type Task, type BlockedOn } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler, type ReconcileResult, determineAction } from '../watchdog'
import { getFailureClassifications, type FailureDomain } from '../verification/failure-classification'

function wipeDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch { /* doesn't exist yet */ }
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    from_agent: 'boss',
    to_agent: 'kiera',
    description: 'test task',
    priority: 'normal',
    status: 'in_progress',
    result: null,
    created_at: '2026-01-01 00:00:00',
    claimed_at: '2026-01-01 00:00:00',
    completed_at: null,
    nudge_count: 0,
    parent_task_id: null,
    kind: 'task',
    supervisor_agent: 'boss',
    last_heartbeat_at: '2026-01-01 00:00:00',
    last_progress_at: '2026-01-01 00:00:00',
    next_check_at: null,
    heartbeat_timeout_sec: 300,
    progress_timeout_sec: 600,
    blocked_at: null,
    blocked_reason: null,
    blocked_on: null,
    escalation_level: 0,
    worker_session_id: null,
    version: 1,
    is_synthetic: 0,
    is_addendum: 0,
    attempt_id: 1,
    result_finding_id: null,
    last_eta_sec: null,
    prior_status: null,
    complexity_user: null,
    delegation_brief: null,
    ...overrides,
  }
}

function makeResult(): ReconcileResult {
  return {
    checked: 0,
    nudged: 0,
    escalated: 0,
    blocked_relayed: 0,
    dead_sessions: 0,
    decisions_expired: 0,
    decisions_nudged: 0,
    decisions_ready: 0,
    idle_nudges: 0,
    circuits_recovered: 0,
  }
}

/** Fresh-enough timestamp (SQL 'YYYY-MM-DD HH:MM:SS', UTC) so short-block
 * (blocked_on = 'agent' | null) test cases don't trip the BLOCKED_TTL_SEC
 * staleness fall-through path in reconcileTask — keeps every blocked_on case
 * on the single, uniform `handleBlocked` branch so the additive persist call
 * (which fires once, unconditionally, before any branching) is the only
 * thing under test. */
function freshTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function seedAgentSession(taskDb: TaskDB, agent: string): void {
  taskDb.run(db => {
    db.prepare(`
      INSERT INTO agent_sessions (agent, session_id, last_seen_at, state)
      VALUES (?, ?, datetime('now'), 'alive')
    `).run(agent, `sess-${agent}`)
  })
}

/** handleHeartbeatOverdue's #850 Layer-1 terminal-status guard re-reads the
 * task's live status by id — it needs an actual `tasks` row to exist (else
 * it treats a missing row as terminal and returns before reaching
 * recordFault at all). Seed one with status='in_progress'. */
function seedTaskRow(taskDb: TaskDB, id: number, toAgent: string): void {
  taskDb.run(db => {
    db.prepare(`
      INSERT INTO tasks (id, from_agent, to_agent, description, priority, status, supervisor_agent)
      VALUES (?, 'boss', ?, 'x', 'normal', 'in_progress', 'boss')
    `).run(id, toAgent)
  })
}

// ---------------------------------------------------------------------------
// ATM-014: flag ON — expected rows appear at every call site
// ---------------------------------------------------------------------------
describe('ATM-014: watchdog.ts failure-classification wiring (flag ON)', () => {
  const TEST_DB = '/tmp/p6-watchdog-atm014-on.db'
  let taskDb: TaskDB
  let audit: AuditLog
  let reconciler: TaskReconciler

  function fresh(): void {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB)
    taskDb.setFeatureFlag('failure_classification_enabled', true)
    audit = new AuditLog(taskDb)
    reconciler = new TaskReconciler(taskDb, audit)
  }

  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-014: :557 crash fault (handleDeadSession, non-subagent) persists a liveness_timeout/critical/watchdog_fault row', async () => {
    fresh()
    seedAgentSession(taskDb, 'kiera-atm014-crash')
    const task = makeTask({ id: 10, kind: 'task', to_agent: 'kiera-atm014-crash' })
    await (reconciler as any).handleDeadSession(task, makeResult())

    const rows = taskDb.run(db => getFailureClassifications(db, { taskId: 10 }))
    const crashRows = rows.filter(r => r.signal_source === 'watchdog_fault')
    expect(crashRows.length).toBe(1)
    expect(crashRows[0]!.failure_class).toBe('liveness_timeout')
    expect(crashRows[0]!.severity).toBe('critical')
  })

  test('ATM-014: :568 dead-session escalation persists a liveness_timeout/critical/permanent/watchdog_dead_session row', async () => {
    fresh()
    seedAgentSession(taskDb, 'boss-atm014-dead')
    const task = makeTask({ id: 200, kind: 'task', to_agent: 'boss-atm014-dead', description: 'orig desc' })
    await (reconciler as any).handleDeadSession(task, makeResult())

    const rows = taskDb.run(db => getFailureClassifications(db, { taskId: 200 }))
    const deadRows = rows.filter(r => r.signal_source === 'watchdog_dead_session')
    expect(deadRows.length).toBe(1)
    expect(deadRows[0]!.failure_class).toBe('liveness_timeout')
    expect(deadRows[0]!.severity).toBe('critical')
    expect(deadRows[0]!.transience).toBe('permanent')
  })

  test('ATM-014: :662 timeout fault (handleHeartbeatOverdue) persists a liveness_timeout/high/watchdog_fault row', async () => {
    fresh()
    seedAgentSession(taskDb, 'sadie-atm014-timeout')
    seedTaskRow(taskDb, 11, 'sadie-atm014-timeout')
    const task = makeTask({
      id: 11,
      kind: 'task',
      to_agent: 'sadie-atm014-timeout',
      status: 'in_progress',
      last_heartbeat_at: '2000-01-01 00:00:00', // deeply overdue
      worker_session_id: 'sess-x',
    })
    await (reconciler as any).handleHeartbeatOverdue(task, 300, makeResult())

    const rows = taskDb.run(db => getFailureClassifications(db, { taskId: 11 }))
    const timeoutRows = rows.filter(r => r.signal_source === 'watchdog_fault')
    expect(timeoutRows.length).toBe(1)
    expect(timeoutRows[0]!.failure_class).toBe('liveness_timeout')
    expect(timeoutRows[0]!.severity).toBe('high')
  })

  test('ATM-014: :959 session-level crash (checkAgentSessions) persists a liveness_timeout/critical row keyed by agent, task_id null', async () => {
    fresh()
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO agent_sessions (agent, session_id, last_seen_at, state)
        VALUES ('ghost-agent-atm014', 'sess-ghost', datetime('now', '-999999 seconds'), 'alive')
      `).run()
    })
    await reconciler.checkAgentSessions()

    const rows = taskDb.run(db => getFailureClassifications(db, { agent: 'ghost-agent-atm014' }))
    const crashRows = rows.filter(r => r.signal_source === 'watchdog_fault')
    expect(crashRows.length).toBe(1)
    expect(crashRows[0]!.failure_class).toBe('liveness_timeout')
    expect(crashRows[0]!.task_id).toBeNull()
  })

  const blockedCases: { blockedOn: BlockedOn | null; expectedDomain: FailureDomain }[] = [
    { blockedOn: 'human', expectedDomain: 'human' },
    { blockedOn: 'external_api', expectedDomain: 'external_api' },
    { blockedOn: 'upstream_task', expectedDomain: 'upstream_task' },
    { blockedOn: 'agent', expectedDomain: 'agent' },
    { blockedOn: null, expectedDomain: 'unknown' },
  ]
  let blockedTaskId = 300
  for (const { blockedOn, expectedDomain } of blockedCases) {
    test(`ATM-014: :368 blocked_on=${blockedOn} persists exactly ONE blocked_dependency/domain=${expectedDomain}/watchdog_blocked row`, async () => {
      fresh()
      const id = blockedTaskId++
      const task = makeTask({
        id,
        kind: 'task',
        to_agent: 'steve-atm014-blocked',
        status: 'in_progress',
        blocked_at: freshTimestamp(),
        blocked_on: blockedOn,
        blocked_reason: 'testing',
      })
      await (reconciler as any).reconcileTask(task, makeResult())

      const rows = taskDb.run(db => getFailureClassifications(db, { taskId: id }))
      const blockedRows = rows.filter(r => r.signal_source === 'watchdog_blocked')
      expect(blockedRows.length).toBe(1)
      expect(blockedRows[0]!.failure_class).toBe('blocked_dependency')
      expect(blockedRows[0]!.domain).toBe(expectedDomain)
    })
  }
})

// ---------------------------------------------------------------------------
// ATM-014: flag OFF — zero rows, existing behavior byte-identical
// ---------------------------------------------------------------------------
describe('ATM-014: watchdog.ts failure-classification wiring (flag OFF) — zero rows, behavior unchanged', () => {
  const TEST_DB = '/tmp/p6-watchdog-atm014-off.db'
  let taskDb: TaskDB
  let audit: AuditLog
  let reconciler: TaskReconciler

  function fresh(): void {
    wipeDbFile(TEST_DB)
    taskDb = new TaskDB(TEST_DB) // flag defaults to 0/OFF per ATM-027
    audit = new AuditLog(taskDb)
    reconciler = new TaskReconciler(taskDb, audit)
  }

  afterEach(() => wipeDbFile(TEST_DB))

  test('ATM-014: flag OFF — crash/timeout/blocked/dead-session/session-crash all persist ZERO failure_classifications rows', async () => {
    fresh()
    seedAgentSession(taskDb, 'kiera-atm014off')
    seedAgentSession(taskDb, 'sadie-atm014off')
    seedAgentSession(taskDb, 'steve-atm014off')

    await (reconciler as any).handleDeadSession(makeTask({ id: 500, kind: 'task', to_agent: 'kiera-atm014off' }), makeResult())
    await (reconciler as any).handleHeartbeatOverdue(
      makeTask({ id: 501, kind: 'task', to_agent: 'sadie-atm014off', last_heartbeat_at: '2000-01-01 00:00:00' }),
      300,
      makeResult(),
    )
    await (reconciler as any).reconcileTask(
      makeTask({
        id: 502, kind: 'task', to_agent: 'steve-atm014off', status: 'in_progress',
        blocked_at: freshTimestamp(), blocked_on: 'human', blocked_reason: 'x',
      }),
      makeResult(),
    )
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO agent_sessions (agent, session_id, last_seen_at, state)
        VALUES ('ghost-agent-atm014off', 'sess-ghost', datetime('now', '-999999 seconds'), 'alive')
      `).run()
    })
    await reconciler.checkAgentSessions()

    const count = taskDb.run(db => (db.prepare('SELECT count(*) AS n FROM failure_classifications').get() as { n: number })).n
    expect(count).toBe(0)
  })

  test('ATM-014: flag OFF — dead-session escalation still produces the exact "ESCALATION L{n}: ... worker session dead, task abandoned" string', async () => {
    fresh()
    seedAgentSession(taskDb, 'boss-atm014off')
    const task = makeTask({ id: 400, kind: 'task', to_agent: 'boss-atm014off', description: 'orig desc', escalation_level: 2 })
    await (reconciler as any).handleDeadSession(task, makeResult())

    const escTask = taskDb.run(db => db.prepare(
      "SELECT description FROM tasks WHERE from_agent = 'watchdog' AND description LIKE 'ESCALATION L%'"
    ).get()) as { description: string } | undefined
    expect(escTask).toBeDefined()
    expect(escTask!.description).toBe(
      'ESCALATION L3: Task #400 (boss-atm014off) — worker session dead, task abandoned. Original: orig desc',
    )
  })

  test('ATM-014: flag OFF — recordFault mutation (agent_sessions.fault_count/circuit_state) is unaffected', async () => {
    fresh()
    seedAgentSession(taskDb, 'kiera-atm014off-fault')
    await (reconciler as any).handleDeadSession(makeTask({ id: 600, kind: 'task', to_agent: 'kiera-atm014off-fault' }), makeResult())

    const row = taskDb.run(db => db.prepare(
      'SELECT fault_count, last_fault_type FROM agent_sessions WHERE agent = ?'
    ).get('kiera-atm014off-fault')) as { fault_count: number; last_fault_type: string } | undefined
    expect(row).toBeDefined()
    expect(row!.fault_count).toBe(1)
    expect(row!.last_fault_type).toBe('crash')
  })
})

// ---------------------------------------------------------------------------
// ATM-015: regression-lock — signatures/semantics unchanged + fault-injection
// ---------------------------------------------------------------------------
describe('ATM-015: regression-lock — recordFault signature, column semantics, determineAction(), and per-site fault-injection', () => {
  test('ATM-015(a): recordFault(agent: string, faultType: string): { circuit_state: string; fault_count: number } signature unchanged (source snapshot)', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'db.ts'), 'utf8')
    expect(source).toContain(
      "recordFault(agent: string, faultType: string): { circuit_state: string; fault_count: number } {",
    )
  })

  test('ATM-015(a): determineAction(nudgeCount) unchanged — 0/1/2+ map to first_nudge/second_nudge/escalate', () => {
    expect(determineAction(0)).toBe('first_nudge')
    expect(determineAction(1)).toBe('second_nudge')
    expect(determineAction(2)).toBe('escalate')
    expect(determineAction(99)).toBe('escalate')
  })

  test('ATM-015(b): watchdog.ts additive edits did not alter the pre-existing recordFault/blockedOn call-site lines', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'watchdog.ts'), 'utf8')
    expect(source).toContain("this.taskDb.recordFault(task.to_agent, 'crash')")
    expect(source).toContain("this.taskDb.recordFault(task.to_agent, 'timeout')")
    expect(source).toContain("this.taskDb.recordFault(session.agent, 'crash')")
    expect(source).toContain('const blockedOn = (task as any).blocked_on as string | null')
    expect(source).toContain('const escalationDesc = `ESCALATION L${level + 1}:')
  })

  // -------------------------------------------------------------------------
  // Fault-injection: a thrown failure-classification persist at EACH of the 5
  // call sites leaves the pre-existing mutations completing identically.
  // -------------------------------------------------------------------------

  function brokenPersistenceDb(path: string): TaskDB {
    wipeDbFile(path)
    const taskDb = new TaskDB(path)
    taskDb.setFeatureFlag('failure_classification_enabled', true)
    // Force ANY persistFailureClassification() call to throw, at every site.
    taskDb.run(db => db.exec('DROP TABLE failure_classifications'))
    return taskDb
  }

  test('ATM-015(c): fault-injection at :557 (crash, handleDeadSession) — agent_sessions.fault_count mutation completes identically, no throw escapes', async () => {
    const TEST_DB = '/tmp/p6-watchdog-atm015-557.db'
    const taskDb = brokenPersistenceDb(TEST_DB)
    seedAgentSession(taskDb, 'kiera-atm015-557')
    const audit = new AuditLog(taskDb)
    const reconciler = new TaskReconciler(taskDb, audit)

    let threw = false
    try {
      await (reconciler as any).handleDeadSession(makeTask({ id: 700, kind: 'task', to_agent: 'kiera-atm015-557' }), makeResult())
    } catch { threw = true }
    expect(threw).toBe(false)

    const row = taskDb.run(db => db.prepare('SELECT fault_count FROM agent_sessions WHERE agent = ?').get('kiera-atm015-557')) as { fault_count: number } | undefined
    expect(row?.fault_count).toBe(1)
    wipeDbFile(TEST_DB)
  })

  test('ATM-015(c): fault-injection at :568 (dead-session escalation) — the escalation task row + ESCALATION string is still created identically, no throw escapes', async () => {
    const TEST_DB = '/tmp/p6-watchdog-atm015-568.db'
    const taskDb = brokenPersistenceDb(TEST_DB)
    seedAgentSession(taskDb, 'boss-atm015-568')
    const audit = new AuditLog(taskDb)
    const reconciler = new TaskReconciler(taskDb, audit)

    let threw = false
    try {
      await (reconciler as any).handleDeadSession(
        makeTask({ id: 701, kind: 'task', to_agent: 'boss-atm015-568', description: 'orig', escalation_level: 0 }),
        makeResult(),
      )
    } catch { threw = true }
    expect(threw).toBe(false)

    const escTask = taskDb.run(db => db.prepare(
      "SELECT description FROM tasks WHERE from_agent = 'watchdog' AND description LIKE 'ESCALATION L%'"
    ).get()) as { description: string } | undefined
    expect(escTask?.description).toBe(
      'ESCALATION L1: Task #701 (boss-atm015-568) — worker session dead, task abandoned. Original: orig',
    )
    wipeDbFile(TEST_DB)
  })

  test('ATM-015(c): fault-injection at :662 (timeout, handleHeartbeatOverdue) — agent_sessions.fault_count/last_fault_type mutation completes identically, no throw escapes', async () => {
    const TEST_DB = '/tmp/p6-watchdog-atm015-662.db'
    const taskDb = brokenPersistenceDb(TEST_DB)
    seedAgentSession(taskDb, 'sadie-atm015-662')
    seedTaskRow(taskDb, 702, 'sadie-atm015-662')
    const audit = new AuditLog(taskDb)
    const reconciler = new TaskReconciler(taskDb, audit)

    let threw = false
    try {
      await (reconciler as any).handleHeartbeatOverdue(
        makeTask({ id: 702, kind: 'task', to_agent: 'sadie-atm015-662', last_heartbeat_at: '2000-01-01 00:00:00' }),
        300,
        makeResult(),
      )
    } catch { threw = true }
    expect(threw).toBe(false)

    const row = taskDb.run(db => db.prepare('SELECT fault_count, last_fault_type FROM agent_sessions WHERE agent = ?').get('sadie-atm015-662')) as { fault_count: number; last_fault_type: string } | undefined
    expect(row?.fault_count).toBe(1)
    expect(row?.last_fault_type).toBe('timeout')
    wipeDbFile(TEST_DB)
  })

  test('ATM-015(c): fault-injection at :368 (blocked) — the blocked_relay_count/next_check_at mutation completes identically, no throw escapes', async () => {
    const TEST_DB = '/tmp/p6-watchdog-atm015-368.db'
    const taskDb = brokenPersistenceDb(TEST_DB)
    const audit = new AuditLog(taskDb)
    const reconciler = new TaskReconciler(taskDb, audit)
    const id = 703
    // Insert a real tasks row so the UPDATE inside the long-block branch has
    // something to mutate (id-only UPDATEs elsewhere in this file are no-ops
    // against a non-existent row, which is fine for those; here we want to
    // observe the mutation, so seed a matching row).
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO tasks (id, from_agent, to_agent, description, priority, status, supervisor_agent, blocked_at, blocked_reason, blocked_on)
        VALUES (?, 'boss', 'steve-atm015-368', 'x', 'normal', 'in_progress', 'boss', ?, 'testing', 'human')
      `).run(id, freshTimestamp())
    })
    const task = makeTask({
      id, kind: 'task', to_agent: 'steve-atm015-368', status: 'in_progress',
      blocked_at: freshTimestamp(), blocked_on: 'human', blocked_reason: 'testing',
    })

    let threw = false
    try {
      await (reconciler as any).reconcileTask(task, makeResult())
    } catch { threw = true }
    expect(threw).toBe(false)

    const row = taskDb.run(db => db.prepare('SELECT blocked_relay_count FROM tasks WHERE id = ?').get(id)) as { blocked_relay_count: number } | undefined
    expect(row?.blocked_relay_count).toBe(1)
    wipeDbFile(TEST_DB)
  })

  test('ATM-015(c): fault-injection at :959 (session-level crash, checkAgentSessions) — agent_sessions.state/fault_count mutation completes identically, no throw escapes', async () => {
    const TEST_DB = '/tmp/p6-watchdog-atm015-959.db'
    const taskDb = brokenPersistenceDb(TEST_DB)
    const audit = new AuditLog(taskDb)
    const reconciler = new TaskReconciler(taskDb, audit)
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO agent_sessions (agent, session_id, last_seen_at, state)
        VALUES ('ghost-agent-atm015-959', 'sess-ghost', datetime('now', '-999999 seconds'), 'alive')
      `).run()
    })

    let threw = false
    try {
      await reconciler.checkAgentSessions()
    } catch { threw = true }
    expect(threw).toBe(false)

    const row = taskDb.run(db => db.prepare('SELECT state, fault_count FROM agent_sessions WHERE agent = ?').get('ghost-agent-atm015-959')) as { state: string; fault_count: number } | undefined
    expect(row?.state).toBe('dead')
    expect(row?.fault_count).toBe(1)
    wipeDbFile(TEST_DB)
  })
})
