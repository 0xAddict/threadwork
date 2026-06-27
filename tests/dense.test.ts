// GAP-4b Phase-2 dense retrieval tests (#10060808).
//
// Self-contained: builds a FRESH temp DB (TaskDB.migrate() creates memories +
// memory_vectors + triggers), so no pre-staged copy is needed. Uses the
// __setTestEmbedder seam so NO onnxruntime/fastembed is loaded — embeddings are
// deterministic injected vectors. Proves:
//   (1) migration 0015 creates memory_vectors + delete-sync trigger;
//   (2) vector store round-trips; delete trigger removes the vector;
//   (3) pure helpers (rrfFuse, l2normalize, cosine, blob) are correct/deterministic;
//   (4) NO REGRESSION: flag OFF ⇒ recallAugmented() == recallMemories() (BM25);
//   (5) flag ON ⇒ dense AUGMENTS via RRF (surfaces a semantic hit BM25 missed,
//       without dropping the BM25 hit);
//   (6) DEGRADE: any dense/embedder failure ⇒ recallAugmented() == BM25 base.

import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import {
  rrfFuse, l2normalize, cosineNormalized, vecToBlob, blobToVec, contentHash,
  putVector, getVectors, vectorTableExists, __setTestEmbedder,
  DENSE_FLAG_ENV, DENSE_MODE_ENV,
} from '../dense'

const TEST_DB = `/tmp/dense-test-${process.pid}.db`
let taskDb: TaskDB
let mem: MemoryDB

function raw() { return taskDb.getHandle() }
function rm(p: string) { try { unlinkSync(p) } catch {} }

beforeAll(() => {
  for (const ext of ['', '-wal', '-shm']) rm(TEST_DB + ext)
  taskDb = new TaskDB(TEST_DB)            // migrate() => memories + memory_vectors + triggers
  mem = new MemoryDB(taskDb)
})
afterAll(() => {
  for (const ext of ['', '-wal', '-shm']) rm(TEST_DB + ext)
})
beforeEach(() => {
  delete process.env[DENSE_FLAG_ENV]
  delete process.env[DENSE_MODE_ENV]
  __setTestEmbedder(null)
})

// ---- (1) migration ------------------------------------------------------------
test('(1) migration 0015: memory_vectors table + delete trigger exist', () => {
  expect(vectorTableExists(raw())).toBe(true)
  const trg = raw().prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_memory_vectors_ad'",
  ).get()
  expect(trg).toBeTruthy()
})

// ---- (3) pure helpers ---------------------------------------------------------
test('(3a) l2normalize yields unit norm; cosineNormalized = dot', () => {
  const v = l2normalize(Float32Array.from([3, 4]))
  const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1])
  expect(norm).toBeCloseTo(1.0, 6)
  expect(cosineNormalized(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1, 6)
  expect(cosineNormalized(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6)
})

test('(3b) vec<->blob round-trips exactly', () => {
  const v = l2normalize(Float32Array.from([0.1, -0.2, 0.3, 0.9]))
  const back = blobToVec(vecToBlob(v))
  expect(back.length).toBe(v.length)
  for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i], 6)
})

test('(3c) rrfFuse is deterministic, keeps every id, tiebreaks by ascending id', () => {
  // list A: [10, 20, 30]   list B: [30, 40, 10]
  const fused = rrfFuse([[10, 20, 30], [30, 40, 10]], 60)
  expect(new Set(fused)).toEqual(new Set([10, 20, 30, 40])) // nothing dropped (augment)
  // 30: rank2(A)+rank0(B); 10: rank0(A)+rank2(B) -> equal scores -> ascending id => 10 before 30
  expect(fused.indexOf(10)).toBeLessThan(fused.indexOf(30))
  expect(fused).toEqual(rrfFuse([[10, 20, 30], [30, 40, 10]], 60)) // deterministic
})

// ---- (2) vector store + delete trigger ---------------------------------------
test('(2) putVector/getVectors round-trip; delete trigger removes vector', () => {
  const db = raw()
  const id = (db.prepare(
    "INSERT INTO memories (agent, content, category) VALUES ('steve', 'vec store probe', 'fact') RETURNING id",
  ).get() as { id: number }).id
  const v = l2normalize(Float32Array.from([0.2, 0.5, 0.1, 0.8]))
  putVector(db, id, v, 'vec store probe')

  const got = getVectors(db, [id])
  expect(got.has(id)).toBe(true)
  expect(cosineNormalized(got.get(id)!, v)).toBeCloseTo(1, 5)
  // content_hash stored
  const row = db.prepare('SELECT content_hash, dim FROM memory_vectors WHERE memory_id=?').get(id) as { content_hash: string; dim: number }
  expect(row.content_hash).toBe(contentHash('vec store probe'))
  expect(row.dim).toBe(4)

  // delete the memory -> trigger must drop the vector
  db.prepare('DELETE FROM memories WHERE id=?').run(id)
  expect(getVectors(db, [id]).has(id)).toBe(false)
})

