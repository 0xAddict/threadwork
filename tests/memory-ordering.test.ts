// tests/memory-ordering.test.ts — P5 Stage 1: ATM-001, ATM-030, ATM-031, ATM-012.
// Stage 2 adds ATM-004 (saveMemory composition-boundary check).
//
// Every test opens its own explicit /tmp/p5-*-<uuid>.db TaskDB — NEVER
// `new TaskDB()` with no argument (that would hit the live DB_PATH default,
// which has P4 memory-sanitization LIVE at flag=1 in production).

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Worker } from 'worker_threads'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import * as memoryIntegrity from '../memory-integrity'
import {
  withMemoryWriteTxn,
  nextWriteSeq,
  isWriteTxnActive,
  NestedWriteTxnError,
  WriteLockTimeoutError,
} from '../memory-ordering'

function tempDbPath(name: string): string {
  return `/tmp/p5-${name}-${crypto.randomUUID()}.db`
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

/**
 * Hold a competing `BEGIN IMMEDIATE` on `dbPath` from a SEPARATE OS thread for
 * `holdMs`, then COMMIT (release). Runs on a real worker_thread — not just an
 * async function on the main thread — because withMemoryWriteTxn's retry loop
 * is intentionally synchronous/blocking (Bun.sleepSync), which would starve
 * any same-thread timer meant to release the lock mid-retry.
 */
function holdCompetingLock(dbPath: string, holdMs: number): { worker: Worker; locked: Promise<void> } {
  const code = `
    const { parentPort, workerData } = require('worker_threads')
    const { Database } = require('bun:sqlite')
    const db = new Database(workerData.dbPath)
    db.prepare('BEGIN IMMEDIATE').run()
    parentPort.postMessage('locked')
    setTimeout(() => {
      try { db.prepare('COMMIT').run() } catch {}
      parentPort.postMessage('released')
    }, workerData.holdMs)
  `
  const worker = new Worker(code, { eval: true, workerData: { dbPath, holdMs } })
  const locked = new Promise<void>((resolve, reject) => {
    worker.once('message', (m) => { if (m === 'locked') resolve() })
    worker.once('error', reject)
  })
  return { worker, locked }
}

describe('withMemoryWriteTxn — ATM-001', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('ordering-atm001')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('(a) happy path — commits and is visible on a fresh read', () => {
    withMemoryWriteTxn(db, (d) => {
      d.prepare('INSERT INTO memories (agent, content, category) VALUES (?, ?, ?)').run('boss', 'atm001-happy', 'fact')
    })
    const row = db.prepare("SELECT * FROM memories WHERE content = 'atm001-happy'").get() as any
    expect(row).toBeTruthy()
    expect(row.agent).toBe('boss')
  })

  test('(b) rollback — fn throws mid-way, partial write is not visible', () => {
    expect(() => {
      withMemoryWriteTxn(db, (d) => {
        d.prepare('INSERT INTO memories (agent, content, category) VALUES (?, ?, ?)').run('boss', 'atm001-rollback', 'fact')
        throw new Error('boom mid-txn')
      })
    }).toThrow('boom mid-txn')

    const row = db.prepare("SELECT * FROM memories WHERE content = 'atm001-rollback'").get()
    expect(row).toBeNull()
  })

  test('(c) nesting on the same handle throws NestedWriteTxnError (instanceof)', () => {
    let caught: unknown
    withMemoryWriteTxn(db, (d) => {
      try {
        withMemoryWriteTxn(d, () => {})
      } catch (err) {
        caught = err
      }
    })
    expect(caught).toBeInstanceOf(NestedWriteTxnError)
  })

  test('isWriteTxnActive reflects active state during and after the callback', () => {
    expect(isWriteTxnActive(db)).toBe(false)
    let sawActiveInside = false
    withMemoryWriteTxn(db, (d) => {
      sawActiveInside = isWriteTxnActive(d)
    })
    expect(sawActiveInside).toBe(true)
    expect(isWriteTxnActive(db)).toBe(false)
  })
})

