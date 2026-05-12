import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { runDecay, runArchive, runPrune, generateBriefing } from '../consolidate'
import { unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs'

const TEST_DB = '/tmp/consolidate-test.db'
const TEST_BRIEFING_DIR = '/tmp/consolidate-briefings'

describe('consolidation', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
    try { Bun.spawnSync(['rm', '-rf', TEST_BRIEFING_DIR]) } catch {}
    mkdirSync(TEST_BRIEFING_DIR, { recursive: true })
  })

  test('runDecay reduces importance for old unaccessed memories', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'old memory', category: 'fact', importance: 3 })
    const db = (taskDb as any).db
    db.prepare("UPDATE memories SET last_accessed = datetime('now', '-14 days') WHERE id = ?").run(m.id)

    const decayed = runDecay(mem)
    expect(decayed).toBe(1)

    const updated = mem.getMemory(m.id)
    expect(updated!.importance).toBe(1) // 3 - 2 (14 days = 2 decay periods)
  })

  test('runDecay does not touch pinned memories', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'pinned', category: 'role', importance: 3, pinned: true })
    const db = (taskDb as any).db
    db.prepare("UPDATE memories SET last_accessed = datetime('now', '-30 days') WHERE id = ?").run(m.id)

    const decayed = runDecay(mem)
    expect(decayed).toBe(0)

    const updated = mem.getMemory(m.id)
    expect(updated!.importance).toBe(3)
  })

  test('runArchive moves importance-0 memories to archive', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'dead memory', category: 'fact', importance: 0 })

    const archived = runArchive(mem)
    expect(archived).toBe(1)

    const gone = mem.getMemory(m.id)
    expect(gone).toBeNull()
  })

  test('runPrune deletes old archived memories', () => {
    const db = (taskDb as any).db
    db.prepare(`
      INSERT INTO memory_archive (agent, content, category, importance, pinned, created_at, last_accessed, access_count, archived_at)
      VALUES ('steve', 'ancient', 'fact', 0, 0, datetime('now', '-120 days'), datetime('now', '-120 days'), 0, datetime('now', '-91 days'))
    `).run()

    const pruned = runPrune(mem, 90)
    expect(pruned).toBe(1)
  })

  test('generateBriefing writes JSON file for agent', () => {
    mem.saveMemory({ agent: 'steve', content: 'CTO role', category: 'role', importance: 5, pinned: true, source_type: 'consolidation' })
    mem.saveMemory({ agent: 'steve', content: 'Key learning', category: 'learning', importance: 4 })

    generateBriefing('steve', mem, taskDb, TEST_BRIEFING_DIR)

    const filePath = `${TEST_BRIEFING_DIR}/steve.json`
    expect(existsSync(filePath)).toBe(true)

    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(data.role).toHaveLength(1)
    expect(data.topMemories.length).toBeGreaterThanOrEqual(1)
  })
})

// --- AutoDream: Task 3 tests ---
import { getDecayWindowDays } from '../consolidate'

const TEST_DB_CONSOL = '/tmp/test-autodream-consolidate.db'

describe('getDecayWindowDays', () => {
  test('foundational returns 28 (finite, longest window — durability via pin, not classification)', () => {
    // Per task #823 (revert of #804): foundational is no longer decay-exempt.
    // It gets the longest finite window; rows that must survive should be
    // pinned (pinned=1 excludes from getDecayCandidate entirely).
    const m = { classification: 'foundational', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(28)
  })

  test('strategic returns 14', () => {
    const m = { classification: 'strategic', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(14)
  })

  test('operational returns 7', () => {
    const m = { classification: 'operational', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(7)
  })

  test('observational returns 3', () => {
    const m = { classification: 'observational', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(3)
  })

  test('ephemeral returns 1', () => {
    const m = { classification: 'ephemeral', state: 'active', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(1)
  })

  test('disputed halves window', () => {
    const m = { classification: 'operational', state: 'disputed', quality: 0.5, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(4) // ceil(7/2)
  })

  test('low quality halves window', () => {
    const m = { classification: 'operational', state: 'active', quality: 0.2, challenge_count: 0, support_count: 0 } as any
    expect(getDecayWindowDays(m)).toBe(4) // ceil(7/2)
  })

  test('challenge > support halves window', () => {
    const m = { classification: 'strategic', state: 'active', quality: 0.5, challenge_count: 3, support_count: 1 } as any
    expect(getDecayWindowDays(m)).toBe(7) // ceil(14/2)
  })

  test('multiple modifiers stack', () => {
    const m = { classification: 'operational', state: 'disputed', quality: 0.2, challenge_count: 3, support_count: 0 } as any
    // 7 -> 4 (disputed) -> 2 (low quality) -> 1 (challenged)
    expect(getDecayWindowDays(m)).toBe(1)
  })
})

describe('runArchive sweeps superseded', () => {
  let taskDb3: TaskDB
  let mem3: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB_CONSOL) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB_CONSOL + suffix) } catch {}
    }
    taskDb3 = new TaskDB(TEST_DB_CONSOL)
    mem3 = new MemoryDB(taskDb3)
  })

  test('archives superseded memories older than 7 days', () => {
    const m = mem3.saveMemory({ agent: 'boss', content: 'old fact', category: 'fact' })
    // Manually set state to superseded and backdate
    taskDb3.run(db => {
      db.prepare("UPDATE memories SET state = 'superseded', last_accessed = datetime('now', '-8 days') WHERE id = ?").run(m.id)
    })
    const archived = runArchive(mem3)
    expect(archived).toBeGreaterThanOrEqual(1)
    expect(mem3.getMemory(m.id)).toBeNull()
  })
})