// ---- (4) NO REGRESSION: flag OFF == BM25 -------------------------------------
test('(4) flag OFF: recallAugmented == recallMemories (byte-identical ids)', async () => {
  const a = 'steve'
  mem.saveMemory({ agent: a, content: 'apple orchard harvest notes', category: 'fact' })
  mem.saveMemory({ agent: a, content: 'banana ripening curve', category: 'fact' })
  mem.saveMemory({ agent: a, content: 'grape vineyard pruning', category: 'fact' })

  // Force flag OFF explicitly. With the #10060814 mcp.json fallback, an UNSET flag
  // no longer means OFF (it resolves from mcp.json, where the flag is now 'on'); so
  // the "flag OFF == BM25" regression guard must force process.env to 'off'.
  process.env[DENSE_FLAG_ENV] = 'off'
  const base = mem.recallMemories(a, { query: 'apple', limit: 10 })
  const aug = await mem.recallAugmented(a, { query: 'apple', limit: 10 })
  expect(aug.map(m => m.id)).toEqual(base.map(m => m.id))
})

// ---- (5) flag ON: dense AUGMENTS via RRF -------------------------------------
test('(5) flag ON: dense surfaces a semantic hit BM25 missed, keeps the BM25 hit', async () => {
  const a = 'denseagent'
  const m1 = mem.saveMemory({ agent: a, content: 'apple orchard harvest', category: 'fact' })
  const m2 = mem.saveMemory({ agent: a, content: 'banana ripening', category: 'fact' })
  const m3 = mem.saveMemory({ agent: a, content: 'grape vineyard', category: 'fact' })

  // Inject corpus vectors: orthogonal unit vectors. Query embeds closest to m3.
  putVector(raw(), m1.id, Float32Array.from([1, 0, 0, 0]), m1.content)
  putVector(raw(), m2.id, Float32Array.from([0, 1, 0, 0]), m2.content)
  putVector(raw(), m3.id, Float32Array.from([0, 0, 1, 0]), m3.content)
  __setTestEmbedder(async () => [Float32Array.from([0, 0, 1, 0])]) // query vec == m3

  // BM25 for 'apple' only matches m1; m3 is NOT in the BM25 result.
  const bm25 = mem.recallMemories(a, { query: 'apple', limit: 10 })
  expect(bm25.map(m => m.id)).toContain(m1.id)
  expect(bm25.map(m => m.id)).not.toContain(m3.id)

  process.env[DENSE_FLAG_ENV] = 'on'
  // Pin mode=rrf: this test verifies RRF augmentation specifically. With the
  // #10060814 mcp.json fallback an unset mode would resolve to mcp.json's 'dense'
  // and silently stop exercising RRF — pin it so the guard stays real.
  process.env[DENSE_MODE_ENV] = 'rrf'
  const aug = await mem.recallAugmented(a, { query: 'apple', limit: 10 })
  const ids = aug.map(m => m.id)
  expect(ids).toContain(m1.id)  // BM25 hit retained (never replaced)
  expect(ids).toContain(m3.id)  // semantic hit surfaced by dense augmentation
})

test('(5b) flag ON, mode=dense: returns pure dense ranking', async () => {
  const a = 'denseagent2'
  const m1 = mem.saveMemory({ agent: a, content: 'red signal alpha', category: 'fact' })
  const m2 = mem.saveMemory({ agent: a, content: 'blue signal beta', category: 'fact' })
  putVector(raw(), m1.id, Float32Array.from([1, 0, 0, 0]), m1.content)
  putVector(raw(), m2.id, Float32Array.from([0, 1, 0, 0]), m2.content)
  __setTestEmbedder(async () => [Float32Array.from([0, 1, 0, 0])]) // closest to m2

  process.env[DENSE_FLAG_ENV] = 'on'
  process.env[DENSE_MODE_ENV] = 'dense'
  const out = await mem.recallAugmented(a, { query: 'signal', limit: 10 })
  expect(out[0].id).toBe(m2.id) // pure dense: m2 ranks first
})

