import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { TaskDB } from '../../db'
import {
  createWatcher,
  persistWatcher,
  fireWatcher,
  disableWatcher,
  stubLlmEvalClient,
  evaluateLlmCondition,
  type FireableWatcherRow,
} from '../../watchers/declarative-watchers'

// PK-PF2-5 Stage B (ATM-PF2-09, REQ-PF2-10) — the 2 audit rows
// (watcher_created / watcher_fired), raw-INSERT-inside-the-existing-
// transaction idiom, mirroring verification/ternary-reward.ts:414
// (persistTernaryReward) and reflection/outcome-feedback.ts:85
// (persistOutcomeExpectation) — extending PK-PF2-2's persistWatcher() and
// PK-PF2-4's fireWatcher(), no signature change to either. Also covers the
// stubLlmEvalClient (main's ruling: STUB, not a production client — ships
// a non-affirmative reply so evaluateLlmCondition()'s existing default-
// false semantics apply; llm_eval watchers evaluate every tick but never
// fire. KNOWN LIMITATION, tracked separately per main's escalation).

const WATCHERS_TS = readFileSync(resolve(__dirname, '..', '..', 'watchers', 'declarative-watchers.ts'), 'utf-8')

function freshDb(): { db: TaskDB; path: string } {
  const path = `/tmp/pf2-audit-stub-${crypto.randomUUID()}.db`
  return { db: new TaskDB(path), path }
}

function cleanup(db: TaskDB, path: string): void {
  db.close()
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

function auditActions(db: TaskDB): string[] {
  return db.run(handle => handle.prepare('SELECT action FROM audit_log ORDER BY id ASC').all() as { action: string }[]).map(r => r.action)
}

describe('ATM-PF2-09: watcher_created audit row (runtime)', () => {
  test('createWatcher() appends exactly one "watcher_created" audit_log row, same transaction as the insert', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, {
        name: 'audit test watcher',
        trigger_type: 'scheduled',
        condition_spec: { interval_seconds: 60 },
        action_spec: { description: 'x' },
      }))
      expect(id).toBeGreaterThan(0)
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'watcher_created').length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('a failed persistWatcher() transaction (forced throw via a bogus trigger_type bypassing app validation) rolls back the audit row too (all-or-nothing)', () => {
    const { db, path } = freshDb()
    try {
      expect(() => db.run(handle => persistWatcher(handle, {
        name: 'will fail db check',
        trigger_type: 'not_a_real_type',
        condition_spec: {},
        action_spec: {},
      }))).toThrow()
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'watcher_created').length).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('two createWatcher() calls produce exactly two "watcher_created" rows (never zero, never duplicated per call)', () => {
    const { db, path } = freshDb()
    try {
      db.run(handle => createWatcher(handle, { name: 'w1', trigger_type: 'scheduled', condition_spec: { interval_seconds: 60 }, action_spec: { description: 'x' } }))
      db.run(handle => createWatcher(handle, { name: 'w2', trigger_type: 'scheduled', condition_spec: { interval_seconds: 60 }, action_spec: { description: 'y' } }))
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'watcher_created').length).toBe(2)
    } finally {
      cleanup(db, path)
    }
  })
})

