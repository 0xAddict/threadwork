// tests/fixtures/concurrency-barrier.test.ts — P5 ATM-033.
//
// (a)/(b): 3-worker rendezvous proofs for waitForStartGate/waitForBarrier,
// solo-call, and no-op-when-unset. Workers run on REAL worker_threads (not
// same-thread async functions) because both primitives are intentionally
// synchronous/blocking (Bun.sleepSync polling) — a same-thread "concurrent"
// caller would just starve everyone else's turn, defeating the point of the
// rendezvous. worker_threads give genuine concurrent execution while still
// being orchestrated from the test via Promise.all, matching the brief.
//
// (c): source-level regression check — waitForBarrier( must never appear
// inside a withMemoryWriteTxn( callback body in memory.ts/agent-messages.ts.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Worker } from 'worker_threads'
import { readFileSync, unlinkSync } from 'fs'
import { waitForStartGate, waitForBarrier } from './concurrency-barrier'
import { TaskDB } from '../../db'
import { MemoryDB } from '../../memory'

const FIXTURE_PATH = new URL('./concurrency-barrier.ts', import.meta.url).pathname

function tempDbPath(name: string): string {
  return `/tmp/p5-${name}-${crypto.randomUUID()}.db`
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

/**
 * Create `path` and switch it to WAL mode from a SINGLE connection before any
 * concurrent worker opens it. Changing journal_mode itself needs an exclusive
 * lock, which N brand-new connections racing to open + convert the SAME fresh
 * file would contend on with no busy_timeout yet configured — so this must
 * happen once, up front, from the main thread.
 */
function initWalDb(path: string): void {
  const db = new Database(path, { create: true })
  db.prepare('PRAGMA journal_mode=WAL').run()
  db.prepare('PRAGMA busy_timeout=5000').run()
  db.close()
}

interface GateWorkerResult {
  arrivedAt: number
  releasedAt: number
}

function runGateWorker(opts: {
  fn: 'waitForStartGate' | 'waitForBarrier'
  dbPath: string
  name: string
  expectedCount: number
  envVar: 'P5_TEST_START_GATE' | 'P5_TEST_BARRIER'
  envSet: boolean
  jitterMs: number
}): Promise<GateWorkerResult> {
  const code = `
    const { parentPort, workerData } = require('worker_threads')
    const { Database } = require('bun:sqlite')
    const mod = require(workerData.fixturePath)
    if (workerData.envSet) {
      process.env[workerData.envVar] = '1'
    } else {
      delete process.env[workerData.envVar]
    }
    const db = new Database(workerData.dbPath)
    // The main thread already created the file + set WAL mode before spawning
    // workers (changing journal mode itself needs an exclusive lock, which N
    // brand-new connections racing to open + convert the SAME fresh file would
    // contend on). Workers only need their own busy_timeout so concurrent
    // CREATE TABLE IF NOT EXISTS / INSERT calls serialize instead of raising an
    // immediate "database is locked" (a fresh connection's default busy_timeout
    // is 0 — no retry at all).
    db.prepare('PRAGMA busy_timeout=5000').run()
    if (workerData.jitterMs > 0) Bun.sleepSync(workerData.jitterMs)
    const arrivedAt = Date.now()
    mod[workerData.fn](db, workerData.name, workerData.expectedCount)
    const releasedAt = Date.now()
    parentPort.postMessage({ arrivedAt, releasedAt })
  `
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { fixturePath: FIXTURE_PATH, ...opts },
    })
    worker.once('message', (m: GateWorkerResult) => { resolve(m); worker.terminate() })
    worker.once('error', (e) => { reject(e); worker.terminate() })
  })
}

