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

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Worker } from 'worker_threads'
import { readFileSync, unlinkSync } from 'fs'
import { waitForStartGate, waitForBarrier } from './concurrency-barrier'

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

  test('waitForBarrier( never appears inside a withMemoryWriteTxn( callback body', () => {
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

    // Stage 1: neither file calls withMemoryWriteTxn OR waitForBarrier yet, so
    // this passes vacuously. It stays a live regression check once later
    // stages wire withMemoryWriteTxn() into these files' write paths.
    expect(violations).toBe(0)
  })
})
