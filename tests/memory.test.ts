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
    mem.saveMemory({ agent: 'steve', content: 'You are the CTO', category: 'role', importance: 5, pinned: true, source_type: 'consolidation' })
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
})

// --- AutoDream: Schema migration tests ---
const TEST_DB_AUTODREAM = '/tmp/test-autodream-schema.db'

describe('schema migration — DTC columns', () => {
  let taskDb2: TaskDB
  let mem2: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB_AUTODREAM) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB_AUTODREAM + suffix) } catch {}
    }
    taskDb2 = new TaskDB(TEST_DB_AUTODREAM)
    mem2 = new MemoryDB(taskDb2)
  })

  test('memories table has DTC columns with defaults', () => {
    const m = mem2.saveMemory({ agent: 'boss', content: 'test', category: 'fact' })
    expect(m.classification).toBe('operational')
    expect(m.quality).toBe(0.5)
    expect(m.state).toBe('active')
    expect(m.source_type).toBe('agent')
    expect(m.support_count).toBe(0)
    expect(m.challenge_count).toBe(0)
    expect(m.supersedes_memory_id).toBeNull()
    expect(m.last_validated).toBeTruthy()
  })

  test('consolidation_locks table exists', () => {
    const result = taskDb2.run(db =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consolidation_locks'").get()
    )
    expect(result).toBeTruthy()
  })

  test('consolidation_runs table exists', () => {
    const result = taskDb2.run(db =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consolidation_runs'").get()
    )
    expect(result).toBeTruthy()
  })
})

// --- AutoDream: Task 2 tests ---

describe('normalizeContent', () => {
  let taskDb3: TaskDB
  let mem3: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB_AUTODREAM) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB_AUTODREAM + suffix) } catch {}
    }
    taskDb3 = new TaskDB(TEST_DB_AUTODREAM)
    mem3 = new MemoryDB(taskDb3)
  })

  test('collapses whitespace and trims', () => {
    expect(mem3.normalizeContent('  hello   world  ')).toBe('hello world')
  })

  test('lowercases', () => {
    expect(mem3.normalizeContent('Hello World')).toBe('hello world')
  })
})

describe('inferClassification', () => {
  let taskDb4: TaskDB
  let mem4: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB_AUTODREAM) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB_AUTODREAM + suffix) } catch {}
    }
    taskDb4 = new TaskDB(TEST_DB_AUTODREAM)
    mem4 = new MemoryDB(taskDb4)
  })

  test('role category maps to foundational', () => {
    expect(mem4.inferClassification('any content', 'role')).toBe('foundational')
  })

  test('preference category maps to strategic', () => {
    expect(mem4.inferClassification('any content', 'preference')).toBe('strategic')
  })

  test('fact category maps to operational', () => {
    expect(mem4.inferClassification('any content', 'fact')).toBe('operational')
  })

  test('task_summary category maps to observational', () => {
    expect(mem4.inferClassification('any content', 'task_summary')).toBe('observational')
  })

  test('learning category maps to operational', () => {
    expect(mem4.inferClassification('any content', 'learning')).toBe('operational')
  })
})

describe('challengeMemory', () => {
  let taskDb5: TaskDB
  let mem5: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB_AUTODREAM) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB_AUTODREAM + suffix) } catch {}
    }
    taskDb5 = new TaskDB(TEST_DB_AUTODREAM)
    mem5 = new MemoryDB(taskDb5)
  })

  test('increments challenge_count', () => {
    const m = mem5.saveMemory({ agent: 'boss', content: 'test fact', category: 'fact' })
    const challenged = mem5.challengeMemory(m.id, 'outdated info')
    expect(challenged).not.toBeNull()
    expect(challenged!.challenge_count).toBe(1)
  })

  test('flips to disputed when challenge_count > support_count', () => {
    const m = mem5.saveMemory({ agent: 'boss', content: 'test fact', category: 'fact' })
    const challenged = mem5.challengeMemory(m.id, 'outdated info')
    expect(challenged!.state).toBe('disputed')
    expect(challenged!.quality).toBeLessThan(0.5)
  })

  test('reduces quality by 0.2 when disputed, floored at 0', () => {
    const m = mem5.saveMemory({ agent: 'boss', content: 'test fact', category: 'fact' })
    const c1 = mem5.challengeMemory(m.id, 'reason 1')
    expect(c1!.quality).toBeCloseTo(0.3, 1)
    const c2 = mem5.challengeMemory(m.id, 'reason 2')
    expect(c2!.quality).toBeCloseTo(0.1, 1)
    const c3 = mem5.challengeMemory(m.id, 'reason 3')
    expect(c3!.quality).toBeCloseTo(0.0, 1)
  })

  test('returns null for nonexistent memory', () => {
    expect(mem5.challengeMemory(9999, 'reason')).toBeNull()
  })
})

