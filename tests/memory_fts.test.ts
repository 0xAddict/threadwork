// Test for BM25 + query/task-aware memory system (#10060784).
//
// Runs against a COPY of the live DB (DB_PATH override via env), never the live
// tasks.db. The copy is created by the caller:
//   sqlite3 tasks.db ".backup '/tmp/test-mem.db'"
//   TEST_MEM_DB=/tmp/test-mem.db bun test tests/memory_fts.test.ts
//
// Proves: (a) bm25() ranks sensibly; (b) recall() returns relevant results
// INCLUDING a tag-heavy query with NO FTS5 syntax error; (c) get_boot_briefing
// (query) surfaces task-relevant memories AND still includes pinned/role; (d)
// the no-query path is identical to the pre-0014 output; (e) triggers keep the
// fts index synced on insert/update/delete.

import { test, expect, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'

const TEST_DB = process.env.TEST_MEM_DB || '/tmp/test-mem.db'

let taskDb: TaskDB
let mem: MemoryDB

beforeAll(() => {
  // Instantiating TaskDB against the copy runs migrate(), which applies the
  // 0014 FTS5 setup (create vtable + triggers + guarded backfill).
  taskDb = new TaskDB(TEST_DB)
  mem = new MemoryDB(taskDb)
})

function raw(): Database {
  return taskDb.getHandle()
}

test('migration: memories_fts vtable + triggers exist after migrate()', () => {
  const db = raw()
  const vtab = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories_fts'").get()
  expect(vtab).toBeTruthy()
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_memories_fts_%' ORDER BY name"
  ).all() as { name: string }[]
  expect(triggers.map(t => t.name)).toEqual([
    'trg_memories_fts_ad',
    'trg_memories_fts_ai',
    'trg_memories_fts_au',
  ])
})

