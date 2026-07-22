import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { Database } from 'bun:sqlite'
import { TaskDB } from '../../db'
import {
  createWatcher,
  fireWatcher,
  getWatchers,
  disableWatcher,
  type FireableWatcherRow,
} from '../../watchers/declarative-watchers'

// PK-PF2-4 (ATM-PF2-05, ATM-PF2-06, ATM-PF2-07), PF-spec.md EPIC-PF2
// (~/.claude/state/p4-p8-fanout/specs/PF-spec.md, REQ-PF2-05/06/07/16).
// fireWatcher() reuses the EXISTING db.ts createTask() path (db.ts:1510,
// ANCHORS-PF2.md) — no new task-creation primitive, no db.ts edits.
// idempotency_key is accepted as an OPAQUE caller-supplied string
// parameter (escalated + proposed to main; the actual per-trigger-type
// derivation formula is PK-PF2-5's evaluateWatchers() concern, which has
// the occasion context fireWatcher() itself does not). evaluateWatchers()'s
// watchdog-tick dispatch (REQ-PF2-03/04) is out of scope — PK-PF2-5.

const WATCHERS_TS = readFileSync(resolve(__dirname, '..', '..', 'watchers', 'declarative-watchers.ts'), 'utf-8')

function functionBody(source: string, startMarker: string, endMarkers: string[]): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  let end = source.length
  for (const m of endMarkers) {
    const idx = source.indexOf(m, start + startMarker.length)
    if (idx > -1 && idx < end) end = idx
  }
  return source.slice(start, end)
}

const TOP_LEVEL_MARKERS = ['\nexport function ', '\nexport async function ', '\nexport const ', '\nexport interface ', '\nfunction ', '\n/**']

function freshDb(): { db: TaskDB; path: string } {
  const path = `/tmp/pf2-firing-${crypto.randomUUID()}.db`
  return { db: new TaskDB(path), path }
}

