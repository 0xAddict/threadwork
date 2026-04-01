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
    mem.saveMemory({ agent: 'steve', content: 'CTO role', category: 'role', importance: 5, pinned: true })
    mem.saveMemory({ agent: 'steve', content: 'Key learning', category: 'learning', importance: 4 })

    generateBriefing('steve', mem, taskDb, TEST_BRIEFING_DIR)

    const filePath = `${TEST_BRIEFING_DIR}/steve.json`
    expect(existsSync(filePath)).toBe(true)

    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(data.role).toHaveLength(1)
    expect(data.topMemories.length).toBeGreaterThanOrEqual(1)
  })
})
