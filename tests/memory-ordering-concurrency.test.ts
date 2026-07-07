// tests/memory-ordering-concurrency.test.ts — P5 EPIC-02 ATM-003.
//
// CROSS-PROCESS concurrency proof for saveMemory()'s dedup check-then-act
// race — the load-bearing test that matches the real multi-process agent
// topology (Ground truth: each agent runs its own `bun server.ts` process,
// all sharing one tasks.db file). Uses `Bun.spawn()` to launch REAL OS
// processes (never worker_threads) so BEGIN IMMEDIATE contention is genuine.
//
// (a) CONTROL — flag OFF. Workers rendezvous at the read->write barrier
//     (waitForBarrier, wired into saveMemory()'s unwrapped flag-OFF branch)
//     so all 5 complete their dedup SELECT before any performs its
//     UPDATE-or-INSERT — deterministically reproducing the pre-P5 race.
//     Asserts MORE THAN ONE row for the duplicate content (the race is real
//     and the harness can detect it, not passing by scheduling luck).
//
// (b) FIX — flag ON. Workers rendezvous at the pre-transaction start gate
//     (waitForStartGate, called from this worker script immediately before
//     invoking saveMemory()) so all 5 hit BEGIN IMMEDIATE at approximately
//     the same instant — real multi-process contention on the P5 lock.
//     Asserts exactly ONE row, support_count === 4 (N-1).

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'

const WORKER_PATH = new URL('./fixtures/concurrent-save-memory-worker.ts', import.meta.url).pathname
const CHALLENGE_WORKER_PATH = new URL('./fixtures/concurrent-challenge-worker.ts', import.meta.url).pathname
const SUPERSEDE_WORKER_PATH = new URL('./fixtures/concurrent-supersede-worker.ts', import.meta.url).pathname
const N = 5
const SPAWN_TIMEOUT_MS = 30_000

