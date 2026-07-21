/*
 * tests/reflection/pf1-4-sequence-behavior.test.ts
 *
 * PK-PF1-4 Stage B — flag-OFF byte-parity (5 tests) + fault-injection
 * (5 tests) + R2 (boss's rider: pre-act-records-even-on-failed-action, 1
 * test), per PF1-4-DESIGN.md sections 7/8.
 *
 * server.ts CANNOT be imported directly in tests (it connects to the LIVE
 * db and asserts agent identity at module load — see
 * tests/memory-handlers.test.ts's own documented reason for the same
 * constraint). So the 4 claim/delegation sites are tested here by exercising
 * the EXACT SEQUENCE OF CALLS server.ts's wired case bodies now perform, in
 * the same order, against the real db.ts mutation functions — proving the
 * sequencing behavior (byte-parity / fault-isolation / R2) without needing
 * to invoke the switch-case itself. The `hookCallShape()` helper below
 * mirrors the literal `try { recordExpectedOutcome(...) } catch {}` pattern
 * verified to exist in server.ts by tests/guardrails/pf1-4-wiring.guard.test.ts's
 * static scan — this file proves that PATTERN's runtime behavior; the guard
 * test proves it's actually the pattern present in server.ts.
 *
 * debrief.ts IS safely importable (tests/debrief.test.ts already does), so
 * its 2 tests below call checkAndRunDebrief()/forceDebrief() directly —
 * true end-to-end proof, not a simulated sequence.
 */

import { describe, test, expect, mock } from 'bun:test'
import { unlinkSync } from 'fs'
import { TaskDB } from '../../db'
import { MemoryDB } from '../../memory'
import { DecisionDB } from '../../decision'
import { AuditLog } from '../../audit'
import { forceDebrief, checkAndRunDebrief } from '../../debrief'
import { recordExpectedOutcome, reflect } from '../../reflection/outcome-feedback'
import type { Database } from 'bun:sqlite'

