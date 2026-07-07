// tests/fixtures/concurrent-poll-worker.ts — P5 ATM-020(b) standalone worker
// process.
//
// Spawned via `Bun.spawn()` (a REAL separate OS process, not a worker_thread)
// by tests/agent-messages-concurrency.test.ts to exercise pollDirectedMessages()
// under genuine multi-process contention on a shared tasks.db file — matching
// the Ground truth process model (each agent runs its OWN `bun server.ts`
// process against the same SQLite file). Mirrors
// concurrent-send-message-worker.ts's shape/env-var conventions.
//
// Env vars:
//   DB_PATH             (required) — path to the shared temp tasks.db.
//   AGENT_LABEL         — the polling agent's identity (= the recipient
//                         selfLabel). Passed as the selfLabel PARAMETER to
//                         pollDirectedMessages() — that function never reads
//                         config.ts's SELF_LABEL, so per-process identity
//                         resolution here is via explicit argument passing.
//                         Defaults 'boss'.
//   P5_TEST_START_GATE  — if set, this script calls waitForStartGate()
//                         IMMEDIATELY BEFORE invoking pollDirectedMessages()
//                         (the pre-transaction rendezvous proving genuine
//                         multi-process contention on BEGIN IMMEDIATE — the
//                         single-statement UPDATE ... WHERE status='pending'
//                         claim is ALWAYS withMemoryWriteTxn()-wrapped, so
//                         two workers polling the SAME recipient at the same
//                         instant can only claim DISJOINT rows).
//   P5_GATE_COUNT       — expected worker count for the start gate.
//
// Prints the claimed message ids (as a JSON array, seq-ascending — the order
// pollDirectedMessages() itself returns) to stdout as the LAST line, so the
// parent test can collect + compare per-worker claim sets for disjointness.
//
// NEVER import '../../server' — this is a standalone script; no MCP server
// bootstrap is needed or wanted here.

import { TaskDB } from '../../db'
import { pollDirectedMessages } from '../../agent-messages'
import { waitForStartGate } from './concurrency-barrier'

const dbPath = process.env.DB_PATH
if (!dbPath) {
  throw new Error('concurrent-poll-worker: DB_PATH env var is required')
}

const selfLabel = process.env.AGENT_LABEL ?? 'boss'

const taskDb = new TaskDB(dbPath)

if (process.env.P5_TEST_START_GATE) {
  waitForStartGate(
    taskDb.getHandle(),
    process.env.P5_TEST_START_GATE,
    Number(process.env.P5_GATE_COUNT ?? 0)
  )
}

const claimed = pollDirectedMessages(taskDb, selfLabel)

// Last stdout line is the JSON payload the parent test parses. Print seq too
// so the parent can independently verify per-worker seq-ascending order
// without re-querying the DB.
console.log(JSON.stringify(claimed.map((r) => ({ id: r.id, seq: r.seq }))))

process.exit(0)