describe('withMemoryWriteTxn — ATM-030 (BEGIN IMMEDIATE contention, real cross-thread lock)', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('ordering-atm030')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('(a) TIMEOUT — competing lock held past the retry budget throws WriteLockTimeoutError', async () => {
    // Nominal retry budget is 50+150+450 = 650ms across 4 total BEGIN IMMEDIATE
    // attempts, but the acquisition loop is ATTEMPT-count-bounded (exactly 4
    // tries), not deadline-bounded — so what matters is that the competing lock
    // outlives all 4 attempts, however long Bun.sleepSync's backoff actually
    // takes under real (possibly loaded) system scheduling. Hold generously
    // past the nominal budget so this is robust to sleep-timer jitter.
    const { worker, locked } = holdCompetingLock(dbPath, 6_000)
    await locked
    try {
      expect(() => {
        withMemoryWriteTxn(db, (d) => {
          d.prepare('INSERT INTO memories (agent, content, category) VALUES (?, ?, ?)').run('boss', 'atm030-timeout', 'fact')
        })
      }).toThrow(WriteLockTimeoutError)
    } finally {
      worker.terminate()
    }
  }, 20_000)

  test('(b) RECOVERY — competing lock released before budget expiry lets the call eventually commit', async () => {
    // Release at 300ms: after attempt-2 (t=200) but well before attempt-3 (t=650),
    // so the final retry finds the lock free and commits with no error.
    const { worker, locked } = holdCompetingLock(dbPath, 300)
    await locked
    try {
      expect(() => {
        withMemoryWriteTxn(db, (d) => {
          d.prepare('INSERT INTO memories (agent, content, category) VALUES (?, ?, ?)').run('boss', 'atm030-recovery', 'fact')
        })
      }).not.toThrow()

      const row = db.prepare("SELECT * FROM memories WHERE content = 'atm030-recovery'").get() as any
      expect(row).toBeTruthy()
    } finally {
      worker.terminate()
    }
  }, 10_000)
})

describe('withMemoryWriteTxn — ATM-031 (no replay on mid-transaction fault)', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('ordering-atm031')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('callback executes exactly once; no partial row after a fault AFTER a prior statement ran; no reconnect', () => {
    let callCount = 0
    expect(() => {
      withMemoryWriteTxn(db, (d) => {
        callCount++
        // A prior statement in the same transaction really executes first...
        d.prepare('INSERT INTO memories (agent, content, category) VALUES (?, ?, ?)').run('boss', 'atm031-fault', 'fact')
        // ...then a fault occurs later in the SAME transaction (simulated
        // mid-transaction disk fault) — must roll back the prior statement too.
        throw new Error('disk I/O error')
      })
    }).toThrow('disk I/O error')

    // (a) callback body executed exactly once — no replay.
    expect(callCount).toBe(1)

    // (b) no partial row visible on a fresh read — ROLLBACK occurred.
    const row = db.prepare("SELECT * FROM memories WHERE content = 'atm031-fault'").get()
    expect(row).toBeNull()

    // (c) TaskDB.run()'s reconnect-on-"disk I/O error" path was never invoked for
    // this call: we drove withMemoryWriteTxn directly off taskDb.getHandle(), not
    // through taskDb.run(). reconnect() replaces `this.db` with a NEW Database
    // object, so if it had fired (even indirectly), getHandle() would now return
    // a different object than the one we opened the transaction on.
    expect(taskDb.getHandle()).toBe(db)
  })
})

describe('nextWriteSeq — ATM-012', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('ordering-atm012')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('100 sequential calls are strictly increasing with zero repeats', () => {
    const seqs: number[] = []
    for (let i = 0; i < 100; i++) {
      seqs.push(nextWriteSeq(db))
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
    expect(new Set(seqs).size).toBe(100)
  })

  test('a standalone call outside any transaction succeeds', () => {
    expect(() => nextWriteSeq(db)).not.toThrow()
  })

  test('a call from inside withMemoryWriteTxn rolls back with the enclosing txn on throw', () => {
    let seqInsideTxn: number | undefined
    expect(() => {
      withMemoryWriteTxn(db, (d) => {
        seqInsideTxn = nextWriteSeq(d)
        throw new Error('rollback please')
      })
    }).toThrow('rollback please')

    expect(seqInsideTxn).toBeGreaterThan(0)
    const row = db.prepare('SELECT id FROM write_sequence WHERE id = ?').get(seqInsideTxn as number)
    expect(row).toBeNull()
  })
})

