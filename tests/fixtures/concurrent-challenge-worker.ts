// tests/fixtures/concurrent-challenge-worker.ts — P5 ATM-006 standalone
// worker process.
//
// Spawned via `Bun.spawn()` (a REAL separate OS process, not a worker_thread)
// by tests/memory-ordering-concurrency.test.ts to exercise challengeMemory()'s
// SELECT->compute->UPDATE sequence under genuine multi-process contention on
// a shared tasks.db file — matching the Ground truth process model (each
// agent runs its OWN `bun server.ts` process against the same SQLite file).
// Mirrors ATM-003's concurrent-save-memory-worker.ts shape.
//
// Env vars:
//   DB_PATH             (required) — path to the shared temp tasks.db.
//   AGENT_LABEL          — passed through as part of the challenge reason for
//                          log/debug readability; defaults 'boss'.
//   CHALLENGE_ID         (required) — id of the memory row to challenge.
//   P5_TEST_START_GATE   — if set, this script calls waitForStartGate()
//                          IMMEDIATELY BEFORE invoking challengeMemory() (the
//                          flag-ON FIX proof's pre-transaction rendezvous).
//   P5_GATE_COUNT        — expected worker count for the start gate.
//   P5_TEST_BARRIER      — NOT read here. challengeMemory()'s own flag-OFF
//                          branch reads this directly from process.env (see
//                          memory.ts's challengeMemoryCritical) — Bun.spawn's
//                          env inheritance makes it visible to this process
//                          without this script touching it.
//   P5_BARRIER_COUNT     — same note as P5_TEST_BARRIER; consumed inside
//                          memory.ts, not here.
//
// NEVER import '../../server' — this is a standalone script; no MCP server
// bootstrap is needed or wanted here.

import { TaskDB } from '../../db'
import { MemoryDB } from '../../memory'
import { waitForStartGate } from './concurrency-barrier'

const dbPath = process.env.DB_PATH
if (!dbPath) {
  throw new Error('concurrent-challenge-worker: DB_PATH env var is required')
}

const challengeIdRaw = process.env.CHALLENGE_ID
if (!challengeIdRaw) {
  throw new Error('concurrent-challenge-worker: CHALLENGE_ID env var is required')
}
const challengeId = Number(challengeIdRaw)

const taskDb = new TaskDB(dbPath)
const mem = new MemoryDB(taskDb)

if (process.env.P5_TEST_START_GATE) {
  waitForStartGate(
    taskDb.getHandle(),
    process.env.P5_TEST_START_GATE,
    Number(process.env.P5_GATE_COUNT ?? 0)
  )
}

mem.challengeMemory(challengeId, `race-${process.env.AGENT_LABEL ?? 'boss'}`)

process.exit(0)
