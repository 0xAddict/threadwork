// tests/fixtures/concurrency-barrier.ts — P5 ATM-033 test-only rendezvous
// primitives. NOT wired into any production call site: `waitForStartGate`
// is called from test worker scripts (ATM-003 FIX proof) immediately before
// invoking the wrapped write function, and `waitForBarrier` is wired ONLY
// into the UNWRAPPED flag-OFF branch of saveMemory()/challengeMemory()/
// supersedeMemory() at the read-to-write boundary in later stages (never
// inside a withMemoryWriteTxn() callback — see concurrency-barrier.test.ts
// (c) for the standing source-level regression check).
//
// Both primitives are complete no-ops (zero statements, zero latency) unless
// their gating env var is set, so a normal (non-fault-injection) test run or
// production process never pays any cost for their existence.

import type { Database } from 'bun:sqlite'

const POLL_INTERVAL_MS = 2
const DEFAULT_TIMEOUT_MS = 30_000

function workerId(): string {
  return `${process.pid}-${crypto.randomUUID()}`
}

/**
 * INSERT a ready marker into `table` tagged with `name`, then poll until
 * `expectedCount` markers tagged with that name exist, releasing all callers
 * at approximately the same instant once the last one arrives.
 */
function rendezvous(db: Database, table: string, nameColumn: string, name: string, expectedCount: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${nameColumn} TEXT, worker_id TEXT)`)
  db.prepare(`INSERT INTO ${table} (${nameColumn}, worker_id) VALUES (?, ?)`).run(name, workerId())

  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  for (;;) {
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${nameColumn} = ?`).get(name) as { c: number }
    if (row.c >= expectedCount) return
    if (Date.now() > deadline) {
      throw new Error(
        `concurrency-barrier: timed out after ${DEFAULT_TIMEOUT_MS}ms waiting for ${table}.${nameColumn}='${name}' ` +
        `to reach count ${expectedCount} (saw ${row.c})`
      )
    }
    Bun.sleepSync(POLL_INTERVAL_MS)
  }
}

/**
 * Pre-transaction start gate (flag-ON FIX proof, ATM-003b). No-op unless
 * `P5_TEST_START_GATE` is set. Called from test worker scripts immediately
 * BEFORE invoking the wrapped write function so all workers hit
 * BEGIN IMMEDIATE at approximately the same instant.
 */
export function waitForStartGate(db: Database, gateName: string, expectedCount: number): void {
  if (!process.env.P5_TEST_START_GATE) return
  rendezvous(db, 'test_start_gate', 'gate_name', gateName, expectedCount)
}

/**
 * Read-to-write boundary barrier (flag-OFF CONTROL proof, ATM-003a). No-op
 * unless `P5_TEST_BARRIER` is set. Wired ONLY into the unwrapped flag-OFF
 * branch of saveMemory()/challengeMemory()/supersedeMemory() in later
 * stages — never into a withMemoryWriteTxn() callback.
 */
export function waitForBarrier(db: Database, barrierName: string, expectedCount: number): void {
  if (!process.env.P5_TEST_BARRIER) return
  rendezvous(db, 'test_barrier', 'barrier_name', barrierName, expectedCount)
}
