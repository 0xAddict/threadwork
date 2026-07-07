// tests/fixtures/concurrent-save-memory-worker.ts — P5 ATM-003 standalone
// worker process.
//
// Spawned via `Bun.spawn()` (a REAL separate OS process, not a worker_thread)
// by tests/memory-ordering-concurrency.test.ts to exercise saveMemory()'s
// dedup check-then-act sequence under genuine multi-process contention on a
// shared tasks.db file — matching the Ground truth process model (each agent
// runs its OWN `bun server.ts` process against the same SQLite file).
//
// Env vars:
//   DB_PATH            (required) — path to the shared temp tasks.db.
//   AGENT_LABEL         — agent identity passed to saveMemory(); defaults 'boss'.
//   MEMORY_CONTENT      — content passed to saveMemory(); defaults to a fixed string.
//   P5_TEST_START_GATE  — if set, this script calls waitForStartGate()
//                         IMMEDIATELY BEFORE invoking saveMemory() (the
//                         flag-ON FIX proof's pre-transaction rendezvous).
//   P5_GATE_COUNT       — expected worker count for the start gate.
//   P5_TEST_BARRIER     — NOT read here. saveMemory()'s own flag-OFF branch
//                         reads this directly from process.env (see
//                         memory.ts's saveMemoryCritical) — Bun.spawn's env
//                         inheritance makes it visible to this process
//                         without this script touching it.
//   P5_BARRIER_COUNT    — same note as P5_TEST_BARRIER; consumed inside
//                         memory.ts, not here.
//
// NEVER import '../../server' — this is a standalone script; no MCP server
// bootstrap is needed or wanted here.

import { TaskDB } from '../../db'
import { MemoryDB } from '../../memory'
import { waitForStartGate } from './concurrency-barrier'

const dbPath = process.env.DB_PATH
if (!dbPath) {
  throw new Error('concurrent-save-memory-worker: DB_PATH env var is required')
}

const taskDb = new TaskDB(dbPath)
const mem = new MemoryDB(taskDb)

if (process.env.P5_TEST_START_GATE) {
  waitForStartGate(
    taskDb.getHandle(),
    process.env.P5_TEST_START_GATE,
    Number(process.env.P5_GATE_COUNT ?? 0)
  )
}

mem.saveMemory({
  agent: process.env.AGENT_LABEL ?? 'boss',
  content: process.env.MEMORY_CONTENT ?? 'concurrent-save-memory-worker default content',
  category: 'fact',
})

process.exit(0)
