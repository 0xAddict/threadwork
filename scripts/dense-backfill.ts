#!/usr/bin/env bun
/**
 * One-time / re-runnable dense index backfill (#10060808, GAP-4b Phase-2).
 *
 * Embeds every non-superseded memory that is missing an up-to-date vector and
 * stores it in memory_vectors. IDEMPOTENT: a memory whose stored content_hash
 * already matches its current content is skipped, so re-running only embeds
 * new/changed rows (this is how supersede/bulk-edit drift is reconciled).
 *
 * Run FOREGROUND/blocking — embedding is an ONNX forward pass (~145s for ~350
 * memories). Intended to run ONCE during the Boss-gated coordinated deploy,
 * BEFORE flipping TASKBOARD_DENSE_RECALL=on. Does NOT require the flag to be ON.
 *
 * Usage:  bun run scripts/dense-backfill.ts [dbPath]
 *   dbPath defaults to the config DB_PATH (live tasks.db). Pass an explicit path
 *   to backfill a copy (e.g. during testing) without touching the live DB.
 */
import { Database } from 'bun:sqlite'
import { DB_PATH } from '../config'
import {
  ensureVectorTable, embedTexts, putVector, contentHash, DENSE_MODEL_ID,
} from '../dense'

const dbPath = process.argv[2] ?? DB_PATH
console.log(`[dense-backfill] target DB: ${dbPath}`)
console.log(`[dense-backfill] model: ${DENSE_MODEL_ID}`)

const db = new Database(dbPath)
db.exec('PRAGMA busy_timeout=10000')
ensureVectorTable(db)

type MemRow = { id: number; content: string | null }
const mems = db
  .query("SELECT id, content FROM memories WHERE state != 'superseded'")
  .all() as MemRow[]

const existing = new Map<number, string>(
  (db.query('SELECT memory_id, content_hash FROM memory_vectors').all() as Array<{
    memory_id: number
    content_hash: string
  }>).map((r) => [r.memory_id, r.content_hash]),
)

const todo = mems.filter((m) => {
  const content = m.content ?? ''
  const prev = existing.get(m.id)
  return prev === undefined || prev !== contentHash(content)
})

console.log(
  `[dense-backfill] ${mems.length} non-superseded memories; ${existing.size} already indexed; ${todo.length} to (re)embed.`,
)

if (todo.length === 0) {
  console.log('[dense-backfill] index already up to date — nothing to do.')
  process.exit(0)
}

const t0 = Date.now()
const BATCH = 32
let done = 0
for (let i = 0; i < todo.length; i += BATCH) {
  const slice = todo.slice(i, i + BATCH)
  const vecs = await embedTexts(slice.map((m) => m.content ?? ''))
  const tx = db.transaction(() => {
    slice.forEach((m, j) => putVector(db, m.id, vecs[j], m.content ?? ''))
  })
  tx()
  done += slice.length
  console.log(`[dense-backfill]   ${done}/${todo.length} embedded (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

const total = (db.query('SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n
console.log(
  `[dense-backfill] DONE — embedded ${done} in ${((Date.now() - t0) / 1000).toFixed(1)}s; memory_vectors now holds ${total} vectors.`,
)
db.close()
