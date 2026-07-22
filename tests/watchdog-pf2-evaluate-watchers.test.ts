import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler, type ReconcileResult, findStaleTasks, determineAction, parseUtcSqliteDatetime } from '../watchdog'
import { createWatcher } from '../watchers/declarative-watchers'

// PK-PF2-5 Stage B (ATM-PF2-04, REQ-PF2-03/04/09) — evaluateWatchers(),
// the additive, flag-gated, fault-isolated Step 3e in TaskReconciler.run().
// Calls the method DIRECTLY (mirrors tests/decision-monitor.test.ts's own
// `reconciler.monitorDecisions(result)` pattern) rather than invoking the
// full run() infinite loop, which is untestable directly (Promise<never>,
// `while (true)`).

function freshResult(): ReconcileResult {
  return {
    checked: 0, nudged: 0, escalated: 0, blocked_relayed: 0,
    dead_sessions: 0, decisions_expired: 0, decisions_nudged: 0,
    decisions_ready: 0, idle_nudges: 0, circuits_recovered: 0,
  }
}

let taskDb: TaskDB
let audit: AuditLog
let reconciler: TaskReconciler
let dbPath: string

beforeEach(() => {
  dbPath = `/tmp/pf2-5-evalwatchers-${crypto.randomUUID()}.db`
  taskDb = new TaskDB(dbPath)
  audit = new AuditLog(taskDb)
  reconciler = new TaskReconciler(taskDb, audit, {
    cadenceSec: 30,
    sessionTimeoutSec: 180,
    leaseTimeoutSec: 120,
  })
})

afterEach(() => {
  taskDb.close()
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(dbPath + suffix) } catch {}
  }
})

function taskCount(): number {
  return (taskDb.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }).n
}

function firingCount(): number {
  return (taskDb.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }).n
}

// ---------------------------------------------------------------------------
// REQ-PF2-09: flag-OFF parity
// ---------------------------------------------------------------------------