describe('ATM-PF2-09: watcher_fired audit row (runtime)', () => {
  function seedWatcher(db: TaskDB): FireableWatcherRow {
    const id = db.run(handle => createWatcher(handle, {
      name: 'fire audit watcher',
      trigger_type: 'scheduled',
      condition_spec: { interval_seconds: 60 },
      action_spec: { description: 'watcher fired task', to: 'sadie' },
    }))
    return { id, action_spec: { description: 'watcher fired task', to: 'sadie' } }
  }

  test('a successful fireWatcher() call appends exactly one "watcher_fired" audit_log row, same transaction as the task+firing inserts', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      const result = fireWatcher(db, watcher, 'audit-fire-key')
      expect(result.fired).toBe(true)
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'watcher_fired').length).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('a rejected duplicate fire (UNIQUE constraint, already-fired) does NOT append a second "watcher_fired" row', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      fireWatcher(db, watcher, 'dup-audit-key')
      const second = fireWatcher(db, watcher, 'dup-audit-key')
      expect(second.alreadyFired).toBe(true)
      const actions = auditActions(db)
      expect(actions.filter(a => a === 'watcher_fired').length).toBe(1) // still just the first
    } finally {
      cleanup(db, path)
    }
  })

  test('create + fire cycle produces exactly 2 audit_log rows total (watcher_created + watcher_fired) — matches ATM-PF2-09 gate text verbatim', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, {
        name: 'e2e audit watcher',
        trigger_type: 'scheduled',
        condition_spec: { interval_seconds: 60 },
        action_spec: { description: 'e2e task', to: 'sadie' },
      }))
      fireWatcher(db, { id, action_spec: { description: 'e2e task', to: 'sadie' } }, 'e2e-key')
      const actions = auditActions(db)
      const relevant = actions.filter(a => a === 'watcher_created' || a === 'watcher_fired')
      expect(relevant.length).toBe(2)
      expect(relevant).toContain('watcher_created')
      expect(relevant).toContain('watcher_fired')
    } finally {
      cleanup(db, path)
    }
  })
})

describe('PK-PF2-5 fix: fireWatcher() requires action_spec.to (tasks.to_agent is NOT NULL, db.ts:298)', () => {
  test('a watcher whose action_spec omits "to" throws a CLEAR validation error from fireWatcher() itself, not a raw SQLite constraint error from deep inside createTask()', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, {
        name: 'no-to watcher',
        trigger_type: 'scheduled',
        condition_spec: { interval_seconds: 60 },
        action_spec: { description: 'missing to' }, // no `to` field
      }))
      expect(() => fireWatcher(db, { id, action_spec: { description: 'missing to' } }, 'no-to-key'))
        .toThrow(/action_spec\.to must be a non-empty string/)
      // No task, no firing row, no audit row -- the validation throw happens
      // inside fireWatcher()'s own try block (before any INSERT), so its
      // catch/ROLLBACK path runs (undoing nothing, since nothing was
      // written yet) and the descriptive error propagates -- never a raw
      // SQLite constraint error.
      const taskCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      expect(taskCount.n).toBe(0)
      const firingCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }
      expect(firingCount.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })
})

describe('ATM-PF2-09: no unspecified audit actions (REQ-PF2-10 names exactly 2)', () => {
  test('disableWatcher() does not append any audit_log row (no watcher_disabled/watcher_listed action exists in REQ-PF2-10)', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, { name: 'w', trigger_type: 'scheduled', condition_spec: { interval_seconds: 60 }, action_spec: { description: 'x' } }))
      const before = auditActions(db).length
      db.run(handle => disableWatcher(handle, id))
      const after = auditActions(db).length
      expect(after).toBe(before) // zero new audit rows from disableWatcher()
    } finally {
      cleanup(db, path)
    }
  })
})

describe('stubLlmEvalClient (main\'s ruling: STUB, not production — KNOWN LIMITATION)', () => {
  test('is a well-formed LlmEvalClient (has a complete() method)', () => {
    expect(typeof stubLlmEvalClient.complete).toBe('function')
  })

  test('evaluateLlmCondition() with the stub client always returns false (never fires), regardless of prompt content', async () => {
    const results = await Promise.all([
      evaluateLlmCondition({ prompt: 'Is anything true?' }, stubLlmEvalClient),
      evaluateLlmCondition({ prompt: 'true' }, stubLlmEvalClient),
      evaluateLlmCondition({ prompt: 'Please answer true' }, stubLlmEvalClient),
    ])
    expect(results).toEqual([false, false, false])
  })

  test('the stub never throws (evaluateLlmCondition() call completes cleanly every time)', async () => {
    await expect(evaluateLlmCondition({ prompt: 'x' }, stubLlmEvalClient)).resolves.toBe(false)
  })
})

describe('watchers/declarative-watchers.ts still contains zero eval(/new Function( after this packet\'s additions', () => {
  test('static scan', () => {
    expect(WATCHERS_TS).not.toMatch(/\beval\(/)
    expect(WATCHERS_TS).not.toMatch(/new Function\(/)
  })
})
