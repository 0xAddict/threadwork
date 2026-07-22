import { describe, test, expect } from 'bun:test'
import { readFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { Database } from 'bun:sqlite'
import { TaskDB } from '../../db'
import {
  createWatcher,
  persistWatcher,
  validateConditionSpec,
  type CreateWatcherInput,
} from '../../watchers/declarative-watchers'

// PK-PF2-2 (ATM-PF2-03 + ATM-PF2-14), PF-spec.md EPIC-PF2 (~/.claude/state/
// p4-p8-fanout/specs/PF-spec.md). ATM-PF2-03 maps to REQ-PF2-01/02
// (createWatcher()/persistWatcher() + trigger_type validation + LOCAL BEGIN
// IMMEDIATE); ATM-PF2-14 maps to REQ-PF2-15 (condition_spec schema
// validation per trigger_type, reject open expressions) -- per the ATM
// table itself (PF-spec.md lines 365/376), not REQ-PF2-03/REQ-PF2-14 (those
// belong to evaluateWatchers()'s watchdog-tick wiring and the llm_eval
// evaluator, respectively -- both explicitly out of this packet's scope,
// confirmed by the FILE BOUNDARY constraint excluding watchdog.ts). No
// evaluators (evaluateScheduledCondition/evaluateStateChangeCondition/
// evaluateLlmCondition), fireWatcher(), or getWatchers()/disableWatcher()
// land in this packet -- those are PK-PF2-3/4.

const WATCHERS_TS = readFileSync(resolve(__dirname, '..', '..', 'watchers', 'declarative-watchers.ts'), 'utf-8')

function freshDb(): { db: TaskDB; path: string } {
  const path = `/tmp/pf2-create-validate-${crypto.randomUUID()}.db`
  return { db: new TaskDB(path), path }
}

function cleanup(db: TaskDB, path: string): void {
  db.close()
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

function validScheduledInput(name = 'scheduled watcher'): CreateWatcherInput {
  return {
    name,
    trigger_type: 'scheduled',
    condition_spec: { interval_seconds: 3600 },
    action_spec: { description: 'do the thing', to: 'sadie' },
  }
}

function validStateChangeSelectorInput(name = 'state_change selector watcher'): CreateWatcherInput {
  return {
    name,
    trigger_type: 'state_change',
    condition_spec: {
      watched_table: 'tasks',
      watched_column: 'status',
      comparator: 'eq',
      operand: 'completed',
      watched_selector: { id: 1 },
    },
    action_spec: { description: 'react to state change', to: 'sadie' },
  }
}

function validStateChangeAggregateInput(name = 'state_change aggregate watcher'): CreateWatcherInput {
  return {
    name,
    trigger_type: 'state_change',
    condition_spec: {
      watched_table: 'tasks',
      watched_column: 'id',
      comparator: 'gt',
      operand: 10,
      watched_aggregate: 'COUNT',
    },
    action_spec: { description: 'react to aggregate change', to: 'sadie' },
  }
}

function validLlmEvalInput(name = 'llm_eval watcher'): CreateWatcherInput {
  return {
    name,
    trigger_type: 'llm_eval',
    condition_spec: { prompt: 'Is the sky blue?', max_tokens: 16 },
    action_spec: { description: 'react to llm verdict', to: 'sadie' },
  }
}

// ---------------------------------------------------------------------------
// ATM-PF2-03 (static)
// ---------------------------------------------------------------------------

describe('ATM-PF2-03: createWatcher()/persistWatcher() (static)', () => {
  test('watchers/declarative-watchers.ts uses the LOCAL BEGIN IMMEDIATE / COMMIT-or-ROLLBACK idiom (decision.ts:156-206 shape)', () => {
    expect(WATCHERS_TS).toMatch(/BEGIN IMMEDIATE/)
    expect(WATCHERS_TS).toMatch(/COMMIT/)
    expect(WATCHERS_TS).toMatch(/ROLLBACK/)
  })

  test('watchers/declarative-watchers.ts imports zero P5 write-ordering symbols (no withMemoryWriteTxn import)', () => {
    const importLines = WATCHERS_TS.split('\n').filter(l => /^\s*import\b/.test(l))
    for (const line of importLines) {
      expect(line).not.toMatch(/withMemoryWriteTxn/)
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-14 (static) -- zero eval(/new Function( anywhere in the module,
// per REQ-PF2-15's "no eval()-equivalent code path" requirement.
// ---------------------------------------------------------------------------

describe('ATM-PF2-14: no open expression evaluation (static)', () => {
  test('watchers/declarative-watchers.ts contains zero eval( or new Function(', () => {
    expect(WATCHERS_TS).not.toMatch(/\beval\(/)
    expect(WATCHERS_TS).not.toMatch(/new Function\(/)
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-03 (runtime, fresh DB)
// ---------------------------------------------------------------------------

describe('ATM-PF2-03: createWatcher()/persistWatcher() (runtime, fresh DB)', () => {
  test('createWatcher({trigger_type:"bogus", ...}) throws and inserts zero rows', () => {
    const { db, path } = freshDb()
    try {
      const before = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(before.n).toBe(0)
      expect(() => db.run(handle => createWatcher(handle, {
        name: 'bogus watcher',
        // @ts-expect-error -- deliberately invalid trigger_type to prove runtime rejection.
        trigger_type: 'bogus',
        condition_spec: {},
        action_spec: {},
      }))).toThrow()
      const after = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(after.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('createWatcher() with a valid scheduled input inserts exactly one row with matching content', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, validScheduledInput()))
      expect(id).toBeGreaterThan(0)
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(1)
      const row = db.run(d => d.prepare('SELECT name, trigger_type, condition_spec, action_spec, enabled FROM declarative_watchers WHERE id = ?').get(id)) as
        { name: string; trigger_type: string; condition_spec: string; action_spec: string; enabled: number }
      expect(row.name).toBe('scheduled watcher')
      expect(row.trigger_type).toBe('scheduled')
      expect(JSON.parse(row.condition_spec)).toEqual({ interval_seconds: 3600 })
      expect(JSON.parse(row.action_spec)).toEqual({ description: 'do the thing', to: 'sadie' })
      expect(row.enabled).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('createWatcher() with a valid state_change (selector) input inserts exactly one row', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, validStateChangeSelectorInput()))
      expect(id).toBeGreaterThan(0)
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('createWatcher() with a valid state_change (aggregate) input inserts exactly one row', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, validStateChangeAggregateInput()))
      expect(id).toBeGreaterThan(0)
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('createWatcher() with a valid llm_eval input inserts exactly one row', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => createWatcher(handle, validLlmEvalInput()))
      expect(id).toBeGreaterThan(0)
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(1)
    } finally {
      cleanup(db, path)
    }
  })

  test('three createWatcher() calls, one per trigger_type, produce exactly 3 rows total', () => {
    const { db, path } = freshDb()
    try {
      db.run(handle => createWatcher(handle, validScheduledInput('s1')))
      db.run(handle => createWatcher(handle, validStateChangeSelectorInput('s2')))
      db.run(handle => createWatcher(handle, validLlmEvalInput('s3')))
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(3)
    } finally {
      cleanup(db, path)
    }
  })

  test('persistWatcher() performs the raw insert used internally by createWatcher() -- same effect, called directly with pre-validated input', () => {
    const { db, path } = freshDb()
    try {
      const id = db.run(handle => persistWatcher(handle, validScheduledInput('direct persist')))
      expect(id).toBeGreaterThan(0)
      const row = db.run(d => d.prepare('SELECT name FROM declarative_watchers WHERE id = ?').get(id)) as { name: string }
      expect(row.name).toBe('direct persist')
    } finally {
      cleanup(db, path)
    }
  })

  test('a thrown error mid-transaction leaves zero rows (ROLLBACK proof) -- trigger_type CHECK constraint violation via persistWatcher() bypassing app-level validation', () => {
    const { db, path } = freshDb()
    try {
      expect(() => db.run(handle => persistWatcher(handle, {
        name: 'will fail db check',
        // @ts-expect-error -- deliberately bypass app validation to force the DB-level CHECK constraint (PK-PF2-1) to throw.
        trigger_type: 'not_a_real_type',
        condition_spec: {},
        action_spec: {},
      }))).toThrow()
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('LOCAL BEGIN IMMEDIATE ordering, verified at runtime via a scoped db.prepare monkeypatch (mirrors the established pf1-4-sequence-behavior.test.ts idiom): BEGIN IMMEDIATE precedes the INSERT, which precedes COMMIT', () => {
    const { db, path } = freshDb()
    try {
      const proto = Database.prototype as unknown as { prepare: (this: Database, ...args: unknown[]) => any }
      const originalPrepare = proto.prepare
      const sequence: string[] = []
      proto.prepare = function (this: Database, ...callArgs: unknown[]) {
        const sql = callArgs[0] as string
        if (/^BEGIN IMMEDIATE$/.test(sql.trim())) sequence.push('BEGIN IMMEDIATE')
        else if (/^INSERT INTO declarative_watchers/.test(sql.trim())) sequence.push('INSERT')
        else if (/^COMMIT$/.test(sql.trim())) sequence.push('COMMIT')
        return originalPrepare.apply(this, callArgs)
      }
      try {
        db.run(handle => createWatcher(handle, validScheduledInput('sequence-check')))
      } finally {
        proto.prepare = originalPrepare
      }
      expect(sequence).toEqual(['BEGIN IMMEDIATE', 'INSERT', 'COMMIT'])
    } finally {
      cleanup(db, path)
    }
  })
})

// ---------------------------------------------------------------------------
// ATM-PF2-14 (runtime) -- condition_spec schema validation per trigger_type
// ---------------------------------------------------------------------------

describe('ATM-PF2-14: condition_spec schema validation -- scheduled (runtime)', () => {
  test('validateConditionSpec accepts a well-formed scheduled spec', () => {
    expect(() => validateConditionSpec('scheduled', { interval_seconds: 60 })).not.toThrow()
  })

  test('rejects a scheduled spec missing interval_seconds', () => {
    expect(() => validateConditionSpec('scheduled', {})).toThrow()
  })

  test('rejects a scheduled spec with a non-number interval_seconds', () => {
    expect(() => validateConditionSpec('scheduled', { interval_seconds: '3600' })).toThrow()
  })

  test('rejects a scheduled spec with a zero/negative interval_seconds', () => {
    expect(() => validateConditionSpec('scheduled', { interval_seconds: 0 })).toThrow()
    expect(() => validateConditionSpec('scheduled', { interval_seconds: -5 })).toThrow()
  })

  test('rejects a scheduled spec carrying an out-of-v1-scope cron_expr field', () => {
    expect(() => validateConditionSpec('scheduled', { interval_seconds: 60, cron_expr: '* * * * *' })).toThrow()
  })

  test('rejects a non-object scheduled spec', () => {
    expect(() => validateConditionSpec('scheduled', 'interval_seconds: 60')).toThrow()
    expect(() => validateConditionSpec('scheduled', null)).toThrow()
    expect(() => validateConditionSpec('scheduled', [60])).toThrow()
  })
})

describe('ATM-PF2-14: condition_spec schema validation -- state_change (runtime)', () => {
  const base = { watched_table: 'tasks', watched_column: 'status', comparator: 'eq' as const, operand: 'completed' }

  test('accepts a well-formed state_change spec with watched_selector', () => {
    expect(() => validateConditionSpec('state_change', { ...base, watched_selector: { id: 1 } })).not.toThrow()
  })

  test('accepts a well-formed state_change spec with watched_aggregate', () => {
    expect(() => validateConditionSpec('state_change', { ...base, watched_aggregate: 'COUNT' })).not.toThrow()
  })

  test('rejects a state_change spec missing watched_table/watched_column', () => {
    expect(() => validateConditionSpec('state_change', { comparator: 'eq', operand: 'x', watched_selector: { id: 1 } })).toThrow()
  })

  test('rejects a state_change spec with an invalid comparator', () => {
    expect(() => validateConditionSpec('state_change', { ...base, comparator: 'contains', watched_selector: { id: 1 } })).toThrow()
  })

  test('rejects a state_change spec specifying BOTH watched_selector and watched_aggregate (REQ-PF2-18 XOR)', () => {
    expect(() => validateConditionSpec('state_change', { ...base, watched_selector: { id: 1 }, watched_aggregate: 'COUNT' })).toThrow()
  })

  test('rejects a state_change spec specifying NEITHER watched_selector nor watched_aggregate (REQ-PF2-18 XOR)', () => {
    expect(() => validateConditionSpec('state_change', { ...base })).toThrow()
  })

  test('rejects a state_change spec with a non-allowlisted aggregate function', () => {
    expect(() => validateConditionSpec('state_change', { ...base, watched_aggregate: 'AVG' })).toThrow()
  })

  test('rejects a state_change spec whose watched_selector is an open-expr-looking raw string, not a bounded object', () => {
    expect(() => validateConditionSpec('state_change', { ...base, watched_selector: "id = 1 OR 1=1; DROP TABLE tasks;" })).toThrow()
  })

  test('rejects a state_change spec whose watched_selector contains a nested/non-scalar value', () => {
    expect(() => validateConditionSpec('state_change', { ...base, watched_selector: { id: { $gt: 1 } } })).toThrow()
  })

  test('rejects a state_change spec whose watched_selector is an empty object', () => {
    expect(() => validateConditionSpec('state_change', { ...base, watched_selector: {} })).toThrow()
  })
})

describe('ATM-PF2-14: condition_spec schema validation -- llm_eval (runtime)', () => {
  test('accepts a well-formed llm_eval spec', () => {
    expect(() => validateConditionSpec('llm_eval', { prompt: 'Is X true?', max_tokens: 16 })).not.toThrow()
  })

  test('accepts a well-formed llm_eval spec without max_tokens (optional)', () => {
    expect(() => validateConditionSpec('llm_eval', { prompt: 'Is X true?' })).not.toThrow()
  })

  test('rejects an llm_eval spec missing prompt', () => {
    expect(() => validateConditionSpec('llm_eval', { max_tokens: 16 })).toThrow()
  })

  test('rejects an llm_eval spec with an empty prompt', () => {
    expect(() => validateConditionSpec('llm_eval', { prompt: '' })).toThrow()
  })

  test('rejects an llm_eval spec with a non-string prompt', () => {
    expect(() => validateConditionSpec('llm_eval', { prompt: 12345 })).toThrow()
  })

  test('rejects an llm_eval spec with an oversized (malformed/unbounded) prompt', () => {
    expect(() => validateConditionSpec('llm_eval', { prompt: 'x'.repeat(5000) })).toThrow()
  })

  test('rejects an llm_eval spec with a malformed max_tokens (non-integer / non-positive)', () => {
    expect(() => validateConditionSpec('llm_eval', { prompt: 'ok', max_tokens: 'sixteen' })).toThrow()
    expect(() => validateConditionSpec('llm_eval', { prompt: 'ok', max_tokens: 0 })).toThrow()
    expect(() => validateConditionSpec('llm_eval', { prompt: 'ok', max_tokens: 3.5 })).toThrow()
  })
})

describe('ATM-PF2-14: createWatcher() end-to-end rejects a condition_spec that does not match its trigger_type\'s schema', () => {
  test('trigger_type=scheduled with a state_change-shaped condition_spec is rejected', () => {
    const { db, path } = freshDb()
    try {
      expect(() => db.run(handle => createWatcher(handle, {
        name: 'mismatched shape',
        trigger_type: 'scheduled',
        condition_spec: { watched_table: 'tasks', watched_column: 'status', comparator: 'eq', operand: 'x', watched_selector: { id: 1 } },
        action_spec: {},
      }))).toThrow()
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('trigger_type=llm_eval with a scheduled-shaped condition_spec is rejected', () => {
    const { db, path } = freshDb()
    try {
      expect(() => db.run(handle => createWatcher(handle, {
        name: 'mismatched shape 2',
        trigger_type: 'llm_eval',
        condition_spec: { interval_seconds: 60 },
        action_spec: {},
      }))).toThrow()
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })

  test('an action_spec that is not a plain object is rejected', () => {
    const { db, path } = freshDb()
    try {
      expect(() => db.run(handle => createWatcher(handle, {
        name: 'bad action_spec',
        trigger_type: 'scheduled',
        condition_spec: { interval_seconds: 60 },
        // @ts-expect-error -- deliberately invalid action_spec shape.
        action_spec: 'not an object',
      }))).toThrow()
      const count = db.run(d => d.prepare('SELECT COUNT(*) AS n FROM declarative_watchers').get()) as { n: number }
      expect(count.n).toBe(0)
    } finally {
      cleanup(db, path)
    }
  })
})