function rendezvousSpec(fn: 'waitForStartGate' | 'waitForBarrier', envVar: 'P5_TEST_START_GATE' | 'P5_TEST_BARRIER') {
  describe(fn, () => {
    test('3 workers rendezvous: none proceeds until all 3 arrive; released together', async () => {
      const dbPath = tempDbPath(`${fn}-rendezvous`)
      const name = `${fn}-${crypto.randomUUID()}`
      initWalDb(dbPath)
      try {
        // Two "early" workers (jitter 0) arrive immediately and must block;
        // one "late" worker (jitter 200ms) is the trigger that releases everyone.
        // Thresholds below are generous (not tight to nominal ms) because
        // Bun.sleepSync — used both for the jitter and for the fixture's own
        // poll loop — runs with real scheduling jitter under system load; the
        // 200ms jitter gap can only ever be an UNDER-estimate of the actual
        // early/late split, never an over-estimate.
        const results = await Promise.all([
          runGateWorker({ fn, dbPath, name, expectedCount: 3, envVar, envSet: true, jitterMs: 0 }),
          runGateWorker({ fn, dbPath, name, expectedCount: 3, envVar, envSet: true, jitterMs: 0 }),
          runGateWorker({ fn, dbPath, name, expectedCount: 3, envVar, envSet: true, jitterMs: 200 }),
        ])

        const releaseTimes = results.map((r) => r.releasedAt)
        const spread = Math.max(...releaseTimes) - Math.min(...releaseTimes)
        // All released at approximately the same instant, not staggered.
        expect(spread).toBeLessThan(150)

        const [early0, early1, late] = results
        // The early arrivers genuinely BLOCKED — their release lagged their own
        // arrival by roughly the full gap until the late worker showed up.
        expect(early0.releasedAt - early0.arrivedAt).toBeGreaterThan(100)
        expect(early1.releasedAt - early1.arrivedAt).toBeGreaterThan(100)
        // The late arriver (the 3rd/last to show up) is released essentially
        // immediately — the count was already satisfied the instant it inserted.
        expect(late.releasedAt - late.arrivedAt).toBeLessThan(100)
      } finally {
        cleanupDbFile(dbPath)
      }
    }, 15_000)

    test('a solo call with expectedCount=1 returns immediately', () => {
      const dbPath = tempDbPath(`${fn}-solo`)
      const prior = process.env[envVar]
      process.env[envVar] = '1'
      try {
        const db = new Database(dbPath, { create: true })
        const t0 = Date.now()
        if (fn === 'waitForStartGate') {
          waitForStartGate(db, `${fn}-solo-${crypto.randomUUID()}`, 1)
        } else {
          waitForBarrier(db, `${fn}-solo-${crypto.randomUUID()}`, 1)
        }
        expect(Date.now() - t0).toBeLessThan(1000)
      } finally {
        if (prior === undefined) delete process.env[envVar]
        else process.env[envVar] = prior
        cleanupDbFile(dbPath)
      }
    })

    test('measured no-op when the env var is unset (zero latency, no table created)', () => {
      const dbPath = tempDbPath(`${fn}-noop`)
      const prior = process.env[envVar]
      delete process.env[envVar]
      try {
        const db = new Database(dbPath, { create: true })
        const t0 = Date.now()
        // expectedCount of 5 would hang forever if this were NOT a no-op.
        if (fn === 'waitForStartGate') {
          waitForStartGate(db, `${fn}-noop-${crypto.randomUUID()}`, 5)
        } else {
          waitForBarrier(db, `${fn}-noop-${crypto.randomUUID()}`, 5)
        }
        expect(Date.now() - t0).toBeLessThan(20)

        const table = fn === 'waitForStartGate' ? 'test_start_gate' : 'test_barrier'
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
          .get(table)
        expect(row).toBeNull()
      } finally {
        if (prior === undefined) delete process.env[envVar]
        else process.env[envVar] = prior
        cleanupDbFile(dbPath)
      }
    })
  })
}

rendezvousSpec('waitForStartGate', 'P5_TEST_START_GATE')
rendezvousSpec('waitForBarrier', 'P5_TEST_BARRIER')