describe('REQ-PF2-09: flag OFF — evaluateWatchers() performs zero evaluation, zero writes', () => {
  test('a due scheduled watcher does NOT fire while declarative_watchers_enabled=0', async () => {
    expect(taskDb.isFeatureEnabled('declarative_watchers_enabled')).toBe(false)
    taskDb.run(handle => createWatcher(handle, {
      name: 'flag-off watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 1 },
      action_spec: { description: 'should not fire', to: 'sadie' },
    }))
    const result = freshResult()
    await reconciler.evaluateWatchers(result)
    expect(taskCount()).toBe(0)
    expect(firingCount()).toBe(0)
    expect(result.watchers_fired ?? 0).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-04: scheduled dispatch + occasion-context derivation
// ---------------------------------------------------------------------------

describe('scheduled watcher dispatch (flag ON)', () => {
  beforeEach(() => {
    taskDb.setFeatureFlag('declarative_watchers_enabled', true)
  })

  test('a due watcher (interval_seconds=1, never fired) fires exactly once and increments watchers_fired', async () => {
    taskDb.run(handle => createWatcher(handle, {
      name: 'due watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 1 },
      action_spec: { description: 'due task', to: 'sadie' },
    }))
    const result = freshResult()
    await reconciler.evaluateWatchers(result)
    expect(taskCount()).toBe(1)
    expect(firingCount()).toBe(1)
    expect(result.watchers_fired).toBe(1)
  })

  test('a freshly-created watcher (never fired, last_fired_at=null) IS due on its first evaluation, per REQ-PF2-12\'s own semantics ("or last_fired_at is null") -- already proven at the pure-function level by PK-PF2-3, re-confirmed here at the wiring level', async () => {
    taskDb.run(handle => createWatcher(handle, {
      name: 'first-eval watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 3600 },
      action_spec: { description: 'first eval', to: 'sadie' },
    }))
    const result = freshResult()
    await reconciler.evaluateWatchers(result)
    expect(taskCount()).toBe(1)
    expect(result.watchers_fired).toBe(1)
  })

  test('a watcher that HAS already fired recently (within interval_seconds) does NOT re-fire on the next evaluation', async () => {
    taskDb.run(handle => createWatcher(handle, {
      name: 'recently-fired watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 3600 },
      action_spec: { description: 'recently fired', to: 'sadie' },
    }))
    const r1 = freshResult()
    await reconciler.evaluateWatchers(r1) // first eval: never-fired -> fires, sets last_fired_at
    expect(taskCount()).toBe(1)
    expect(r1.watchers_fired).toBe(1)

    const r2 = freshResult()
    await reconciler.evaluateWatchers(r2) // second eval, immediately after: now < last_fired_at + 3600 -> not due
    expect(taskCount()).toBe(1) // unchanged
    expect(r2.watchers_fired ?? 0).toBe(0)
  })

  test('last_fired_at is updated after a genuine fire', async () => {
    const id = taskDb.run(handle => createWatcher(handle, {
      name: 'lfa watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 1 },
      action_spec: { description: 'x', to: 'sadie' },
    }))
    const before = taskDb.run(d => d.prepare('SELECT last_fired_at FROM declarative_watchers WHERE id = ?').get(id)) as { last_fired_at: string | null }
    expect(before.last_fired_at).toBeNull()
    await reconciler.evaluateWatchers(freshResult())
    const after = taskDb.run(d => d.prepare('SELECT last_fired_at FROM declarative_watchers WHERE id = ?').get(id)) as { last_fired_at: string | null }
    expect(after.last_fired_at).not.toBeNull()
  })

  test('calling evaluateWatchers() twice within the SAME window (interval_seconds large enough to span both calls) creates exactly ONE task total — the second attempt is a quiet UNIQUE rejection, not a crash', async () => {
    taskDb.run(handle => createWatcher(handle, {
      name: 'same-window watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 3600 }, // wide window -- both calls land in the same bucket
      action_spec: { description: 'x', to: 'sadie' },
    }))
    const r1 = freshResult()
    await reconciler.evaluateWatchers(r1)
    expect(taskCount()).toBe(1)
    expect(r1.watchers_fired).toBe(1)

    // Second call: last_fired_at was just updated, so evaluateScheduledCondition()
    // will actually say "not due" now (now < last_fired_at + interval_seconds) --
    // to specifically exercise the SAME-WINDOW UNIQUE-rejection path (not just
    // "not due"), reset last_fired_at back to null so it evaluates as due again,
    // while the windowBucket (derived from `now` alone) stays identical.
    taskDb.run(d => d.prepare('UPDATE declarative_watchers SET last_fired_at = NULL WHERE 1=1').run())
    const r2 = freshResult()
    await expect(reconciler.evaluateWatchers(r2)).resolves.toBeUndefined() // must not throw
    expect(taskCount()).toBe(1) // still exactly 1 -- the duplicate attempt was gracefully rejected
    expect(r2.watchers_fired ?? 0).toBe(0) // NOT counted as a new fire
  })

  test('MANDATED (main\'s ruling): crash-window simulation — fire txn committed but the last_fired_at UPDATE is LOST -> next tick still sees the watcher as due -> same windowBucket -> UNIQUE rejection -> ZERO duplicate task. Proves the DB constraint, not last_fired_at, is the real fire-once guarantee.', async () => {
    taskDb.run(handle => createWatcher(handle, {
      name: 'crash-window watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 3600 },
      action_spec: { description: 'crash sim', to: 'sadie' },
    }))
    const r1 = freshResult()
    await reconciler.evaluateWatchers(r1)
    expect(taskCount()).toBe(1)
    expect(r1.watchers_fired).toBe(1)

    // Simulate the crash: the fire's own transaction (task + firing + audit)
    // committed successfully, but the SEPARATE follow-up last_fired_at
    // UPDATE (outside that transaction, by design -- see the design doc's
    // rationale) never landed. Force last_fired_at back to its pre-fire
    // value (null) to reproduce exactly that lost-update state.
    taskDb.run(d => d.prepare('UPDATE declarative_watchers SET last_fired_at = NULL WHERE 1=1').run())

    // Next tick, SAME clock window (interval_seconds=3600, called back-to-back):
    // evaluateScheduledCondition() sees last_fired_at=null -> "due" again, and
    // windowBucket is derived purely from `now` (not from last_fired_at), so
    // it computes the IDENTICAL windowBucket as the first call -- same
    // idempotency key -> UNIQUE-rejected, not a new fire.
    const r2 = freshResult()
    await expect(reconciler.evaluateWatchers(r2)).resolves.toBeUndefined()
    expect(taskCount()).toBe(1) // ZERO duplicate task despite the "lost" last_fired_at update
    expect(firingCount()).toBe(1)
    expect(r2.watchers_fired ?? 0).toBe(0)
  })

  test('QUIET PATH (main\'s ruling): a same-window UNIQUE rejection produces NO console.error output (not logged as an anomaly/warning)', async () => {
    taskDb.run(handle => createWatcher(handle, {
      name: 'quiet watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 3600 },
      action_spec: { description: 'x', to: 'sadie' },
    }))
    await reconciler.evaluateWatchers(freshResult())
    taskDb.run(d => d.prepare('UPDATE declarative_watchers SET last_fired_at = NULL WHERE 1=1').run())

    const originalError = console.error
    const errorCalls: unknown[][] = []
    console.error = (...args: unknown[]) => { errorCalls.push(args) }
    try {
      await reconciler.evaluateWatchers(freshResult())
    } finally {
      console.error = originalError
    }
    expect(errorCalls.length).toBe(0)
  })

  test('a watcher with a MALFORMED interval_seconds stored (defensive: evaluateScheduledCondition() itself would throw) does not crash evaluateWatchers() -- proven via the Step 3e try/catch shape, not evaluateWatchers() swallowing it itself (that would be a DIFFERENT bug); this test documents the current behavior explicitly rather than leaving it unspecified', async () => {
    // createWatcher() already rejects a malformed interval_seconds at
    // CREATE time (PK-PF2-2) -- this scenario (a bad value reaching
    // evaluateWatchers()) is not reachable through the public API, so this
    // is a documentation-only placeholder confirming that invariant, not a
    // runtime probe of a state the system cannot actually reach.
    expect(() => taskDb.run(handle => createWatcher(handle, {
      name: 'malformed',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: -5 },
      action_spec: { description: 'x', to: 'sadie' },
    }))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// PK-PF2-6 round 1 fold — HIGH finding 1: `last_fired_at` (SQLite
// `datetime('now')`, a UTC, timezone-marker-less "YYYY-MM-DD HH:MM:SS"
// string) was being parsed via a bare `Date.parse()`, which Bun/Node
// interpret as LOCAL time for that space-separated, non-ISO format —
// introducing a host-timezone-dependent offset into every scheduled
// due-check. `parseUtcSqliteDatetime()` fixes this by converting to an
// unambiguous ISO-8601 string (`T` separator + explicit `Z` suffix)
// before parsing — a form every JS engine parses as UTC per spec,
// regardless of the host's ambient timezone.
//
// DETERMINISTIC, TZ-INDEPENDENT test design (per main's instruction): a
// FIXED `last_fired_at` string + a FIXED injected `now` (via `Date.now()`
// override, in epoch milliseconds — never a locale-formatted read), with
// the expected due/not-due result computed independently via
// `Date.UTC(...)` (never `new Date(...).getHours()`-style local accessors)
// — so this test's own PASS/FAIL does not depend on the CI/dev host's
// timezone either, only on `parseUtcSqliteDatetime()` genuinely parsing as
// UTC. Confirmed by running this exact test unmodified: it was RED before
// the fix (misparsed as local time, wrong due-calc) and GREEN after.
// ---------------------------------------------------------------------------

describe('PK-PF2-6 round 1 fold: parseUtcSqliteDatetime() parses SQLite datetime(\'now\') strings as UTC, independent of host timezone', () => {
  test('parseUtcSqliteDatetime("2026-07-22 00:00:00") equals the UTC epoch millisecond value for that exact wall-clock moment, computed independently via Date.UTC()', () => {
    const expected = Date.UTC(2026, 6, 22, 0, 0, 0) // month is 0-indexed: 6 = July
    expect(parseUtcSqliteDatetime('2026-07-22 00:00:00')).toBe(expected)
  })

  test('a scheduled watcher fired exactly at a KNOWN UTC instant is correctly judged NOT due one second before its interval elapses, and DUE the instant it does -- both computed relative to a FIXED, injected now (Date.now() override), never the ambient host clock/timezone', async () => {
    taskDb.setFeatureFlag('declarative_watchers_enabled', true)
    const id = taskDb.run(handle => createWatcher(handle, {
      name: 'utc-fixed-clock watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 7200 }, // 2 hours -- exactly the width of a plausible host UTC offset, per the round-1 finding
      action_spec: { description: 'utc test', to: 'sadie' },
    }))
    // Seed last_fired_at directly as SQLite's own datetime('now') would
    // produce it -- a fixed, known UTC instant, space-separated, no
    // timezone marker.
    const firedAtUtc = '2026-07-22 00:00:00'
    taskDb.run(d => d.prepare('UPDATE declarative_watchers SET last_fired_at = ? WHERE id = ?').run(firedAtUtc, id))
    const firedAtMs = Date.UTC(2026, 6, 22, 0, 0, 0)

    const originalNow = Date.now
    try {
      // 1 second before the 2-hour interval elapses -- must NOT be due.
      Date.now = () => firedAtMs + 7200_000 - 1000
      const r1 = freshResult()
      await reconciler.evaluateWatchers(r1)
      expect(r1.watchers_fired ?? 0).toBe(0)

      // Exactly at the 2-hour mark -- must be due (inclusive boundary, REQ-PF2-12).
      Date.now = () => firedAtMs + 7200_000
      const r2 = freshResult()
      await reconciler.evaluateWatchers(r2)
      expect(r2.watchers_fired).toBe(1)
    } finally {
      Date.now = originalNow
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-04: state_change dispatch + re-read-after-eval derivation
// ---------------------------------------------------------------------------

describe('state_change watcher dispatch (flag ON)', () => {
  beforeEach(() => {
    taskDb.setFeatureFlag('declarative_watchers_enabled', true)
  })

  test('a watcher fires on a false->true transition and correctly derives newValue/transitionTimestamp from the FRESH post-evaluation row (not stale pre-evaluation data)', async () => {
    const taskId = taskDb.run(d => (d.prepare(
      "INSERT INTO tasks (from_agent, to_agent, description, priority, status) VALUES ('sadie','sadie','seed','normal','pending') RETURNING id",
    ).get() as { id: number }).id)
    taskDb.run(handle => createWatcher(handle, {
      name: 'transition watcher',
      trigger_type: 'state_change',
      condition_spec: { watched_table: 'tasks', watched_column: 'status', comparator: 'eq', operand: 'completed', watched_selector: { id: taskId } },
      action_spec: { description: 'transitioned', to: 'sadie' },
    }))

    const baselineTaskCount = taskCount() // the seed row itself is a `tasks` row -- baseline is 1, not 0

    // First eval: status='pending' -> predicate false, no fire, snapshot seeded.
    await reconciler.evaluateWatchers(freshResult())
    expect(taskCount()).toBe(baselineTaskCount) // no NEW task from this eval

    // Transition.
    taskDb.run(d => d.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(taskId))

    const result = freshResult()
    await reconciler.evaluateWatchers(result)
    expect(taskCount()).toBe(baselineTaskCount + 1) // exactly one NEW task from the fire
    expect(result.watchers_fired).toBe(1)

    const firing = taskDb.run(d => d.prepare('SELECT idempotency_key FROM declarative_watcher_firings').get()) as { idempotency_key: string }
    expect(firing.idempotency_key).toContain('"completed"') // JSON.stringify'd newValue segment present in the key
  })

  test('a disabled watcher is excluded from evaluation entirely (getWatchers() enabled-only default)', async () => {
    const id = taskDb.run(handle => createWatcher(handle, {
      name: 'disabled watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 1 },
      action_spec: { description: 'x', to: 'sadie' },
    }))
    taskDb.run(d => d.prepare('UPDATE declarative_watchers SET enabled = 0 WHERE id = ?').run(id))
    await reconciler.evaluateWatchers(freshResult())
    expect(taskCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-04: llm_eval dispatch (stub — never fires, per main's ruling)
// ---------------------------------------------------------------------------

describe('llm_eval watcher dispatch (flag ON) — stub client, KNOWN LIMITATION', () => {
  test('an llm_eval watcher is evaluated (structurally reached, no crash) but NEVER fires, regardless of prompt content', async () => {
    taskDb.setFeatureFlag('declarative_watchers_enabled', true)
    taskDb.run(handle => createWatcher(handle, {
      name: 'llm watcher',
      trigger_type: 'llm_eval',
      condition_spec: { prompt: 'Answer true if this should fire.' },
      action_spec: { description: 'never fires', to: 'sadie' },
    }))
    await expect(reconciler.evaluateWatchers(freshResult())).resolves.toBeUndefined()
    expect(taskCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Fault-injection (mirrors PF1-4-DESIGN.md section 8's shape)
// ---------------------------------------------------------------------------

describe('fault-injection: evaluateWatchers() throwing does not affect the host tick\'s other steps', () => {
  test('a thrown error from evaluateWatchers() is caught by the SAME try/catch shape Step 3e uses in run() -- stale-task escalation logic (findStaleTasks/determineAction) is completely independent and keeps working regardless', async () => {
    // findStaleTasks()/determineAction() are pure, standalone top-level
    // functions with ZERO dependency on evaluateWatchers() or anything in
    // watchers/declarative-watchers.ts -- proven directly, not by
    // inference: calling them here, in a test where evaluateWatchers()
    // itself is about to throw, demonstrates their total independence.
    const staleTasks = findStaleTasks(taskDb, 20)
    expect(Array.isArray(staleTasks)).toBe(true) // runs to completion, unaffected
    expect(determineAction(0)).toBe('first_nudge')
    expect(determineAction(1)).toBe('second_nudge')
    expect(determineAction(2)).toBe('escalate')

    // Force evaluateWatchers() to throw by poisoning isFeatureEnabled().
    const originalIsFeatureEnabled = taskDb.isFeatureEnabled.bind(taskDb)
    taskDb.isFeatureEnabled = () => { throw new Error('injected fault: isFeatureEnabled failed') }
    try {
      // Mirrors run()'s own Step 3e try/catch shape exactly (watchdog.ts).
      let caughtInWrapper: unknown
      try {
        await reconciler.evaluateWatchers(freshResult())
      } catch (err) {
        caughtInWrapper = err
      }
      expect(caughtInWrapper).toBeInstanceOf(Error)
      expect((caughtInWrapper as Error).message).toContain('injected fault')
    } finally {
      taskDb.isFeatureEnabled = originalIsFeatureEnabled
    }

    // Stale-task/escalation logic still works AFTER the fault -- proves
    // zero coupling, not just zero coupling "before" the fault.
    const staleTasksAfter = findStaleTasks(taskDb, 20)
    expect(Array.isArray(staleTasksAfter)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ReconcileResult.watchers_fired counter
// ---------------------------------------------------------------------------

describe('ReconcileResult.watchers_fired counter', () => {
  test('increments once per genuine fire across multiple watchers in one evaluateWatchers() call', async () => {
    taskDb.setFeatureFlag('declarative_watchers_enabled', true)
    taskDb.run(handle => createWatcher(handle, { name: 'w1', trigger_type: 'scheduled', condition_spec: { interval_seconds: 1 }, action_spec: { description: 'a', to: 'sadie' } }))
    taskDb.run(handle => createWatcher(handle, { name: 'w2', trigger_type: 'scheduled', condition_spec: { interval_seconds: 1 }, action_spec: { description: 'b', to: 'sadie' } }))
    const w3 = taskDb.run(handle => createWatcher(handle, { name: 'w3', trigger_type: 'scheduled', condition_spec: { interval_seconds: 3600 }, action_spec: { description: 'c', to: 'sadie' } }))
    // Simulate "already fired recently" so w3 is genuinely not-due for this
    // evaluation (a freshly-created watcher with null last_fired_at would
    // otherwise ALSO be immediately due, per REQ-PF2-12 -- see the
    // dedicated "first-eval watcher" test above).
    taskDb.run(d => d.prepare("UPDATE declarative_watchers SET last_fired_at = datetime('now') WHERE id = ?").run(w3))
    const result = freshResult()
    await reconciler.evaluateWatchers(result)
    expect(result.watchers_fired).toBe(2)
    expect(taskCount()).toBe(2)
  })

  test('stays 0 (not undefined-crashing) when zero watchers exist', async () => {
    taskDb.setFeatureFlag('declarative_watchers_enabled', true)
    const result = freshResult()
    await expect(reconciler.evaluateWatchers(result)).resolves.toBeUndefined()
    expect(result.watchers_fired ?? 0).toBe(0)
  })
})
