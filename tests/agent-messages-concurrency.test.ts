// tests/agent-messages-concurrency.test.ts — P5 EPIC-06 ATM-019.
//
// CROSS-PROCESS concurrency proof for sendDirectedMessage() — the load-bearing
// test matching the real multi-process agent topology (Ground truth: each
// agent runs its own `bun server.ts` process, all sharing one tasks.db file).
// Uses `Bun.spawn()` to launch REAL OS processes (never worker_threads) so
// BEGIN IMMEDIATE / nextWriteSeq() contention is genuine.
//
// sendDirectedMessage() is ALWAYS withMemoryWriteTxn()-wrapped (REQ-015c) —
// there is no unwrapped flag-OFF variant to reproduce a CONTROL race against
// (greenfield, mirroring pollDirectedMessages's ATM-020 reasoning). This test
// therefore uses ONLY the pre-transaction start gate (waitForStartGate) — no
// waitForBarrier — and sendDirectedMessage is called directly, bypassing the
// send_directed_message MCP tool's directed_messaging_enabled flag-gate
// entirely (that gate lives in server.ts's handler, not in agent-messages.ts).
//
// N=5 concurrent child processes, each with a DISTINCT AGENT_LABEL drawn from
// the 5-agent roster (boss/steve/sadie/kiera/snoopy), all sending ONE message
// to the SAME recipient, released simultaneously at the start gate. Asserts:
//   - all 5 rows land (no lost sends)
//   - each row's sender matches its spawning process's AGENT_LABEL (identity
//     resolved from the selfLabel parameter, never from a caller-supplied
//     field — no worker ever passes `sender` in its args)
//   - each row has a DISTINCT seq
//   - reading ordered by seq shows no two share a value

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'
import { sendDirectedMessage } from '../agent-messages'

const WORKER_PATH = new URL('./fixtures/concurrent-send-message-worker.ts', import.meta.url).pathname
const POLL_WORKER_PATH = new URL('./fixtures/concurrent-poll-worker.ts', import.meta.url).pathname
const N = 5
const SPAWN_TIMEOUT_MS = 30_000

// All 5 roster agents (config.ts's AGENT_SESSIONS keys) — one distinct sender
// per worker, per ATM-019's "distinct AGENT_LABEL per worker" requirement.
const SENDER_LABELS = ['boss', 'steve', 'sadie', 'kiera', 'snoopy']
const RECIPIENT = 'boss'