describe('ATM-033 (c) — source-level regression check', () => {
  /** Return the substrings enclosed by every top-level call to `calleeName(...)` in `source`. */
  function extractCallRegions(source: string, calleeName: string): string[] {
    const regions: string[] = []
    const marker = `${calleeName}(`
    let searchFrom = 0
    for (;;) {
      const idx = source.indexOf(marker, searchFrom)
      if (idx === -1) break
      const openParenIdx = idx + calleeName.length
      let depth = 1
      let i = openParenIdx + 1
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === '(') depth++
        else if (source[i] === ')') depth--
      }
      regions.push(source.slice(openParenIdx + 1, i - 1))
      searchFrom = idx + marker.length
    }
    return regions
  }

  function countOccurrences(text: string, needle: string): number {
    let count = 0
    let idx = 0
    for (;;) {
      idx = text.indexOf(needle, idx)
      if (idx === -1) break
      count++
      idx += needle.length
    }
    return count
  }

  /**
   * Walk backward from `callIdx` (the index of a call site) to find the
   * nearest lexically-enclosing `{ ... }` block, and — if that block is
   * opened by an `if (<condition>)` header — return the trimmed condition
   * text. Returns null when the nearest enclosing block is NOT an
   * if-statement (a bare function body, a loop, top-level scope, etc.), or
   * when no enclosing block exists at all.
   */
  function nearestEnclosingIfCondition(source: string, callIdx: number): string | null {
    let depth = 0
    for (let i = callIdx - 1; i >= 0; i--) {
      const ch = source[i]
      if (ch === '}') {
        depth++
      } else if (ch === '{') {
        if (depth === 0) {
          const header = source.slice(Math.max(0, i - 200), i)
          const m = header.match(/if\s*\(([^()]*)\)\s*$/)
          return m ? m[1].trim() : null
        }
        depth--
      }
    }
    return null
  }

  test('waitForBarrier( never appears inside a withMemoryWriteTxn( callback body', () => {
    // Defense in depth (kept from the original check): a purely TEXTUAL
    // check that no occurrence of waitForBarrier( sits inside the literal
    // argument-list region of a withMemoryWriteTxn(...) call expression.
    // [CLOSES finding H1] This is deliberately NOT the only check below — it
    // is vacuous against an unguarded waitForBarrier() living in a SEPARATE
    // function (e.g. a `*Critical` helper invoked from inside
    // withMemoryWriteTxn's callback, which is exactly how memory.ts's real
    // ON path is structured), since such a call is textually outside any
    // withMemoryWriteTxn(...) call expression while still being reachable on
    // the ON path at runtime. See the two tests below for the checks that
    // actually close that gap.
    const files = [
      new URL('../../memory.ts', import.meta.url).pathname,
      new URL('../../agent-messages.ts', import.meta.url).pathname,
    ]

    let violations = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const regions = extractCallRegions(source, 'withMemoryWriteTxn')
      for (const region of regions) {
        violations += countOccurrences(region, 'waitForBarrier(')
      }
    }

    expect(violations).toBe(0)
  })

  test('[CLOSES finding H1] every waitForBarrier( call in memory.ts is lexically inside an `if (!orderingOn) {` guard block', () => {
    // Deepened per finding H1: walks backward from EVERY waitForBarrier(
    // call site (wherever it lexically lives — including inside a separate
    // `*Critical` helper method called from the withMemoryWriteTxn(...)
    // callback) to its nearest enclosing `{ ... }` block, and asserts that
    // block's header is exactly `if (!orderingOn)` — the flag-OFF branch.
    // Any occurrence NOT so guarded (e.g. unconditional, or guarded by the
    // wrong condition) fails this check, which the shallower
    // withMemoryWriteTxn-region check above cannot detect.
    const file = new URL('../../memory.ts', import.meta.url).pathname
    const source = readFileSync(file, 'utf8')
    const callIdxs: number[] = []
    {
      let idx = 0
      const marker = 'waitForBarrier('
      for (;;) {
        idx = source.indexOf(marker, idx)
        if (idx === -1) break
        callIdxs.push(idx)
        idx += marker.length
      }
    }

    // Sanity: the seam must actually be wired somewhere, or this check would
    // pass vacuously (zero occurrences = zero violations, proving nothing).
    expect(callIdxs.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const idx of callIdxs) {
      const condition = nearestEnclosingIfCondition(source, idx)
      const guarded = condition !== null && condition.replace(/\s+/g, '') === '!orderingOn'
      if (!guarded) {
        const lineNo = source.slice(0, idx).split('\n').length
        violations.push(`memory.ts:${lineNo} enclosing condition=${JSON.stringify(condition)}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('[CLOSES finding H1] agent-messages.ts contains ZERO waitForBarrier( occurrences (sendDirectedMessage has no unwrapped flag-OFF variant)', () => {
    const file = new URL('../../agent-messages.ts', import.meta.url).pathname
    const source = readFileSync(file, 'utf8')
    expect(countOccurrences(source, 'waitForBarrier(')).toBe(0)
  })
})

describe('ATM-033 (c) — RUNTIME PROOF: waitForBarrier is unreachable on the memory_write_ordering_enabled=1 (ON) path', () => {
  // [CLOSES finding H1] The source-level checks above are a static proxy for
  // "waitForBarrier can never run on the ON path." This is the real runtime
  // guarantee: with ordering ON, arm P5_TEST_BARRIER with an expectedCount NO
  // in-process caller could ever satisfy on its own (no other worker is
  // inserting 'ready' markers for this barrier name), then call
  // saveMemory/challengeMemory/supersedeMemory once each. If waitForBarrier()
  // were reachable from the ON path, each call would block polling toward
  // concurrency-barrier.ts's own internal 30s deadline — bounding this test's
  // bun:test timeout well below that turns a latent ON-path barrier leak into
  // an immediate, loud test failure instead of a 30s hang.
  let dbPath: string
  let taskDb: TaskDB

  beforeEach(() => {
    dbPath = tempDbPath('atm033-runtime-proof')
    taskDb = new TaskDB(dbPath)
    taskDb.setFeatureFlag('memory_write_ordering_enabled', true)
  })

  afterEach(() => {
    delete process.env.P5_TEST_BARRIER
    delete process.env.P5_BARRIER_COUNT
    cleanupDbFile(dbPath)
  })

  test('saveMemory / challengeMemory / supersedeMemory each return promptly with an unsatisfiable barrier armed', () => {
    process.env.P5_TEST_BARRIER = 'atm033-runtime-proof'
    process.env.P5_BARRIER_COUNT = '5'

    const mem = new MemoryDB(taskDb)

    const saved = mem.saveMemory({ agent: 'boss', content: 'atm033-runtime-proof save', category: 'fact' })
    expect(saved).toBeTruthy()

    const challenged = mem.challengeMemory(saved.id, 'atm033 runtime proof')
    expect(challenged).toBeTruthy()

    const superseded = mem.supersedeMemory(saved.id, 'atm033-runtime-proof superseded content', 'refinement')
    expect(superseded).toBeTruthy()
  }, 5_000)
})