// ---- (6) DEGRADE: dense failure -> BM25 base ---------------------------------
test('(6) flag ON but embedder throws: degrades to BM25 base', async () => {
  const a = 'degradeagent'
  mem.saveMemory({ agent: a, content: 'kiwi fruit notes', category: 'fact' })
  const base = mem.recallMemories(a, { query: 'kiwi', limit: 10 })

  process.env[DENSE_FLAG_ENV] = 'on'
  __setTestEmbedder(async () => { throw new Error('boom: model unavailable') })
  const aug = await mem.recallAugmented(a, { query: 'kiwi', limit: 10 })
  expect(aug.map(m => m.id)).toEqual(base.map(m => m.id)) // identical to BM25 fallback
})

test('(6b) flag ON but no vectors stored: degrades to BM25 base', async () => {
  const a = 'novecsagent'
  mem.saveMemory({ agent: a, content: 'pear preserves recipe', category: 'fact' })
  const base = mem.recallMemories(a, { query: 'pear', limit: 10 })

  process.env[DENSE_FLAG_ENV] = 'on'
  __setTestEmbedder(async () => [Float32Array.from([0.5, 0.5, 0.5, 0.5])]) // embed ok, but no corpus vectors
  const aug = await mem.recallAugmented(a, { query: 'pear', limit: 10 })
  expect(aug.map(m => m.id)).toEqual(base.map(m => m.id))
})

// ---- (7) BURIAL REGRESSION: union-fusion surfaces a semantic-only gold ---------
// (#10060816) Fixture: 12 vectorized rows that DOMINATE BM25 (5x the query token,
// short docs) + exactly 1 GOLD that is a WEAK BM25 hit (token once, long doc → BM25
// rank 13, i.e. > limit) but is the TOP dense hit (vector == query). Pre-fix fused
// `base`(BM25 top-limit) ∪ denseOrder(ALL): gold got only a single (dense) RRF
// contribution and landed at fused pos 11 → sliced off. Post-fix fuses the decoupled
// UNION (BM25 top-K_bm ∪ dense top-K_d): gold is in BOTH channels → surfaces in
// top-limit. This test FAILS on pre-fix recallAugmented and PASSES on the fix.
// (test (5) can't catch this: its BM25 base size < limit, so nothing is sliced off.)
test('(7) burial regression: semantic-only gold (BM25 rank > limit) lands in fused top-limit', async () => {
  const a = 'burialagent'
  const limit = 10
  const FILLERS = 12 // > limit, so the BM25 base window is full and the gold is sliced out pre-fix

  // 12 fillers DOMINATE BM25 (5x token, short doc) but are dense-orthogonal to the query.
  const fillerIds: number[] = []
  for (let i = 0; i < FILLERS; i++) {
    const m = mem.saveMemory({
      agent: a,
      content: `burialtoken burialtoken burialtoken burialtoken burialtoken row${i}`,
      category: 'fact',
    })
    putVector(raw(), m.id, Float32Array.from([0, 1, 0, 0]), m.content) // cosine 0 to query
    fillerIds.push(m.id)
  }
  // GOLD: WEAK BM25 hit (token once + long unrelated doc → ranks below all fillers,
  // BM25 rank 13 > limit) but the TOP dense hit (vector == query → cosine 1).
  const gold = mem.saveMemory({
    agent: a,
    content:
      'burialtoken goldrow alpha beta gamma delta epsilon zeta eta theta iota kappa ' +
      'lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega distinct',
    category: 'fact',
  })
  putVector(raw(), gold.id, Float32Array.from([1, 0, 0, 0]), gold.content)
  __setTestEmbedder(async () => [Float32Array.from([1, 0, 0, 0])]) // query embeds onto the gold

  // Precondition: pure BM25 base buries the gold beyond the output limit.
  const baseBm25 = mem.recallMemories(a, { query: 'burialtoken', limit })
  expect(baseBm25.length).toBe(limit)
  expect(baseBm25.map(m => m.id)).not.toContain(gold.id) // gold NOT in BM25 top-limit

  // Post-fix: union-fusion (mode=rrf) surfaces the semantic-only gold into top-limit.
  process.env[DENSE_FLAG_ENV] = 'on'
  process.env[DENSE_MODE_ENV] = 'rrf'
  const aug = await mem.recallAugmented(a, { query: 'burialtoken', limit })
  expect(aug.length).toBe(limit)
  expect(aug.map(m => m.id)).toContain(gold.id) // FAILS pre-fix (buried at pos 11), PASSES on the fix
})