describe('supersedeMemory', () => {
  let taskDb6: TaskDB
  let mem6: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB_AUTODREAM) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB_AUTODREAM + suffix) } catch {}
    }
    taskDb6 = new TaskDB(TEST_DB_AUTODREAM)
    mem6 = new MemoryDB(taskDb6)
  })

  test('marks old memory as superseded and creates replacement', () => {
    const old = mem6.saveMemory({ agent: 'boss', content: 'old fact', category: 'fact' })
    const result = mem6.supersedeMemory(old.id, 'new fact', 'updated info')
    expect(result).not.toBeNull()
    expect(result!.old.state).toBe('superseded')
    expect(result!.new.content).toBe('new fact')
    expect(result!.new.supersedes_memory_id).toBe(old.id)
    expect(result!.new.agent).toBe('boss')
    expect(result!.new.category).toBe('fact')
    expect(result!.new.classification).toBe(old.classification)
  })

  test('returns null for nonexistent memory', () => {
    expect(mem6.supersedeMemory(9999, 'new', 'reason')).toBeNull()
  })
})

describe('recallMemories query normalization (S3.1)', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  test('case insensitive: lowercase query matches mixed-case content', () => {
    mem.saveMemory({ agent: 'steve', content: 'Shopify API returns UTC', category: 'learning' })
    const results = mem.recallMemories('steve', { query: 'shopify api' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('Shopify API returns UTC')
  })

  test('token order: reversed tokens still match', () => {
    mem.saveMemory({ agent: 'steve', content: 'Shopify API returns UTC', category: 'learning' })
    const results = mem.recallMemories('steve', { query: 'UTC Shopify' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('Shopify API returns UTC')
  })

  test('numeric query: recall with just a number', () => {
    mem.saveMemory({ agent: 'steve', content: 'Campaign #381 had 2x ROAS', category: 'learning' })
    const results = mem.recallMemories('steve', { query: '381' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('381')
  })

  test('LIKE wildcard escape: underscore is literal, not wildcard', () => {
    mem.saveMemory({ agent: 'steve', content: 'Use snake_case for params', category: 'learning' })
    mem.saveMemory({ agent: 'steve', content: 'Use snakeXcase for params', category: 'learning' })
    const results = mem.recallMemories('steve', { query: 'snake_case' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('Use snake_case for params')
  })

  test('extra whitespace: query with extra spaces still matches', () => {
    mem.saveMemory({ agent: 'steve', content: 'Shopify API returns UTC', category: 'learning' })
    const results = mem.recallMemories('steve', { query: '  shopify   api  ' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('Shopify API returns UTC')
  })

  test('whitespace-only query: treated as no filter', () => {
    mem.saveMemory({ agent: 'steve', content: 'Some memory', category: 'learning' })
    mem.saveMemory({ agent: 'steve', content: 'Another memory', category: 'fact' })
    const results = mem.recallMemories('steve', { query: '   ' })
    expect(results).toHaveLength(2)
  })

  test('Unicode NFC normalization: composed vs decomposed accents match', () => {
    // 'café' written with a single precomposed character U+00E9 (é)
    const composed = 'caf\u00e9 menu has great coffee'
    // 'café' written with c + e + combining acute U+0301
    const decomposed = 'caf\u0065\u0301'
    // Sanity check: these byte sequences are different
    expect(composed.includes(decomposed)).toBe(false)

    mem.saveMemory({ agent: 'steve', content: composed, category: 'learning' })
    // Query with the decomposed form — should find the composed content
    // because normalizeContent applies NFC to both sides.
    const results = mem.recallMemories('steve', { query: decomposed })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe(composed)
  })

  test('numeric ref with hash prefix: #381 matches content containing #381', () => {
    mem.saveMemory({ agent: 'steve', content: 'Issue #381 blocked relay', category: 'learning' })
    const results = mem.recallMemories('steve', { query: '#381' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('#381')
  })

  test('underscore vs hyphen: hyphen query NOW matches underscore content (BM25, #10060784)', () => {
    // BEHAVIOR CHANGE (#10060784): recall now routes text queries through the
    // FTS5 BM25 backend, whose unicode61 tokenizer splits on BOTH '_' and '-'.
    // So 'blocked_relay' content and 'blocked-relay' query both tokenize to
    // ['blocked','relay'] and MATCH. This is the intended improvement for our
    // tag/ID-heavy content (session-handoff, blocked_relay, two8.shop). The old
    // LIKE path treated them as distinct literals (asserted length 0); the new
    // path correctly unifies them.
    mem.saveMemory({ agent: 'steve', content: 'blocked_relay circuit issue', category: 'learning' })
    const results = mem.recallMemories('steve', { query: 'blocked-relay' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('blocked_relay circuit issue')
  })
})

describe('recallMemories agent scoping (S3.3)', () => {
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
  })

  test('promoted-shared memory is visible to non-owner', () => {
    const m = mem.saveMemory({ agent: 'steve', content: 'Steve discovered a shortcut', category: 'learning' })
    mem.promoteMemory(m.id)
    const results = mem.recallMemories('sadie', { query: 'shortcut' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('Steve discovered a shortcut')
    expect(results[0].agent).toBe('shared')
  })

  test('non-owner cannot see another agents non-shared memories', () => {
    mem.saveMemory({ agent: 'steve', content: 'Steve private secret', category: 'learning' })
    const results = mem.recallMemories('sadie', { query: 'secret' })
    expect(results).toHaveLength(0)
  })

  test('recall scope includes agents own AND shared memories', () => {
    mem.saveMemory({ agent: 'steve', content: 'Steve own memory', category: 'learning' })
    mem.saveMemory({ agent: 'shared', content: 'Shared team memory', category: 'fact' })
    const results = mem.recallMemories('steve', { limit: 20 })
    expect(results).toHaveLength(2)
    const agents = results.map(r => r.agent).sort()
    expect(agents).toEqual(['shared', 'steve'])
  })
})

describe('getDecayCandidate — foundational no longer hardcoded-exempt (task #823)', () => {
  const TEST_DB_DECAY = '/tmp/memory-test-decay.db'
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB_DECAY + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB_DECAY)
    mem = new MemoryDB(taskDb)
  })

  test('foundational + unpinned + idle: IS a decay candidate', () => {
    // Seed a foundational row directly with last_accessed in the past so it
    // satisfies the "-1 days" idle clause in getDecayCandidate.
    const m = mem.saveMemory({
      agent: 'sadie',
      content: 'unpinned foundational claim',
      category: 'role',
      classification: 'foundational',
      source_type: 'human',
    })
    taskDb.run(db => db.prepare(
      "UPDATE memories SET last_accessed = datetime('now', '-3 days') WHERE id = ?"
    ).run(m.id))

    const candidates = mem.getDecayCandidate()
    const ids = candidates.map(c => c.id)
    expect(ids).toContain(m.id)
  })

  test('foundational + pinned=true: NOT a decay candidate (pin is the durability signal)', () => {
    const m = mem.saveMemory({
      agent: 'sadie',
      content: 'pinned foundational claim',
      category: 'role',
      classification: 'foundational',
      source_type: 'human',
      pinned: true,
    })
    taskDb.run(db => db.prepare(
      "UPDATE memories SET last_accessed = datetime('now', '-3 days') WHERE id = ?"
    ).run(m.id))

    const candidates = mem.getDecayCandidate()
    const ids = candidates.map(c => c.id)
    expect(ids).not.toContain(m.id)
  })
})

describe('saveMemory dedup', () => {
  let taskDb7: TaskDB
  let mem7: MemoryDB

  beforeEach(() => {
    try { unlinkSync(TEST_DB_AUTODREAM) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB_AUTODREAM + suffix) } catch {}
    }
    taskDb7 = new TaskDB(TEST_DB_AUTODREAM)
    mem7 = new MemoryDB(taskDb7)
  })

  test('duplicate content bumps support_count instead of creating new', () => {
    const m1 = mem7.saveMemory({ agent: 'boss', content: 'Same content here', category: 'fact' })
    const m2 = mem7.saveMemory({ agent: 'boss', content: 'same  content  here', category: 'fact' })
    expect(m2.id).toBe(m1.id)
    expect(m2.support_count).toBe(1)
  })

  test('different agent same content creates new memory', () => {
    const m1 = mem7.saveMemory({ agent: 'boss', content: 'Same content', category: 'fact' })
    const m2 = mem7.saveMemory({ agent: 'steve', content: 'Same content', category: 'fact' })
    expect(m2.id).not.toBe(m1.id)
  })
})