function tempDbPath(name: string): string {
  return `/tmp/p5-${name}-${crypto.randomUUID()}.db`
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

/** Spawn one concurrent-send-message-worker.ts as a real OS process; resolve its exit code. */
async function spawnSendWorker(env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(['bun', WORKER_PATH], {
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return proc.exited
}

describe('ATM-019 — sendDirectedMessage cross-process concurrency proof', () => {
  test(
    'N=5 distinct-sender workers, start-gate-synchronized, all land with distinct seq and no lost sends',
    async () => {
      const dbPath = tempDbPath('atm019-send')
      // Create the file + run migrations + set WAL/busy_timeout ONCE from the
      // main thread before any worker opens it (mirrors the memory-ordering
      // concurrency tests' rationale: N racing fresh connections converting
      // journal_mode on a brand-new file would themselves contend).
      // sendDirectedMessage() is ALWAYS wrapped regardless of
      // memory_write_ordering_enabled/directed_messaging_enabled — neither
      // flag needs to be set for this direct (non-MCP-tool) call path.
      const seedDb = new TaskDB(dbPath)
      seedDb.close()

      const runId = crypto.randomUUID()
      const gateName = `send-msg-fix-${runId}`

      expect(SENDER_LABELS).toHaveLength(N)

      const exitCodes = await Promise.all(
        SENDER_LABELS.map((label) =>
          spawnSendWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: label,
            RECIPIENT,
            WORKER_ID: label,
            P5_TEST_START_GATE: gateName,
            P5_GATE_COUNT: String(N),
          })
        )
      )
      for (const code of exitCodes) expect(code).toBe(0)

      const readDb = new Database(dbPath, { readonly: true })
      try {
        const rows = readDb
          .prepare('SELECT sender, recipient, msg_type, seq FROM agent_messages WHERE recipient = ? ORDER BY seq ASC')
          .all(RECIPIENT) as Array<{ sender: string; recipient: string; msg_type: string; seq: number }>

        // No lost sends — all 5 land.
        expect(rows).toHaveLength(N)

        // Each row's sender matches ITS spawning process's AGENT_LABEL —
        // proving identity was resolved from selfLabel, never a
        // caller-supplied field (no worker ever passed one).
        const sendersInDb = rows.map(r => r.sender).sort()
        expect(sendersInDb).toEqual([...SENDER_LABELS].sort())

        // Every row targeted the shared recipient.
        for (const row of rows) {
          expect(row.recipient).toBe(RECIPIENT)
          expect(row.msg_type).toBe('status_update')
        }

        // Each has a DISTINCT seq; ordered by seq shows no two share a value.
        const seqs = rows.map(r => r.seq)
        expect(new Set(seqs).size).toBe(N)
        for (let i = 1; i < seqs.length; i++) {
          expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
        }

        // Bonus: exactly N audit_log rows for this send batch (REQ-025/C7
        // audit-atomicity holds under real concurrency too, not just
        // sequentially — see ATM-028's dedicated fault-injection unit tests
        // in tests/agent-messages.test.ts for the all-or-nothing proof).
        const auditCount = (
          readDb.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_sent'").get() as { c: number }
        ).c
        expect(auditCount).toBe(N)
      } finally {
        readDb.close()
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )
})

/**
 * Spawn one concurrent-poll-worker.ts as a real OS process; resolve its exit
 * code + captured stdout (the worker's last stdout line is a JSON array of
 * `{id, seq}` for the rows IT claimed).
 */
async function spawnPollWorker(env: Record<string, string>): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(['bun', POLL_WORKER_PATH], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const output = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { code, output }
}

describe('ATM-020(b) — pollDirectedMessages cross-process CONCURRENT DISJOINT claim', () => {
  test(
    '2 same-recipient poll workers, start-gate-synchronized: union of claimed ids === all N sent, intersection === empty, each worker\'s own result is seq-ascending',
    async () => {
      const dbPath = tempDbPath('atm020b-poll')
      const POLL_RECIPIENT = 'steve'
      const N_MESSAGES = 6
      const N_WORKERS = 2

      // Seed the DB (schema + WAL/busy_timeout) AND the 6 pending messages
      // from the main thread BEFORE any worker opens the file — mirrors
      // ATM-019's seedDb rationale (a brand-new file being opened by N
      // racing fresh connections would itself contend).
      const seedDb = new TaskDB(dbPath)
      const allIds: number[] = []
      for (let i = 0; i < N_MESSAGES; i++) {
        const row = sendDirectedMessage(seedDb, 'boss', {
          recipient: POLL_RECIPIENT,
          msg_type: 'status_update',
          payload: { i },
        })
        allIds.push(row.id)
      }
      seedDb.close()

      const runId = crypto.randomUUID()
      const gateName = `poll-fix-${runId}`

      const results = await Promise.all(
        Array.from({ length: N_WORKERS }, () =>
          spawnPollWorker({
            DB_PATH: dbPath,
            AGENT_LABEL: POLL_RECIPIENT,
            P5_TEST_START_GATE: gateName,
            P5_GATE_COUNT: String(N_WORKERS),
          })
        )
      )

      try {
        for (const r of results) expect(r.code).toBe(0)

        const claimedSets = results.map((r) => {
          const lines = r.output.trim().split('\n').filter((l) => l.length > 0)
          const lastLine = lines[lines.length - 1]
          return JSON.parse(lastLine) as Array<{ id: number; seq: number }>
        })

        // Each worker's OWN returned set is seq-ascending.
        for (const set of claimedSets) {
          for (let i = 0; i < set.length - 1; i++) {
            expect(set[i].seq).toBeLessThan(set[i + 1].seq)
          }
        }

        const idSets = claimedSets.map((s) => new Set(s.map((r) => r.id)))

        // UNION === all 6 ids sent — no lost/unclaimed messages.
        const union = new Set<number>()
        for (const s of idSets) for (const id of s) union.add(id)
        expect(union.size).toBe(N_MESSAGES)
        expect([...union].sort((a, b) => a - b)).toEqual([...allIds].sort((a, b) => a - b))

        // INTERSECTION === empty — no double delivery across the two workers.
        const intersection = [...idSets[0]].filter((id) => idSets[1].has(id))
        expect(intersection).toEqual([])
      } finally {
        cleanupDbFile(dbPath)
      }
    },
    SPAWN_TIMEOUT_MS
  )
})
