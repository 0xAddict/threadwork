// tests/fixtures/concurrent-send-message-worker.ts — P5 ATM-019 standalone
// worker process.
//
// Spawned via `Bun.spawn()` (a REAL separate OS process, not a worker_thread)
// by tests/agent-messages-concurrency.test.ts to exercise sendDirectedMessage()
// under genuine multi-process contention on a shared tasks.db file — matching
// the Ground truth process model (each agent runs its OWN `bun server.ts`
// process against the same SQLite file).
//
// Env vars:
//   DB_PATH             (required) — path to the shared temp tasks.db.
//   AGENT_LABEL         — the sending agent's identity. Passed as the
//                         selfLabel PARAMETER to sendDirectedMessage() — that
//                         function never reads config.ts's SELF_LABEL, so
//                         per-process identity resolution here is via
//                         explicit argument passing, not via config.ts's
//                         import-time-frozen module constant. Defaults 'boss'.
//   RECIPIENT           — target agent; defaults 'boss'.
//   WORKER_ID           — opaque marker recorded in the message payload.
//   P5_TEST_START_GATE  — if set, this script calls waitForStartGate()
//                         IMMEDIATELY BEFORE invoking sendDirectedMessage()
//                         (the pre-transaction rendezvous proving genuine
//                         multi-process contention on BEGIN IMMEDIATE /
//                         nextWriteSeq() — sendDirectedMessage() is ALWAYS
//                         withMemoryWriteTxn()-wrapped per REQ-015c, so there
//                         is no unwrapped flag-OFF control variant to pair
//                         this with, unlike the memory-write workers).
//   P5_GATE_COUNT       — expected worker count for the start gate.
//
// The call below deliberately does NOT include a `sender` field in args —
// sender is ALWAYS resolved from the selfLabel parameter (REQ-015a); passing
// one would contradict that contract and must not be exercised here.
//
// NEVER import '../../server' — this is a standalone script; no MCP server
// bootstrap is needed or wanted here.

import { TaskDB } from '../../db'
import { sendDirectedMessage } from '../../agent-messages'
import { waitForStartGate } from './concurrency-barrier'

const dbPath = process.env.DB_PATH
if (!dbPath) {
  throw new Error('concurrent-send-message-worker: DB_PATH env var is required')
}

const selfLabel = process.env.AGENT_LABEL ?? 'boss'
const recipient = process.env.RECIPIENT ?? 'boss'
const workerId = process.env.WORKER_ID ?? 'unknown-worker'

const taskDb = new TaskDB(dbPath)

if (process.env.P5_TEST_START_GATE) {
  waitForStartGate(
    taskDb.getHandle(),
    process.env.P5_TEST_START_GATE,
    Number(process.env.P5_GATE_COUNT ?? 0)
  )
}

sendDirectedMessage(taskDb, selfLabel, {
  recipient,
  msg_type: 'status_update',
  payload: { worker: workerId },
})

process.exit(0)