test('migration: backfill count == memories count', () => {
  const db = raw()
  const mems = (db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n
  const fts = (db.prepare('SELECT count(*) AS n FROM memories_fts').get() as { n: number }).n
  expect(fts).toBe(mems)
  expect(mems).toBeGreaterThan(0)
})

test('(a) bm25() ranks sensibly', () => {
  const db = raw()
  // Unique per-run token so leftover rows from a prior test run on the same DB
  // copy can't pollute the assertion (the copy is not reset between bun runs).
  const tok = 'rankprobe' + Date.now()
  // Seed two rows: one with the search term repeated 3x, one with it once.
  db.prepare("INSERT INTO memories (agent, content, category) VALUES ('boss', ?, 'fact')").run(`zebra ${tok} banana ${tok} ${tok} ranking-probe-aaa`)
  db.prepare("INSERT INTO memories (agent, content, category) VALUES ('boss', ?, 'fact')").run(`${tok} once only ranking-probe-bbb`)
  const rows = db.prepare(`
    SELECT m.id, m.content, bm25(memories_fts) AS score
    FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ?
    ORDER BY bm25(memories_fts)
  `).all(`"${tok}"`) as { id: number; content: string; score: number }[]
  expect(rows.length).toBe(2)
  // More-negative bm25 = more relevant. The row with 3x the term should rank first.
  expect(rows[0].content).toContain('ranking-probe-aaa')
  expect(rows[0].score).toBeLessThan(rows[1].score)
})

test('(b) recall() with a tag-heavy query throws NO FTS5 syntax error', () => {
  // Seed a tag/ID-heavy memory like our real content.
  raw().prepare(
    "INSERT INTO memories (agent, content, category, quality, importance) VALUES ('boss', '[session-handoff:boss:2026-06-25T00:00:00Z] resumed work on #10060784 fts build', 'fact', 0.9, 5)"
  ).run()

  // These would all be FTS5 syntax errors if passed raw to MATCH.
  const nastyQueries = [
    'session-handoff',
    '#10060',
    '[session-handoff:boss]',
    'AND OR NOT near()',
    'two8.shop * "unterminated',
    '#10060784 [session-handoff:...]',
    ':::---###',
  ]
  for (const q of nastyQueries) {
    // sanitize should never throw, and should produce a safe expr or ''.
    const expr = mem.sanitizeFtsQuery(q)
    expect(typeof expr).toBe('string')
    // recall must not throw on any of these.
    let results: any
    expect(() => { results = mem.recall('boss', { query: q, limit: 5 }) }).not.toThrow()
    expect(Array.isArray(results)).toBe(true)
  }

  // And the meaningful tag query should actually FIND the seeded row.
  const hits = mem.recall('boss', { query: 'session-handoff 10060784', limit: 10 })
  const found = hits.some(m => m.content.includes('[session-handoff:boss:2026-06-25'))
  expect(found).toBe(true)
})

test('(b2) sanitizeFtsQuery produces OR-joined quoted tokens', () => {
  expect(mem.sanitizeFtsQuery('session-handoff:boss #10060')).toBe('"session" OR "handoff" OR "boss" OR "10060"')
  expect(mem.sanitizeFtsQuery(':::---###')).toBe('')
  expect(mem.sanitizeFtsQuery('   ')).toBe('')
  expect(mem.sanitizeFtsQuery('Two8.Shop')).toBe('"two8" OR "shop"')
})

test('(c) get_boot_briefing(query) surfaces task-relevant memories AND keeps pinned/role', () => {
  const db = raw()
  // Seed a pinned role row + a pinned non-role row + a relevant unpinned row.
  db.prepare("INSERT INTO memories (agent, content, category, pinned, state, quality, importance) VALUES ('boss', 'BOOT-ROLE-PROBE you are the orchestrator', 'role', 1, 'active', 0.9, 5)").run()
  db.prepare("INSERT INTO memories (agent, content, category, pinned, state, quality, importance) VALUES ('boss', 'BOOT-PINNED-PROBE critical pinned knowledge xyzzy', 'fact', 1, 'active', 0.8, 5)").run()
  db.prepare("INSERT INTO memories (agent, content, category, pinned, state, quality, importance) VALUES ('boss', 'BOOT-RELEVANT-PROBE about apollo enrichment stack quux', 'fact', 0, 'active', 0.6, 3)").run()

  const briefing = mem.getBootBriefing('boss', taskDb, 'apollo enrichment quux')
  expect(briefing.relevantQuery).toBe('apollo enrichment quux')
  // relevant section should include the relevant probe.
  const relevantContents = briefing.relevantMemories.map(m => m.content)
  expect(relevantContents.some(c => c.includes('BOOT-RELEVANT-PROBE'))).toBe(true)
  // pinned rows must always be present in relevantMemories.
  const hasPinned = briefing.relevantMemories.some(m => m.pinned === 1)
  expect(hasPinned).toBe(true)
  // role section still computed and includes the role probe.
  expect(briefing.role.some(m => m.content.includes('BOOT-ROLE-PROBE'))).toBe(true)
})

test('(d) no-query + no active task path == pre-0014 (relevantMemories empty)', () => {
  // Use a brand-new agent with NO active task so nothing is auto-derived.
  const agent = 'test-noquery-agent'
  raw().prepare("INSERT INTO memories (agent, content, category, state, quality, importance) VALUES (?, 'noquery probe memory', 'fact', 'active', 0.7, 4)").run(agent)

  const briefing = mem.getBootBriefing(agent, taskDb)  // no query
  expect(briefing.relevantQuery).toBeNull()
  expect(briefing.relevantMemories).toEqual([])
  // The classic sections are still produced (topMemories present for this agent).
  expect(briefing.topMemories.some(m => m.content.includes('noquery probe memory'))).toBe(true)
})

test('(d2) boot briefing auto-derives query from an active task', () => {
  const db = raw()
  const agent = 'test-activetask-agent'
  // Insert a memory relevant to the task description.
  db.prepare("INSERT INTO memories (agent, content, category, state, quality, importance) VALUES (?, 'ACTIVETASK-PROBE migration backfill triggers fts', 'fact', 'active', 0.6, 3)").run(agent)
  // Insert a self-assigned in_progress task (from==to so no supervisor needed).
  db.prepare(`INSERT INTO tasks (from_agent, to_agent, description, status, claimed_at, supervisor_agent)
              VALUES (?, ?, 'build the migration backfill triggers fts system', 'in_progress', datetime('now'), ?)`).run(agent, agent, agent)

  const briefing = mem.getBootBriefing(agent, taskDb)  // no explicit query -> derive
  expect(briefing.relevantQuery).toContain('migration backfill')
  expect(briefing.relevantMemories.some(m => m.content.includes('ACTIVETASK-PROBE'))).toBe(true)
})

test('(e) triggers keep fts synced on INSERT / UPDATE / DELETE', () => {
  const db = raw()
  const marker = 'TRIGGER-SYNC-PROBE-' + Date.now()

  // INSERT
  const ins = db.prepare("INSERT INTO memories (agent, content, category) VALUES ('boss', ?, 'fact') RETURNING id").get(`${marker} alpha`) as { id: number }
  let n = (db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get(`"${marker.toLowerCase()}"`) as { n: number }).n
  expect(n).toBe(1)

  // UPDATE the content so old token disappears, new token appears.
  const newMarker = marker + '-UPDATED'
  db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(`${newMarker} beta`, ins.id)
  const nOld = (db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get(`"${marker.toLowerCase()}"`) as { n: number }).n
  const nNew = (db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get(`"${newMarker.toLowerCase()}"`) as { n: number }).n
  // 'updated' token only exists post-update; the bare marker still appears as a
  // prefix-substring of the updated row, so assert via the unique 'beta'/'alpha'.
  const nAlpha = (db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get('"alpha" AND "' + marker.toLowerCase() + '"') as { n: number }).n
  const nBeta = (db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get('"beta"') as { n: number }).n
  expect(nAlpha).toBe(0)   // old content gone from index
  expect(nBeta).toBeGreaterThanOrEqual(1) // new content indexed
  expect(nNew).toBe(1)

  // DELETE
  db.prepare("DELETE FROM memories WHERE id = ?").run(ins.id)
  const nDel = (db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get(`"${newMarker.toLowerCase()}"`) as { n: number }).n
  expect(nDel).toBe(0)

  // Integrity check: external-content table not corrupt.
  const integ = db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')")
  expect(() => integ.run()).not.toThrow()
})