function cleanup(db: TaskDB, path: string): void {
  db.close()
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

function seedWatcher(db: TaskDB, overrides: Partial<{ name: string; description: string; to: string | null; priority: string }> = {}): FireableWatcherRow {
  const id = db.run(handle => createWatcher(handle, {
    name: overrides.name ?? 'fire test watcher',
    trigger_type: 'scheduled',
    condition_spec: { interval_seconds: 60 },
    action_spec: {
      description: overrides.description ?? 'watcher-fired task',
      to: overrides.to === undefined ? 'sadie' : overrides.to,
      priority: overrides.priority ?? 'normal',
    },
  }))
  return {
    id,
    action_spec: {
      description: overrides.description ?? 'watcher-fired task',
      to: overrides.to === undefined ? 'sadie' : overrides.to,
      priority: overrides.priority ?? 'normal',
    },
  }
}

// ---------------------------------------------------------------------------
// ATM-PF2-05/06: fireWatcher() (static)
// ---------------------------------------------------------------------------

describe('ATM-PF2-05/06: fireWatcher() (static)', () => {
  function body(): string {
    return functionBody(WATCHERS_TS, 'export function fireWatcher', TOP_LEVEL_MARKERS)
  }

  test('body uses the LOCAL BEGIN IMMEDIATE / COMMIT-or-ROLLBACK idiom', () => {
    expect(body()).toMatch(/BEGIN IMMEDIATE/)
    expect(body()).toMatch(/COMMIT/)
    expect(body()).toMatch(/ROLLBACK/)
  })

  test('body calls the EXISTING createTask() path, not a raw INSERT INTO tasks', () => {
    expect(body()).toMatch(/\.createTask\(/)
    expect(body()).not.toMatch(/INSERT INTO tasks/)
  })

  test('watchers/declarative-watchers.ts contains no new INSERT INTO tasks anywhere (no new task-creation primitive, REQ-PF2-06)', () => {
    expect(WATCHERS_TS).not.toMatch(/INSERT INTO tasks/)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-05: fireWatcher() (runtime, fresh DB) — creates exactly 1 task + 1 firing row
// ---------------------------------------------------------------------------

describe('ATM-PF2-05: fireWatcher() (runtime, fresh DB)', () => {
  test('a first fire creates exactly one task via the existing create_task path and exactly one declarative_watcher_firings row', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      const tasksBefore = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      const firingsBefore = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }

      const result = fireWatcher(db, watcher, 'key-1')
      expect(result.fired).toBe(true)
      expect(result.alreadyFired).toBe(false)
      expect(result.taskId).not.toBeNull()
      expect(result.firingId).not.toBeNull()

      const tasksAfter = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      const firingsAfter = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }
      expect(tasksAfter.n).toBe(tasksBefore.n + 1)
      expect(firingsAfter.n).toBe(firingsBefore.n + 1)

      const task = db.run(d => d.prepare('SELECT description, to_agent, priority FROM tasks WHERE id = ?').get(result.taskId)) as { description: string; to_agent: string; priority: string }
      expect(task.description).toBe('watcher-fired task')
      expect(task.to_agent).toBe('sadie')
      expect(task.priority).toBe('normal')

      const firing = db.run(d => d.prepare('SELECT watcher_id, created_task_id, idempotency_key FROM declarative_watcher_firings WHERE id = ?').get(result.firingId)) as { watcher_id: number; created_task_id: number; idempotency_key: string }
      expect(firing.watcher_id).toBe(watcher.id)
      expect(firing.created_task_id).toBe(result.taskId)
      expect(firing.idempotency_key).toBe('key-1')
    } finally {
      cleanup(db, path)
    }
  })

  test('the created task is routed through the same insert code path createTask() uses -- to_agent/priority/description reflect action_spec exactly', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db, { description: 'custom desc', to: 'boss', priority: 'high' })
      const result = fireWatcher(db, watcher, 'key-custom')
      const task = db.run(d => d.prepare('SELECT description, to_agent, priority, from_agent FROM tasks WHERE id = ?').get(result.taskId)) as { description: string; to_agent: string; priority: string; from_agent: string }
      expect(task.description).toBe('custom desc')
      expect(task.to_agent).toBe('boss')
      expect(task.priority).toBe('high')
      expect(task.from_agent).toBeTruthy() // createTask() requires a non-empty from_agent; fireWatcher() supplies one
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-06: idempotency guard (runtime)
// ---------------------------------------------------------------------------

describe('ATM-PF2-06: idempotency guard, backed by the DB UNIQUE(idempotency_key) constraint (runtime)', () => {
  test('a second fire attempt with the SAME idempotency_key creates exactly one task total -- the second insert is rejected by the UNIQUE constraint, caught and handled gracefully (no crash)', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      const first = fireWatcher(db, watcher, 'dup-key')
      expect(first.fired).toBe(true)

      let second: ReturnType<typeof fireWatcher> | undefined
      expect(() => { second = fireWatcher(db, watcher, 'dup-key') }).not.toThrow()
      expect(second!.fired).toBe(false)
      expect(second!.alreadyFired).toBe(true)
      expect(second!.taskId).toBeNull()

      const taskCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      expect(taskCount.n).toBe(1) // exactly one task total, not two
      const firingCount = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watcher_firings').get()) as { n: number }
      expect(firingCount.n).toBe(1) // the rejected duplicate insert did not land
    } finally {
      cleanup(db, path)
    }
  })

  test('atomicity: when the firing INSERT is rejected by the UNIQUE constraint, the whole transaction rolls back -- the SECOND attempt leaves NO orphan task row (task count stays at exactly 1, not 2)', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      fireWatcher(db, watcher, 'atomic-key')
      const beforeSecondAttempt = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      expect(beforeSecondAttempt.n).toBe(1)

      fireWatcher(db, watcher, 'atomic-key') // duplicate -- rejected, must not create task #2

      const afterSecondAttempt = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      expect(afterSecondAttempt.n).toBe(1) // ROLLBACK proof: the task INSERT from the second (failed) attempt did not persist
    } finally {
      cleanup(db, path)
    }
  })

  test('fault-injection: a forced failure on the firing INSERT (simulating the constraint rejection path via a scoped monkeypatch) leaves zero orphan task and propagates as a graceful (non-throwing) result', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      const tasksBefore = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }

      const proto = Database.prototype as unknown as { prepare: (this: Database, ...args: unknown[]) => any }
      const originalPrepare = proto.prepare
      proto.prepare = function (this: Database, ...callArgs: unknown[]) {
        const sql = (callArgs[0] as string).trim()
        if (/^INSERT INTO declarative_watcher_firings/.test(sql)) {
          const err = new Error('UNIQUE constraint failed: declarative_watcher_firings.idempotency_key') as Error & { code: string }
          err.code = 'SQLITE_CONSTRAINT_UNIQUE'
          throw err
        }
        return originalPrepare.apply(this, callArgs)
      }
      let result: ReturnType<typeof fireWatcher> | undefined
      try {
        expect(() => { result = fireWatcher(db, watcher, 'injected-fault-key') }).not.toThrow()
      } finally {
        proto.prepare = originalPrepare
      }
      expect(result!.fired).toBe(false)
      expect(result!.alreadyFired).toBe(true)

      const tasksAfter = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      expect(tasksAfter.n).toBe(tasksBefore.n) // the injected-failure attempt's task INSERT was rolled back -- no orphan
    } finally {
      cleanup(db, path)
    }
  })

  test('a genuinely different error (not a UNIQUE constraint violation) during firing propagates as a thrown error, not silently swallowed', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      const proto = Database.prototype as unknown as { prepare: (this: Database, ...args: unknown[]) => any }
      const originalPrepare = proto.prepare
      proto.prepare = function (this: Database, ...callArgs: unknown[]) {
        const sql = (callArgs[0] as string).trim()
        if (/^INSERT INTO declarative_watcher_firings/.test(sql)) {
          throw new Error('disk I/O error: simulated unrelated failure')
        }
        return originalPrepare.apply(this, callArgs)
      }
      try {
        expect(() => fireWatcher(db, watcher, 'unrelated-error-key')).toThrow(/disk I\/O error/)
      } finally {
        proto.prepare = originalPrepare
      }
      const tasksAfter = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM tasks').get()) as { n: number }
      expect(tasksAfter.n).toBe(0) // still rolled back -- no orphan, even for a non-idempotency error
    } finally {
      cleanup(db, path)
    }
  })

  test('LOCAL BEGIN IMMEDIATE ordering, verified at runtime via a scoped db.prepare monkeypatch: BEGIN IMMEDIATE precedes the task INSERT, which precedes the firing INSERT, which precedes COMMIT', () => {
    const { db, path } = freshDb()
    try {
      const watcher = seedWatcher(db)
      const proto = Database.prototype as unknown as { prepare: (this: Database, ...args: unknown[]) => any }
      const originalPrepare = proto.prepare
      const sequence: string[] = []
      proto.prepare = function (this: Database, ...callArgs: unknown[]) {
        const sql = (callArgs[0] as string).trim()
        if (sql === 'BEGIN IMMEDIATE') sequence.push('BEGIN IMMEDIATE')
        else if (/^INSERT INTO tasks/.test(sql)) sequence.push('TASK_INSERT')
        else if (/^INSERT INTO declarative_watcher_firings/.test(sql)) sequence.push('FIRING_INSERT')
        else if (sql === 'COMMIT') sequence.push('COMMIT')
        return originalPrepare.apply(this, callArgs)
      }
      try {
        fireWatcher(db, watcher, 'sequence-key')
      } finally {
        proto.prepare = originalPrepare
      }
      expect(sequence).toEqual(['BEGIN IMMEDIATE', 'TASK_INSERT', 'FIRING_INSERT', 'COMMIT'])
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-07: getWatchers() / disableWatcher() (static)
// ---------------------------------------------------------------------------

describe('ATM-PF2-07: getWatchers() (static SELECT-only scan)', () => {
  test('getWatchers() body contains only SELECT statements (no INSERT/UPDATE/DELETE)', () => {
    const body = functionBody(WATCHERS_TS, 'export function getWatchers', TOP_LEVEL_MARKERS)
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
    expect(body).toMatch(/SELECT/i)
  })
})

describe('ATM-PF2-07: disableWatcher() (static — never DELETE)', () => {
  test('disableWatcher() body contains no DELETE statement (sets enabled=0, never deletes)', () => {
    const body = functionBody(WATCHERS_TS, 'export function disableWatcher', TOP_LEVEL_MARKERS)
    expect(body).not.toMatch(/\bDELETE\b/i)
    expect(body).toMatch(/UPDATE/i)
    expect(body).toMatch(/enabled\s*=\s*0/i)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-07: getWatchers() / disableWatcher() (runtime)
// ---------------------------------------------------------------------------

describe('ATM-PF2-07: getWatchers() / disableWatcher() (runtime, fresh DB)', () => {
  test('getWatchers() defaults to enabled-only, matching disableWatcher()\'s effect', () => {
    const { db, path } = freshDb()
    try {
      const w1 = seedWatcher(db, { name: 'w1' })
      const w2 = seedWatcher(db, { name: 'w2' })

      const before = db.run(handle => getWatchers(handle))
      expect(before.map(w => w.id).sort()).toEqual([w1.id, w2.id].sort())

      db.run(handle => disableWatcher(handle, w1.id))

      const after = db.run(handle => getWatchers(handle))
      expect(after.map(w => w.id)).toEqual([w2.id])

      const allIncludingDisabled = db.run(handle => getWatchers(handle, { enabledOnly: false }))
      expect(allIncludingDisabled.length).toBe(2)
    } finally {
      cleanup(db, path)
    }
  })

  test('disableWatcher() sets enabled=0 and returns true; the row is never deleted (still SELECT-able with enabledOnly:false)', () => {
    const { db, path } = freshDb()
    try {
      const w = seedWatcher(db)
      const changed = db.run(handle => disableWatcher(handle, w.id))
      expect(changed).toBe(true)

      const row = db.run(d => d.prepare('SELECT enabled FROM declarative_watchers WHERE id = ?').get(w.id)) as { enabled: number }
      expect(row.enabled).toBe(0)

      const stillThere = db.run(d => d.prepare('SELECT id FROM declarative_watchers WHERE id = ?').get(w.id))
      expect(stillThere).not.toBeNull() // never deleted
    } finally {
      cleanup(db, path)
    }
  })

  test('disableWatcher() on a non-existent watcher id returns false, no error, zero rows changed', () => {
    const { db, path } = freshDb()
    try {
      const changed = db.run(handle => disableWatcher(handle, 999999))
      expect(changed).toBe(false)
    } finally {
      cleanup(db, path)
    }
  })

  test('a disabled watcher is excluded from getWatchers()\'s default (enabled-only) result -- proxy for "excluded from the next evaluateWatchers() pass" per ATM-PF2-07', () => {
    const { db, path } = freshDb()
    try {
      const w = seedWatcher(db)
      db.run(handle => disableWatcher(handle, w.id))
      const enabledWatchers = db.run(handle => getWatchers(handle))
      expect(enabledWatchers.find(x => x.id === w.id)).toBeUndefined()
    } finally {
      cleanup(db, path)
    }
  })
})
