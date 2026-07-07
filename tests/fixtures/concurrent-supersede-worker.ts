// tests/fixtures/concurrent-supersede-worker.ts — P5 ATM-010 standalone
// worker process.
//
// Spawned via `Bun.spawn()` (a REAL separate OS process, not a worker_thread)
// by tests/memory-ordering-concurrency.test.ts to exercise supersedeMemory()'s
// SELECT->UPDATE(old)->INSERT(new) sequence under genuine multi-process
// contention on a shared tasks.db file — matching the Ground truth process
// model (each agent runs its OWN `bun server.ts` process against the same
// SQLite file). Mirrors ATM-003/ATM-006's concurrent-*-worker.ts shape.
//
// Env vars:
//   DB_PATH             (required) — path to the shared temp tasks.db.
//   AGENT_LABEL          — folded into the supersede reason for log/debug
//                          readability; defaults 'boss'.
//   OLD_ID               (required) — id of the memory row to supersede.
//   WORKER_CONTENT       — replacement content passed to supersedeMemory();
//                          each worker in a concurrency test uses DISTINCT
//                          content so the race can be observed. Defaults to
//                          a fixed string.
//   P5_TEST_START_GATE   — if set, this script calls waitForStartGate()
//                          IMMEDIATELY BEFORE invoking supersedeMemory() (the
//                          flag-ON FIX proof's pre-transaction rendezvous).
//   P5_GATE_COUNT        — expected worker count for the start gate.
//   P5_TEST_BARRIER      — NOT read here. supersedeMemory()'s own flag-OFF
//                          branch reads this directly from process.env (see
//                          memory.ts's supersedeMemoryCritical) — Bun.spawn's
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
  throw new Error('concurrent-supersede-worker: DB_PATH env var is required')
}

const oldIdRaw = process.env.OLD_ID
if (!oldIdRaw) {
  throw new Error('concurrent-supersede-worker: OLD_ID env var is required')
}
const oldId = Number(oldIdRaw)

const taskDb = new TaskDB(dbPath)
const mem = new MemoryDB(taskDb)

if (process.env.P5_TEST_START_GATE) {
  waitForStartGate(
    taskDb.getHandle(),
    process.env.P5_TEST_START_GATE,
    Number(process.env.P5_GATE_COUNT ?? 0)
  )
}

mem.supersedeMemory(
  oldId,
  process.env.WORKER_CONTENT ?? 'concurrent-supersede-worker default content',
  `race-${process.env.AGENT_LABEL ?? 'boss'}`
)

process.exit(0)
