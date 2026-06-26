// GAP-4b Phase 1 (#10060804): the shared "Session-Debrief" aggregate down-weight.
//
// Background: ~23 shared `decision` blobs (avg ~143k chars, importance=5,
// quality=0.8) are a BM25 false-positive magnet — in the GAP-4b eval they
// outrank the specific gold memory in 31/36 low-overlap paraphrase queries.
// recall() now demotes that class (DEBRIEF_DEMOTE_FACTOR) so a focused memory on
// the queried topic is not crowded out, WITHOUT excluding the debrief entirely.
//
// These tests run on a FRESH small DB (deterministic, no live data). The decisive
// control is the contrast between two otherwise-identical high-importance,
// term-dense shared `decision` rows that differ ONLY by the "Session Debrief"
// prefix: the non-debrief one still wins (not demoted); the debrief one is pushed
// below a weaker focused memory (demoted). That isolates the fix to the class.

import { describe, test, expect, beforeEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { MemoryDB, DEBRIEF_DEMOTE_FACTOR } from '../memory'
import { TaskDB } from '../db'

const TEST_DB = '/tmp/memory-debrief-demote-test.db'

describe('GAP-4b debrief down-weight', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  // Raw insert so we control agent/category/importance/quality exactly. The FTS
  // triggers (trg_memories_fts_ai) index the row on INSERT automatically.
  function seed(agent: string, category: string, content: string, importance: number, quality: number): number {
    return taskDb.run(db => (db.prepare(
      `INSERT INTO memories (agent, content, category, importance, quality, state, source_type)
       VALUES (?, ?, ?, ?, ?, 'active', 'system') RETURNING id`
    ).get(agent, content, category, importance, quality) as { id: number }).id)
  }

  test('isDebriefAggregate classifies only the shared Session-Debrief class', () => {
    expect(mem.isDebriefAggregate({ agent: 'shared', category: 'decision', content: 'Decision #99: Session Debrief — 2026-06-15 outcomes...' })).toBe(true)
    // wrong agent
    expect(mem.isDebriefAggregate({ agent: 'boss', category: 'decision', content: 'Decision #99: Session Debrief — x' })).toBe(false)
    // wrong category
    expect(mem.isDebriefAggregate({ agent: 'shared', category: 'fact', content: 'Decision #99: Session Debrief — x' })).toBe(false)
    // a normal shared decision is NOT a debrief aggregate
    expect(mem.isDebriefAggregate({ agent: 'shared', category: 'decision', content: 'Decision #99: adopt the new deploy flow' })).toBe(false)
    // empty / null content
    expect(mem.isDebriefAggregate({ agent: 'shared', category: 'decision', content: '' })).toBe(false)
  })

  test('DEBRIEF_DEMOTE_FACTOR is a sane (0,1) demotion factor', () => {
    expect(DEBRIEF_DEMOTE_FACTOR).toBeGreaterThan(0)
    expect(DEBRIEF_DEMOTE_FACTOR).toBeLessThan(1)
  })

  // Both CONTROL and TREATMENT share this 3-doc corpus shape. The weak anchor
  // (matches only "gamma") is the BM25 minimum, so the focused memory normalizes
  // to a mid-range BM25 score instead of collapsing to 0 (the artifact a 2-doc
  // corpus would create). The decision row is the term-dense BM25 maximum AND has
  // the highest importance/quality, so absent demotion it wins outright.
  const QUERY = 'alpha beta gamma'
  function seedCorpus(decisionContent: string): { anchor: number; focused: number; decision: number } {
    const anchor = seed('boss', 'fact', 'gamma side mention only', 2, 0.4)
    const focused = seed('boss', 'fact', 'alpha beta gamma topic note', 3, 0.5)
    const decision = seed('shared', 'decision', decisionContent, 5, 0.8)
    return { anchor, focused, decision }
  }

  test('CONTROL: a non-debrief high-importance term-dense shared decision still wins (not demoted)', () => {
    const { focused, decision } = seedCorpus(
      'Decision #77: roadmap alpha beta gamma alpha beta gamma alpha beta gamma')
    const ids = mem.recall('boss', { query: QUERY, limit: 10 }).map(m => m.id)
    expect(ids).toContain(focused)
    expect(ids).toContain(decision)
    // Highest BM25 + highest importance/quality and NOT a debrief => it outranks
    // the focused memory. This is the counterfactual baseline for TREATMENT.
    expect(ids.indexOf(decision)).toBeLessThan(ids.indexOf(focused))
  })

  test('TREATMENT: an identical row WITH the Session-Debrief prefix is demoted below the focused memory', () => {
    const { focused, decision } = seedCorpus(
      'Decision #77: Session Debrief — 2026-06-15 alpha beta gamma alpha beta gamma alpha beta gamma')
    const ids = mem.recall('boss', { query: QUERY, limit: 10 }).map(m => m.id)
    // The debrief is still RETURNED (demoted, not excluded)...
    expect(ids).toContain(decision)
    // ...but the focused memory now ranks ABOVE it. The ONLY change from CONTROL
    // is the "Session Debrief" prefix, so the demotion is what flipped the order.
    expect(ids.indexOf(focused)).toBeLessThan(ids.indexOf(decision))
  })

  test('LIKE-path (category-only, no query) also demotes the debrief class', () => {
    const normal = seed('shared', 'decision', 'Decision #77: adopt the new deploy flow', 4, 0.7)
    const debrief = seed('shared', 'decision', 'Decision #78: Session Debrief — 2026-06-15 outcomes and notes', 5, 0.9)
    // No query => LIKE fallback path, ordered by the debrief-demote CASE first.
    const ids = mem.recall('shared', { category: 'decision', limit: 10 }).map(m => m.id)
    expect(ids).toContain(normal)
    expect(ids).toContain(debrief)
    // Despite higher importance/quality, the debrief sorts after the normal decision.
    expect(ids.indexOf(normal)).toBeLessThan(ids.indexOf(debrief))
  })
})
