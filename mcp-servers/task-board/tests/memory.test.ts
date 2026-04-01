import { describe, test, expect, beforeEach } from 'bun:test'
import { MemoryDB } from '../memory'
import { TaskDB } from '../db'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/memory-test.db'

describe('MemoryDB', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  test('saveMemory creates a memory with correct fields', () => {
    const m = mem.saveMemory({
      agent: 'steve',
      content: 'Shopify API returns UTC timestamps',
      category: 'learning',
      importance: 4,
      pinned: false,
    })
    expect(m.id).toBeGreaterThan(0)
    expect(m.agent).toBe('steve')
    expect(m.content).toBe('Shopify API returns UTC timestamps')
    expect(m.category).toBe('learning')
    expect(m.importance).toBe(4)
    expect(m.pinned).toBe(0)
    expect(m.access_count).toBe(0)
  })

  test('saveMemory defaults importance to 3', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'test', category: 'fact' })
    expect(m.importance).toBe(3)
  })

  test('saveMemory dedupes repeated learnings and strengthens support', () => {
    const first = mem.saveMemory({
      agent: 'steve',
      content: 'SMS works better when the offer expires tonight',
      category: 'learning',
      importance: 3,
      quality: 0.6,
      evidence: 'Campaign 41',
    })
    const second = mem.saveMemory({
      agent: 'steve',
      content: ' sms works better when the offer expires tonight ',
      category: 'learning',
      importance: 4,
      quality: 0.8,
      evidence: 'Campaign 44',
    })

    expect(second.id).toBe(first.id)
    expect(second.support_count).toBe(2)
    expect(second.importance).toBe(4)
    expect(second.quality).toBe(0.8)
    expect(second.evidence).toContain('Campaign 41')
    expect(second.evidence).toContain('Campaign 44')
  })

  test('recallMemories returns own + shared memories', () => {
    mem.saveMemory({ agent: 'steve', content: 'Steve specific', category: 'learning' })
    mem.saveMemory({ agent: 'shared', content: 'Shared knowledge', category: 'fact' })
    mem.saveMemory({ agent: 'sadie', content: 'Sadie specific', category: 'learning' })
    const results = mem.recallMemories('steve', {})
    expect(results).toHaveLength(2)
    const agents = results.map(r => r.agent).sort()
    expect(agents).toEqual(['shared', 'steve'])
  })

  test('recallMemories filters by query', () => {
    mem.saveMemory({ agent: 'steve', content: 'Shopify API returns UTC', category: 'learning' })
    mem.saveMemory({ agent: 'steve', content: 'Facebook ads convert better with urgency', category: 'learning' })
    const results = mem.recallMemories('steve', { query: 'Shopify' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('Shopify')
  })

  test('recallMemories filters by category', () => {
    mem.saveMemory({ agent: 'steve', content: 'A learning', category: 'learning' })
    mem.saveMemory({ agent: 'steve', content: 'A preference', category: 'preference' })
    const results = mem.recallMemories('steve', { category: 'learning' })
    expect(results).toHaveLength(1)
    expect(results[0].category).toBe('learning')
  })

  test('recallMemories updates access tracking', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'test', category: 'fact', importance: 3 })
    mem.recallMemories('steve', {})
    const updated = mem.getMemory(m.id)
    expect(updated!.access_count).toBe(1)
    expect(updated!.importance).toBe(4)
  })

  test('recallMemories caps importance at 5', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'test', category: 'fact', importance: 5 })
    mem.recallMemories('steve', {})
    const updated = mem.getMemory(m.id)
    expect(updated!.importance).toBe(5)
    expect(updated!.access_count).toBe(1)
  })

  test('promoteMemory changes agent to shared', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'promote me', category: 'learning' })
    const promoted = mem.promoteMemory(m.id)
    expect(promoted!.agent).toBe('shared')
  })

  test('pinMemory toggles pin status', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'pin me', category: 'role' })
    expect(m.pinned).toBe(0)
    const pinned = mem.pinMemory(m.id)
    expect(pinned!.pinned).toBe(1)
    const unpinned = mem.pinMemory(m.id)
    expect(unpinned!.pinned).toBe(0)
  })

  test('getBootBriefing returns tiered summary without updating access', () => {
    mem.saveMemory({ agent: 'steve', content: 'You are the CTO', category: 'role', importance: 5, pinned: true })
    mem.saveMemory({ agent: 'steve', content: 'Important learning', category: 'learning', importance: 5 })
    mem.saveMemory({ agent: 'shared', content: 'Team uses Bun runtime', category: 'fact', importance: 4 })
    mem.saveMemory({ agent: 'steve', content: 'Low value', category: 'fact', importance: 1 })

    const briefing = mem.getBootBriefing('steve', taskDb)
    expect(briefing.role).toHaveLength(1)
    expect(briefing.role[0].content).toBe('You are the CTO')
    expect(briefing.topMemories.length).toBeGreaterThanOrEqual(1)
    expect(briefing.sharedMemories).toHaveLength(1)

    const role = mem.getMemory(briefing.role[0].id)
    expect(role!.access_count).toBe(0)
  })

  test('challengeMemory downgrades weak learnings into disputed state', () => {
    const m = mem.saveMemory({
      agent: 'steve',
      content: 'Meta broad targeting always wins',
      category: 'learning',
      quality: 0.5,
      evidence: 'Anecdotal',
    })

    const challenged = mem.challengeMemory(m.id, 'Recent spend lost money on this setup', 0.9)
    expect(challenged).not.toBeNull()
    expect(challenged!.challenge_count).toBe(1)
    expect(challenged!.state).toBe('disputed')
    expect(challenged!.quality).toBeLessThan(m.quality)
    expect(challenged!.evidence).toContain('CHALLENGE:')
  })

  test('supersedeMemory replaces stale guidance with a new active memory', () => {
    const stale = mem.saveMemory({
      agent: 'steve',
      content: 'Discount the hero product every weekend',
      category: 'learning',
      quality: 0.55,
    })

    const replacement = mem.supersedeMemory(stale.id, {
      content: 'Discount the hero product only when inventory is high and blended margin can absorb it',
      evidence: 'Margin analysis from Q1',
      quality: 0.9,
      classification: 'strategic',
    })

    expect(replacement).not.toBeNull()
    expect(replacement!.supersedes_memory_id).toBe(stale.id)
    expect(replacement!.state).toBe('active')
    expect(replacement!.classification).toBe('strategic')

    const old = mem.getMemory(stale.id)
    expect(old!.state).toBe('superseded')
  })
})