describe('saveMemory composition boundary — ATM-004 (REQ-003)', () => {
  // [CLOSES adversarial finding #4] Proves P5's withMemoryWriteTxn() wraps
  // wherever P4's sanitize call lands, WITHOUT asserting anything about
  // sanitizeMemoryContent()'s own signature (P4 locks that to
  // `(content, {sourceType})` — no `db` param). We replace the module-level
  // `sanitizeMemoryContent` export with a spy that calls the P5-OWNED
  // isWriteTxnActive(db) hook on the SAME handle the test holds, and records
  // the boolean. The spy itself never receives/inspects a `db` argument —
  // it closes over the test's own `db` reference instead.
  //
  // Direct reassignment of an ES module namespace export
  // (`memoryIntegrity.sanitizeMemoryContent = spy`) throws under Bun
  // ("Attempted to assign to readonly property") — live ESM bindings are
  // non-writable. `mock.module()` (the spec's documented fallback) was tried
  // first, but is UNSAFE here: Bun's `mock.module()` replacements are NOT
  // reliably file-scoped and `mock.restore()` does not undo them (confirmed
  // empirically, and a known upstream limitation — oven-sh/bun#7823,
  // oven-sh/bun#12823), so a `mock.module()` call in this file would
  // permanently corrupt tests/memory.test.ts's real (unmocked)
  // sanitizeMemoryContent assertions whenever both files run in the same
  // `bun test` invocation (as required by this project's P5 gate command).
  //
  // Instead, this uses `spyOn(namespaceObject, 'exportName')` on a `import *
  // as memoryIntegrity` namespace reference: Bun's `spyOn` CAN patch a live
  // ESM binding (verified empirically) and its returned spy's
  // `.mockRestore()` reliably reverts JUST that one property, both within a
  // single test and across test files in the same process/invocation —
  // avoiding the whole-module-registry-replacement class of bug entirely.
  let dbPath: string
  let taskDb: TaskDB
  let db: Database
  let sanitizeSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    dbPath = tempDbPath('ordering-atm004')
    taskDb = new TaskDB(dbPath)
    taskDb.setFeatureFlag('memory_write_ordering_enabled', true)
    // Sanitize must be ON too, or saveMemoryCritical never reaches the
    // sanitize call site at all.
    taskDb.setFeatureFlag('memory_sanitization_enabled', true)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    sanitizeSpy?.mockRestore()
    sanitizeSpy = undefined
    cleanupDbFile(dbPath)
  })

  test('the sanitize call site fires while a P5 write-transaction is open on the same db handle', () => {
    let recordedActive: boolean | undefined

    // Arbitrary pass-through spy — matches P4's (content, {sourceType})
    // signature exactly, but the SPY intentionally never inspects `db`; it
    // closes over the outer test's own `db` variable instead.
    sanitizeSpy = spyOn(memoryIntegrity, 'sanitizeMemoryContent').mockImplementation(
      (content: string, _opts: { sourceType: string }) => {
        recordedActive = isWriteTxnActive(db)
        return { text: content, neutralized: false }
      }
    )

    const mem = new MemoryDB(taskDb)
    mem.saveMemory({ agent: 'boss', content: 'atm004 composition content', category: 'fact' })

    expect(recordedActive).toBe(true)
  })
})

describe('supersedeMemory composition boundary — ATM-011 (REQ-008)', () => {
  // Mirrors ATM-004's mechanism exactly, at the supersedeMemory call site.
  // [CLOSES finding #4] Never asserts on sanitizeMemoryContent()'s own
  // signature/arguments — only observes isWriteTxnActive(db) from inside the
  // spy, on the SAME handle the test holds.
  let dbPath: string
  let taskDb: TaskDB
  let db: Database
  let sanitizeSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    dbPath = tempDbPath('ordering-atm011')
    taskDb = new TaskDB(dbPath)
    taskDb.setFeatureFlag('memory_write_ordering_enabled', true)
    // Sanitize must be ON too, or supersedeMemoryCritical never reaches the
    // sanitize call site at all.
    taskDb.setFeatureFlag('memory_sanitization_enabled', true)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    sanitizeSpy?.mockRestore()
    sanitizeSpy = undefined
    cleanupDbFile(dbPath)
  })

  test('the sanitize call site fires while a P5 write-transaction is open on the same db handle', () => {
    // `phase` gates which call's invocation of the spy gets recorded, so
    // `recordedActive` is NEVER directly reassigned in this function's own
    // straight-line code (only conditionally, inside the closure) — avoiding
    // a TS control-flow-narrowing trap where an explicit outer-scope reset
    // (e.g. `recordedActive = undefined`) narrows the variable to the
    // literal `undefined` type across the subsequent supersedeMemory() call,
    // even though that call's own (real, runtime) invocation of this closure
    // does reassign it. Mirrors ATM-004's mechanism, extended to ignore the
    // preceding saveMemory() call's own hit on the same spy.
    let phase: 'save' | 'supersede' = 'save'
    let recordedActive: boolean | undefined

    // Arbitrary pass-through spy — matches P4's (content, {sourceType})
    // signature exactly, but the SPY intentionally never inspects `db`; it
    // closes over the outer test's own `db` variable instead.
    sanitizeSpy = spyOn(memoryIntegrity, 'sanitizeMemoryContent').mockImplementation(
      (content: string, _opts: { sourceType: string }) => {
        if (phase === 'supersede') {
          recordedActive = isWriteTxnActive(db)
        }
        return { text: content, neutralized: false }
      }
    )

    const mem = new MemoryDB(taskDb)
    const old = mem.saveMemory({ agent: 'boss', content: 'atm011 old content', category: 'fact' })
    // saveMemory's own (flag-ON) call also hits the spy above — the `phase`
    // guard means it never wrote to recordedActive; only supersedeMemory's
    // invocation of the spy below does.
    phase = 'supersede'

    mem.supersedeMemory(old.id, 'atm011 new content', 'refinement')

    expect(recordedActive).toBe(true)
  })
})