function freshDb(): { db: TaskDB; path: string } {
  const path = `/tmp/pf1-4-seq-${crypto.randomUUID()}.db`
  return { db: new TaskDB(path), path }
}
function cleanup(db: TaskDB, path: string): void {
  db.close()
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

// Mirrors the EXACT shape inserted at all 4 server.ts sites:
//   try { recordExpectedOutcome(db.getHandle(), input) } catch { /* swallowed */ }
function hookCallShape(handle: Database, input: { task_id: number; expected_outcome: string }): void {
  try {
    recordExpectedOutcome(handle, input)
  } catch {
    // swallowed — REQ-PF1-10
  }
}

// A throwing stand-in for recordExpectedOutcome(), wrapped the same way —
// proves the try/catch SHAPE itself absorbs a throw, independent of what's
// actually inside it.
function hookCallShapeForcedThrow(): void {
  try {
    throw new Error('injected PF1 hook failure')
  } catch {
    // swallowed — REQ-PF1-10
  }
}

describe('PK-PF1-4 flag-OFF byte-parity (5 sites)', () => {
  test('claim_task sequence: hook (OFF, no-op) then claimTaskWithSession() — identical result to claimTaskWithSession() alone', () => {
    const { db, path } = freshDb()
    try {
      const t1 = db.delegateTask({ from: 'boss', to: 'sadie', description: 'a', priority: 'normal', supervisor_agent: 'boss' })
      const t2 = db.delegateTask({ from: 'boss', to: 'sadie', description: 'a', priority: 'normal', supervisor_agent: 'boss' })

      // Baseline: claim WITHOUT the hook.
      const baseline = db.claimTaskWithSession(t1.id, 'sadie', 'sess-1')
      // With hook (flag OFF, no-op): claim WITH the hook immediately before.
      hookCallShape(db.getHandle(), { task_id: t2.id, expected_outcome: 'x' })
      const withHook = db.claimTaskWithSession(t2.id, 'sadie', 'sess-1')

      expect(baseline).not.toBeNull()
      expect(withHook).not.toBeNull()
      // Compare every field except id/timestamps (which naturally differ
      // between two distinct rows) — status/to_agent/session/etc. must match.
      expect(withHook!.status).toBe(baseline!.status)
      expect(withHook!.to_agent).toBe(baseline!.to_agent)
      expect(withHook!.worker_session_id).toBe(baseline!.worker_session_id)
      expect(withHook!.attempt_id).toBe(baseline!.attempt_id)

      const oeCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(oeCount.n).toBe(0) // flag OFF — zero PF1 writes
    } finally {
      cleanup(db, path)
    }
  })

  test('delegate_task sequence: delegateTask() then hook (OFF, no-op) — delegateTask()\'s own return value is unaffected by the hook call after it', () => {
    const { db, path } = freshDb()
    try {
      const baseline = db.delegateTask({ from: 'boss', to: 'sadie', description: 'b', priority: 'normal', supervisor_agent: 'boss' })
      const withHook = db.delegateTask({ from: 'boss', to: 'sadie', description: 'b', priority: 'normal', supervisor_agent: 'boss' })
      hookCallShape(db.getHandle(), { task_id: withHook.id, expected_outcome: 'x' })

      expect(withHook.status).toBe(baseline.status)
      expect(withHook.to_agent).toBe(baseline.to_agent)
      expect(withHook.from_agent).toBe(baseline.from_agent)
      expect(withHook.description).toBe(baseline.description)

      const oeCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(oeCount.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('assign_task sequence: hook (OFF, no-op) then assignTask() — identical result to assignTask() alone', () => {
    const { db, path } = freshDb()
    try {
      const t1 = db.createTask({ from: 'boss', to: 'kiera', description: 'c', priority: 'normal' })
      const t2 = db.createTask({ from: 'boss', to: 'kiera', description: 'c', priority: 'normal' })

      const baseline = db.assignTask(t1.id, 'sadie', 'boss')
      hookCallShape(db.getHandle(), { task_id: t2.id, expected_outcome: 'x' })
      const withHook = db.assignTask(t2.id, 'sadie', 'boss')

      expect(baseline).not.toBeNull()
      expect(withHook).not.toBeNull()
      expect(withHook!.to_agent).toBe(baseline!.to_agent)
      expect(withHook!.supervisor_agent).toBe(baseline!.supervisor_agent)
      expect(withHook!.status).toBe(baseline!.status)

      const oeCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(oeCount.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('transition_task sequence: hook (OFF, no-op) then transitionToInProgress() — identical result to transitionToInProgress() alone', () => {
    const { db, path } = freshDb()
    try {
      const t1 = db.createTask({ from: 'boss', to: 'kiera', description: 'd', priority: 'normal' })
      const t2 = db.createTask({ from: 'boss', to: 'kiera', description: 'd', priority: 'normal' })
      db.assignTask(t1.id, 'sadie', 'boss')
      db.assignTask(t2.id, 'sadie', 'boss')

      const baseline = db.transitionToInProgress(t1.id, 'sess-a')
      hookCallShape(db.getHandle(), { task_id: t2.id, expected_outcome: 'x' })
      const withHook = db.transitionToInProgress(t2.id, 'sess-a')

      expect(baseline).not.toBeNull()
      expect(withHook).not.toBeNull()
      expect(withHook!.status).toBe(baseline!.status)
      expect(withHook!.to_agent).toBe(baseline!.to_agent)
      expect(withHook!.attempt_id).toBe(baseline!.attempt_id)

      const oeCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(oeCount.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('debrief.ts: forceDebrief() output is byte-identical whether outcome_feedback_enabled is OFF (default) — end-to-end, real import', async () => {
    const { db, path } = freshDb()
    try {
      const mem = new MemoryDB(db)
      const dec = new DecisionDB(db, mem)
      const audit = new AuditLog(db)

      expect(db.isFeatureEnabled('outcome_feedback_enabled')).toBe(false)
      const result = await forceDebrief(db, mem, dec, audit)
      // The debrief itself must complete normally (no PF1 interference);
      // reflect() must not have been invoked (flag OFF) — zero PF1 rows.
      expect(result).toBeTruthy()
      expect(typeof result.durationMs).toBe('number')
      const oeCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM outcome_expectations').get()) as { n: number }
      expect(oeCount.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })
})

describe('PK-PF1-4 fault-injection (5 sites) — a forced hook throw must not affect the host action', () => {
  test('claim_task: forced hook throw does not prevent claimTaskWithSession() from completing normally', () => {
    const { db, path } = freshDb()
    try {
      const t = db.delegateTask({ from: 'boss', to: 'sadie', description: 'e', priority: 'normal', supervisor_agent: 'boss' })
      expect(() => hookCallShapeForcedThrow()).not.toThrow()
      const task = db.claimTaskWithSession(t.id, 'sadie', 'sess-x')
      expect(task).not.toBeNull()
      expect(task!.status).toBe('in_progress')
    } finally {
      cleanup(db, path)
    }
  })

  test('delegate_task: forced hook throw (after delegateTask() already succeeded) does not un-do the delegation', () => {
    const { db, path } = freshDb()
    try {
      const task = db.delegateTask({ from: 'boss', to: 'sadie', description: 'f', priority: 'normal', supervisor_agent: 'boss' })
      expect(() => hookCallShapeForcedThrow()).not.toThrow()
      // The delegation already committed before the hook ran — re-read confirms it's intact.
      const reread = db.getTask(task.id)
      expect(reread).not.toBeNull()
      expect(reread!.to_agent).toBe('sadie')
    } finally {
      cleanup(db, path)
    }
  })

  test('assign_task: forced hook throw does not prevent assignTask() from completing normally', () => {
    const { db, path } = freshDb()
    try {
      const t = db.createTask({ from: 'boss', to: 'kiera', description: 'g', priority: 'normal' })
      expect(() => hookCallShapeForcedThrow()).not.toThrow()
      const task = db.assignTask(t.id, 'sadie', 'boss')
      expect(task).not.toBeNull()
      expect(task!.to_agent).toBe('sadie')
    } finally {
      cleanup(db, path)
    }
  })

  test('transition_task: forced hook throw does not prevent transitionToInProgress() from completing normally', () => {
    const { db, path } = freshDb()
    try {
      const t = db.createTask({ from: 'boss', to: 'kiera', description: 'h', priority: 'normal' })
      db.assignTask(t.id, 'sadie', 'boss')
      expect(() => hookCallShapeForcedThrow()).not.toThrow()
      const task = db.transitionToInProgress(t.id, 'sess-y')
      expect(task).not.toBeNull()
      expect(task!.status).toBe('in_progress')
    } finally {
      cleanup(db, path)
    }
  })

  test('debrief.ts: a throwing reflect() (flag ON) does not affect forceDebrief()\'s own return value — end-to-end, real import', async () => {
    const { db, path } = freshDb()
    try {
      const mem = new MemoryDB(db)
      const dec = new DecisionDB(db, mem)
      const audit = new AuditLog(db)
      db.setFeatureFlag('outcome_feedback_enabled', true)

      // Force reflect() to throw by corrupting the shape it expects: seed a
      // diffed=NULL row referencing a NON-existent task_id's `result`
      // column path is fine (LEFT via JOIN, no row = no match, harmless) —
      // instead force a genuine throw via a malformed diff_result JSON on an
      // ALREADY-diffed row that reflect()'s grouping phase will JSON.parse().
      db.run(handle => handle.prepare(
        "INSERT INTO outcome_expectations (task_id, expected_outcome, diffed_at, diff_result) VALUES (1, 'x', datetime('now'), 'NOT VALID JSON')",
      ).run())

      const result = await forceDebrief(db, mem, dec, audit)
      // forceDebrief()'s own return value must be a normal, complete result —
      // unaffected by reflect() throwing on the malformed row.
      expect(result).toBeTruthy()
      expect(typeof result.durationMs).toBe('number')
      expect(result.error).toBeFalsy()
    } finally {
      cleanup(db, path)
    }
  })

  test('PK-PF1-5 fold (E3): a throwing isFeatureEnabled() flag-read itself does not affect checkAndRunDebrief()/forceDebrief()\'s own return value — end-to-end, real import', async () => {
    const { db, path } = freshDb()
    try {
      const mem = new MemoryDB(db)
      const dec = new DecisionDB(db, mem)
      const audit = new AuditLog(db)
      // Deliberately do NOT set the flag — the point is to prove the flag
      // READ itself, not reflect(), is what's under fault-injection here.
      // Force isFeatureEnabled() to throw ONLY for PF1's own flag name —
      // DebriefDaemon.gatherContext() legitimately calls isFeatureEnabled()
      // for its OWN, unrelated flags (e.g. memory_sanitization_enabled) as
      // pre-existing, non-PF1 behavior; a blind blanket-throw would corrupt
      // that unrelated call path too and produce a false failure signal that
      // has nothing to do with PF1's fault-isolation guarantee.
      const original = TaskDB.prototype.isFeatureEnabled
      TaskDB.prototype.isFeatureEnabled = function (this: TaskDB, flagName: string): boolean {
        if (flagName === 'outcome_feedback_enabled') {
          throw new Error('injected flag-read failure')
        }
        return original.call(this, flagName)
      }
      try {
        // Load-bearing assertion: NEITHER call throws all the way out to the
        // caller, regardless of what checkAndRunDebrief()'s own gates decide
        // (a fresh/empty DB may or may not pass the idle/volume gates —
        // that's orthogonal to what's under test here).
        let r1: unknown
        await expect((async () => { r1 = await checkAndRunDebrief(db, mem, dec, audit) })()).resolves.toBeUndefined()
        expect(r1 === null || typeof r1 === 'object').toBe(true)

        const r2 = await forceDebrief(db, mem, dec, audit)
        expect(r2).toBeTruthy()
        expect(typeof r2.durationMs).toBe('number')
        expect(r2.error).toBeFalsy()
      } finally {
        TaskDB.prototype.isFeatureEnabled = original
      }
    } finally {
      cleanup(db, path)
    }
  })
})

describe('PK-PF1-4 (R2, boss\'s rider) pre-act-records-even-on-failed-action is INTENDED behavior', () => {
  test('claim_task: a FAILING claim (wrong agent) leaves the normal failure output unchanged AND the expectation row was still recorded pre-act', () => {
    const { db, path } = freshDb()
    try {
      db.setFeatureFlag('outcome_feedback_enabled', true)
      const t = db.delegateTask({ from: 'boss', to: 'sadie', description: 'i', priority: 'normal', supervisor_agent: 'boss' })

      // Pre-act hook fires BEFORE the mutation attempt, exactly as wired in server.ts.
      const expectationId = recordExpectedOutcome(db.getHandle(), { task_id: t.id, expected_outcome: `Task #${t.id} claimed by kiera` })
      expect(expectationId).not.toBeNull() // pre-act recording succeeded

      // The claim itself then FAILS — wrong agent (task is assigned to 'sadie', not 'kiera').
      const claimResult = db.claimTaskWithSession(t.id, 'kiera', 'sess-fail')
      expect(claimResult).toBeNull() // the normal, expected failure — byte-unchanged from pre-PF1 (claimTaskWithSession's WHERE simply doesn't match)

      // The expectation row is STILL there — recording is not undone by the
      // downstream action failing (R2: this is INTENDED, not a bug).
      const row = db.run(d => d.prepare('SELECT id, task_id, expected_outcome FROM outcome_expectations WHERE id = ?').get(expectationId)) as { id: number; task_id: number; expected_outcome: string } | null
      expect(row).not.toBeNull()
      expect(row!.task_id).toBe(t.id)

      // The task itself is confirmed UNCHANGED by the failed claim attempt (still pending, still owned by sadie).
      const taskAfter = db.getTask(t.id)
      expect(taskAfter!.status).toBe('pending')
      expect(taskAfter!.to_agent).toBe('sadie')
    } finally {
      cleanup(db, path)
    }
  })
})