function tempDbPath(name: string): string {
  return `/tmp/p5-${name}-${crypto.randomUUID()}.db`
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

/** Spawn one concurrent-save-memory-worker.ts as a real OS process; resolve its exit code. */
async function spawnWorker(env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(['bun', WORKER_PATH], {
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return proc.exited
}

/** Spawn one concurrent-challenge-worker.ts as a real OS process; resolve its exit code. */
async function spawnChallengeWorker(env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(['bun', CHALLENGE_WORKER_PATH], {
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return proc.exited
}

/** Spawn one concurrent-supersede-worker.ts as a real OS process; resolve its exit code. */
async function spawnSupersedeWorker(env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(['bun', SUPERSEDE_WORKER_PATH], {
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return proc.exited
}

describe('ATM-003 — saveMemory cross-process dedup race', () => {
  test(
    '(a) CONTROL — flag OFF, barrier-forced interleave reproduces the dedup race (> 1 row)',
    async () => {
      const dbPath = tempDbPath('atm003-control')
      // Create the file + run migrations + set WAL/busy_timeout ONCE from the
      // main thread before any worker opens it (mirrors concurrency-barrier.
      // test.ts's initWalDb rationale — N racing fresh connections converting
      // journal_mode on a brand-new file would themselves contend).
      const seedDb = new TaskDB(dbPath)
      // memory_write_ordering_enabled defaults to 0 (seeded OFF) — no explicit
      // flag write needed for the CONTROL run.
      seedDb.close()

      const runId = crypto.randomUUID()
      const barrierName = `savemem-dedup-${runId}`
      const content = `atm003-control-dup-content-${runId}`

      const exitCodes = await Promise.all(
        Array.from({ length: N }, () =>
          spawnWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: 'boss',
            MEMORY_CONTENT: content,
            P5_TEST_BARRIER: barrierName,
            P5_BARRIER_COUNT: String(N),
          })
        )
      )
      for (const code of exitCodes) expect(code).toBe(0)

      const readDb = new Database(dbPath, { readonly: true })
      try {
        const row = readDb
          .prepare('SELECT COUNT(*) as c FROM memories WHERE content = ?')
          .get(content) as { c: number }
        // The barrier reproduced the pre-P5 race on demand — this assertion
        // is PART of pass/fail, not a comment (ATM-003a).
        expect(row.c).toBeGreaterThan(1)
      } finally {
        readDb.close()
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )

  test(
    '(b) FIX — flag ON, start-gate-synchronized contention yields exactly ONE row, support_count === 4',
    async () => {
      const dbPath = tempDbPath('atm003-fix')
      const seedDb = new TaskDB(dbPath)
      seedDb.setFeatureFlag('memory_write_ordering_enabled', true)
      seedDb.close()

      const runId = crypto.randomUUID()
      const gateName = `savemem-fix-${runId}`
      const content = `atm003-fix-dup-content-${runId}`

      const exitCodes = await Promise.all(
        Array.from({ length: N }, () =>
          spawnWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: 'boss',
            MEMORY_CONTENT: content,
            P5_TEST_START_GATE: gateName,
            P5_GATE_COUNT: String(N),
          })
        )
      )
      for (const code of exitCodes) expect(code).toBe(0)

      // Fresh read connection, per spec.
      const readDb = new Database(dbPath, { readonly: true })
      try {
        const rows = readDb
          .prepare('SELECT * FROM memories WHERE content = ?')
          .all(content) as Array<{ support_count: number }>
        expect(rows).toHaveLength(1)
        expect(rows[0].support_count).toBe(N - 1)
      } finally {
        readDb.close()
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )
})

// tests/memory-ordering-concurrency.test.ts — P5 EPIC-03 ATM-006.
//
// CROSS-PROCESS concurrency proof for challengeMemory()'s SELECT->compute->
// UPDATE read-modify-write race — mirrors ATM-003's structure exactly, but
// against a SINGLE seeded memory row that all N workers concurrently
// challenge (rather than N workers writing distinct-vs-duplicate content).
//
// (a) CONTROL — flag OFF. Workers rendezvous at the read->write barrier
//     (waitForBarrier, wired into challengeMemory()'s unwrapped flag-OFF
//     branch) so all 5 complete their SELECT before any performs its UPDATE
//     — deterministically reproducing the pre-P5 lost-update race. Asserts
//     challenge_count !== 5 (an increment was lost).
//
// (b) FIX — flag ON. Workers rendezvous at the pre-transaction start gate
//     (waitForStartGate, called from the worker script immediately before
//     invoking challengeMemory()) so all 5 hit BEGIN IMMEDIATE at
//     approximately the same instant — real multi-process contention on the
//     P5 lock. Asserts challenge_count === 5 AND that state/quality match the
//     value a SEQUENTIAL application of 5 challenges would deterministically
//     produce (proving no stale-snapshot corruption, not merely a correct
//     count).

describe('ATM-006 — challengeMemory cross-process read-modify-write race', () => {
  test(
    '(a) CONTROL — flag OFF, barrier-forced interleave reproduces the lost-update race (challenge_count !== 5)',
    async () => {
      const dbPath = tempDbPath('atm006-control')
      const seedDb = new TaskDB(dbPath)
      // memory_write_ordering_enabled defaults to 0 (seeded OFF) — no explicit
      // flag write needed for the CONTROL run.
      const seedMem = new MemoryDB(seedDb)
      const seeded = seedMem.saveMemory({
        agent: 'boss',
        content: `atm006-control-seed-${crypto.randomUUID()}`,
        category: 'fact',
      })
      expect(seeded.support_count).toBe(0)
      expect(seeded.challenge_count).toBe(0)
      seedDb.close()

      const runId = crypto.randomUUID()
      const barrierName = `challenge-${runId}`

      const exitCodes = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          spawnChallengeWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: `worker-${i}`,
            CHALLENGE_ID: String(seeded.id),
            P5_TEST_BARRIER: barrierName,
            P5_BARRIER_COUNT: String(N),
          })
        )
      )
      for (const code of exitCodes) expect(code).toBe(0)

      const readDb = new Database(dbPath, { readonly: true })
      try {
        const row = readDb
          .prepare('SELECT challenge_count FROM memories WHERE id = ?')
          .get(seeded.id) as { challenge_count: number }
        // The barrier reproduced the pre-P5 race on demand — this assertion
        // is PART of pass/fail, not a comment (ATM-006a).
        expect(row.challenge_count).not.toBe(N)
      } finally {
        readDb.close()
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )

  test(
    '(b) FIX — flag ON, start-gate-synchronized contention yields challenge_count === 5 with deterministic state/quality',
    async () => {
      const dbPath = tempDbPath('atm006-fix')
      const seedDb = new TaskDB(dbPath)
      seedDb.setFeatureFlag('memory_write_ordering_enabled', true)
      const seedMem = new MemoryDB(seedDb)
      const seeded = seedMem.saveMemory({
        agent: 'boss',
        content: `atm006-fix-seed-${crypto.randomUUID()}`,
        category: 'fact',
      })
      expect(seeded.support_count).toBe(0)
      expect(seeded.challenge_count).toBe(0)
      seedDb.close()

      const runId = crypto.randomUUID()
      const gateName = `challenge-fix-${runId}`

      const exitCodes = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          spawnChallengeWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: `worker-${i}`,
            CHALLENGE_ID: String(seeded.id),
            P5_TEST_START_GATE: gateName,
            P5_GATE_COUNT: String(N),
          })
        )
      )
      for (const code of exitCodes) expect(code).toBe(0)

      // Compute the value a SEQUENTIAL application of N challenges would
      // deterministically produce, starting from the seeded row's own
      // challenge_count/support_count/quality/state (per ATM-006's verifier),
      // rather than hardcoding an expected number.
      let cc = seeded.challenge_count
      let quality = seeded.quality
      let state: string = seeded.state
      for (let i = 0; i < N; i++) {
        cc = cc + 1
        const shouldDispute = cc > seeded.support_count
        quality = shouldDispute ? Math.max(quality - 0.2, 0) : quality
        state = shouldDispute ? 'disputed' : state
      }

      const readDb = new Database(dbPath, { readonly: true })
      try {
        const row = readDb
          .prepare('SELECT challenge_count, quality, state FROM memories WHERE id = ?')
          .get(seeded.id) as { challenge_count: number; quality: number; state: string }
        expect(row.challenge_count).toBe(N)
        expect(row.state).toBe(state)
        expect(row.quality).toBeCloseTo(quality, 5)
      } finally {
        readDb.close()
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )
})

// tests/memory-ordering-concurrency.test.ts — P5 EPIC-04 ATM-010.
//
// CROSS-PROCESS concurrency proof for supersedeMemory()'s
// SELECT->UPDATE(old)->INSERT(new) double-supersede race — mirrors ATM-006's
// structure exactly, but against a SINGLE seeded memory row that all N
// workers concurrently attempt to supersede with DISTINCT replacement
// content (rather than a shared challenge).
//
// (a) CONTROL — flag OFF (unguarded UPDATE, per REQ-022). Workers rendezvous
//     at the read->write barrier (waitForBarrier, wired into
//     supersedeMemory()'s unwrapped flag-OFF branch) so all 5 complete their
//     existing-row SELECT before any performs its old-row UPDATE —
//     deterministically reproducing the pre-P5 double-supersede race.
//     Asserts MORE THAN ONE row with supersedes_memory_id = id (the race is
//     real and the harness can detect it, not passing by scheduling luck).
//
// (b) FIX — flag ON. Workers rendezvous at the pre-transaction start gate
//     (waitForStartGate, called from the worker script immediately before
//     invoking supersedeMemory()) so all 5 hit BEGIN IMMEDIATE at
//     approximately the same instant — real multi-process contention on the
//     P5 lock + the REQ-007 state guard. Asserts exactly ONE row with
//     supersedes_memory_id = id (not up to N), and the original row's
//     state === 'superseded' exactly once (not corrupted by a second
//     UPDATE).

describe('ATM-010 — supersedeMemory cross-process double-supersede race', () => {
  test(
    '(a) CONTROL — flag OFF, barrier-forced interleave reproduces the double-supersede race (> 1 replacement row)',
    async () => {
      const dbPath = tempDbPath('atm010-control')
      const seedDb = new TaskDB(dbPath)
      // memory_write_ordering_enabled defaults to 0 (seeded OFF) — no explicit
      // flag write needed for the CONTROL run.
      const seedMem = new MemoryDB(seedDb)
      const seeded = seedMem.saveMemory({
        agent: 'boss',
        content: `atm010-control-seed-${crypto.randomUUID()}`,
        category: 'fact',
      })
      seedDb.close()

      const runId = crypto.randomUUID()
      const barrierName = `supersede-${runId}`

      const exitCodes = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          spawnSupersedeWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: `worker-${i}`,
            OLD_ID: String(seeded.id),
            WORKER_CONTENT: `atm010-control-replacement-${i}-${runId}`,
            P5_TEST_BARRIER: barrierName,
            P5_BARRIER_COUNT: String(N),
          })
        )
      )
      for (const code of exitCodes) expect(code).toBe(0)

      const readDb = new Database(dbPath, { readonly: true })
      try {
        const row = readDb
          .prepare('SELECT COUNT(*) as c FROM memories WHERE supersedes_memory_id = ?')
          .get(seeded.id) as { c: number }
        // The barrier reproduced the pre-P5 double-supersede race on demand —
        // this assertion is PART of pass/fail, not a comment (ATM-010a).
        expect(row.c).toBeGreaterThan(1)
      } finally {
        readDb.close()
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )

  test(
    '(b) FIX — flag ON, start-gate-synchronized contention yields exactly ONE replacement row, original superseded exactly once',
    async () => {
      const dbPath = tempDbPath('atm010-fix')
      const seedDb = new TaskDB(dbPath)
      seedDb.setFeatureFlag('memory_write_ordering_enabled', true)
      const seedMem = new MemoryDB(seedDb)
      const seeded = seedMem.saveMemory({
        agent: 'boss',
        content: `atm010-fix-seed-${crypto.randomUUID()}`,
        category: 'fact',
      })
      seedDb.close()

      const runId = crypto.randomUUID()
      const gateName = `supersede-fix-${runId}`

      const exitCodes = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          spawnSupersedeWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: `worker-${i}`,
            OLD_ID: String(seeded.id),
            WORKER_CONTENT: `atm010-fix-replacement-${i}-${runId}`,
            P5_TEST_START_GATE: gateName,
            P5_GATE_COUNT: String(N),
          })
        )
      )
      for (const code of exitCodes) expect(code).toBe(0)

      const readDb = new Database(dbPath, { readonly: true })
      try {
        const replacementRows = readDb
          .prepare('SELECT id FROM memories WHERE supersedes_memory_id = ?')
          .all(seeded.id) as Array<{ id: number }>
        // Exactly ONE row (not up to N) — ATM-010(b)'s core assertion.
        expect(replacementRows).toHaveLength(1)

        const originalRow = readDb
          .prepare('SELECT state FROM memories WHERE id = ?')
          .get(seeded.id) as { state: string }
        // The original row's state is 'superseded' exactly once — not
        // corrupted by a second concurrent UPDATE.
        expect(originalRow.state).toBe('superseded')

        // Bonus check on REQ-024's audit contract under real concurrency:
        // the N-1 workers that lost the BEGIN IMMEDIATE race each hit the
        // REQ-007 state guard and were rejected, each writing exactly one
        // memory_supersede_blocked_duplicate audit row.
        const blockedCount = readDb
          .prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'memory_supersede_blocked_duplicate' AND memory_id = ?")
          .get(seeded.id) as { c: number }
        expect(blockedCount.c).toBe(N - 1)
      } finally {
        readDb.close()
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )
})
