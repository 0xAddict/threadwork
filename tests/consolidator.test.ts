import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import type { Classification } from '../memory'
import { MemoryConsolidator, buildScopeClause, lockKeyForScope } from '../consolidator'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/test-autodream-consolidator.db'

describe('MemoryConsolidator', () => {
  let taskDb: TaskDB
  let mem: MemoryDB
  let consolidator: MemoryConsolidator

  beforeEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    mem = new MemoryDB(taskDb)
    consolidator = new MemoryConsolidator(mem, taskDb, true, 50)
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(TEST_DB) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
  })

  test('acquireLock succeeds when no lock exists', () => {
    expect(consolidator.acquireLock()).toBe(true)
    consolidator.releaseLock()
  })

  test('acquireLock fails when lock already held', () => {
    expect(consolidator.acquireLock()).toBe(true)
    expect(consolidator.acquireLock()).toBe(false)
    consolidator.releaseLock()
  })

  test('releaseLock frees the lock', () => {
    consolidator.acquireLock()
    consolidator.releaseLock()
    expect(consolidator.acquireLock()).toBe(true)
    consolidator.releaseLock()
  })

  test('getHealthReport returns valid stats', () => {
    mem.saveMemory({ agent: 'boss', content: 'fact 1', category: 'fact' })
    mem.saveMemory({ agent: 'boss', content: 'fact 2', category: 'preference' })
    const report = consolidator.getHealthReport()
    expect(report.totalActive).toBe(2)
    expect(report.byClassification.operational).toBe(1)
    expect(report.byClassification.strategic).toBe(1)
    expect(report.avgQuality).toBeCloseTo(0.5, 1)
    expect(report.disputeRate).toBe(0)
  })

  test('run completes a dry-run cycle', async () => {
    mem.saveMemory({ agent: 'boss', content: 'a fact to consolidate', category: 'fact' })
    const result = await consolidator.run('test')
    expect(result.dryRun).toBe(true)
    expect(result.phasesCompleted).toContain('orient')
    expect(result.phasesCompleted).toContain('gather')
    expect(result.phasesCompleted).toContain('validate')
    expect(result.phasesCompleted).toContain('consolidate')
    expect(result.phasesCompleted).toContain('prune')
    expect(result.runId).toBeGreaterThan(0)
  })

  test('checkTriggers returns time trigger after 6h', () => {
    // Insert a consolidation_run 7 hours ago
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO consolidation_runs (trigger_reason, started_at, completed_at, dry_run, mutations)
        VALUES ('test', datetime('now', '-7 hours'), datetime('now', '-7 hours'), 1, 0)
      `).run()
    })
    const triggers = consolidator.checkTriggers()
    expect(triggers.time).toBe(true)
  })

  test('checkTriggers returns false for time when run is recent', () => {
    taskDb.run(db => {
      db.prepare(`
        INSERT INTO consolidation_runs (trigger_reason, started_at, completed_at, dry_run, mutations)
        VALUES ('test', datetime('now', '-1 hours'), datetime('now', '-1 hours'), 1, 0)
      `).run()
    })
    const triggers = consolidator.checkTriggers()
    expect(triggers.time).toBe(false)
  })
})

describe('buildScopeClause', () => {
  test('all returns empty clause', () => {
    const c = buildScopeClause('all')
    expect(c.sql).toBe('')
    expect(c.params).toEqual([])
  })

  test('undefined returns empty clause', () => {
    const c = buildScopeClause(undefined)
    expect(c.sql).toBe('')
    expect(c.params).toEqual([])
  })

  test('operational restricts by classification', () => {
    const c = buildScopeClause('operational')
    expect(c.sql).toBe(' AND classification = ?')
    expect(c.params).toEqual(['operational'])
  })

  test('agent:steve restricts by agent column', () => {
    const c = buildScopeClause('agent:steve')
    expect(c.sql).toBe(' AND agent = ?')
    expect(c.params).toEqual(['steve'])
  })

  test('agent:NAME with alias prefixes the column', () => {
    const c = buildScopeClause('agent:sadie', 'm1')
    expect(c.sql).toBe(' AND m1.agent = ?')
    expect(c.params).toEqual(['sadie'])
  })

  test('agent: with empty name falls back to empty clause', () => {
    const c = buildScopeClause('agent:')
    expect(c.sql).toBe('')
    expect(c.params).toEqual([])
  })

  test('unknown scope string falls back to empty clause', () => {
    const c = buildScopeClause('garbage')
    expect(c.sql).toBe('')
    expect(c.params).toEqual([])
  })
})

describe('lockKeyForScope', () => {
  test('all uses global consolidator key', () => {
    expect(lockKeyForScope('all')).toBe('consolidator')
  })
  test('operational uses global consolidator key', () => {
    expect(lockKeyForScope('operational')).toBe('consolidator')
  })
  test('agent:NAME produces a scoped lock key', () => {
    expect(lockKeyForScope('agent:steve')).toBe('memory_consolidation:agent:steve')
    expect(lockKeyForScope('agent:sadie')).toBe('memory_consolidation:agent:sadie')
  })
  test('agent: with empty name falls back to global key', () => {
    expect(lockKeyForScope('agent:')).toBe('consolidator')
  })
})

describe('MemoryConsolidator scope filtering', () => {
  const SCOPE_DB = '/tmp/test-autodream-consolidator-scope.db'
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    try { unlinkSync(SCOPE_DB) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(SCOPE_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(SCOPE_DB)
    mem = new MemoryDB(taskDb)

    // Seed: 2 memories per agent for steve, sadie, kiera.
    for (const agent of ['steve', 'sadie', 'kiera']) {
      mem.saveMemory({ agent, content: `${agent} fact one`, category: 'fact' })
      mem.saveMemory({ agent, content: `${agent} fact two`, category: 'fact' })
    }
  })

  afterEach(() => {
    taskDb.close()
    try { unlinkSync(SCOPE_DB) } catch {}
    for (const suffix of ['-shm', '-wal']) {
      try { unlinkSync(SCOPE_DB + suffix) } catch {}
    }
  })

  test('scope=all sees all 6 memories in health report', () => {
    const c = new MemoryConsolidator(mem, taskDb, true, 50, 'all')
    const h = c.getHealthReport()
    expect(h.totalActive).toBe(6)
  })

  test('scope=agent:steve only sees steve memories in health report', () => {
    const c = new MemoryConsolidator(mem, taskDb, true, 50, 'agent:steve')
    const h = c.getHealthReport()
    expect(h.totalActive).toBe(2)
  })

  test('scope=agent:sadie only sees sadie memories in health report', () => {
    const c = new MemoryConsolidator(mem, taskDb, true, 50, 'agent:sadie')
    const h = c.getHealthReport()
    expect(h.totalActive).toBe(2)
  })

  test('scope=operational only sees operational classification', () => {
    // All default fact memories are classified operational by saveMemory.
    const c = new MemoryConsolidator(mem, taskDb, true, 50, 'operational')
    const h = c.getHealthReport()
    // Every seeded memory has classification=operational.
    expect(h.totalActive).toBe(6)
    expect(h.byClassification.operational).toBe(6)
  })

  test('dry-run consolidation with scope=agent:steve only touches steve', async () => {
    // saveMemory() dedupes by (agent, LOWER(TRIM(content))), so we can't
    // create duplicates via the public API. Insert raw rows directly to build
    // true duplicates for both steve and sadie. The scoped run should only
    // log dry-run mutations against steve's rows.
    taskDb.run(db => {
      const ins = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, classification, quality, state, source_type)
        VALUES (?, ?, 'fact', 3, 0, 'operational', 0.5, 'active', 'agent')
      `)
      ins.run('steve', 'shared steve content')
      ins.run('steve', 'shared steve content')
      ins.run('sadie', 'shared sadie content')
      ins.run('sadie', 'shared sadie content')
    })

    const c = new MemoryConsolidator(mem, taskDb, true, 50, 'agent:steve')
    const result = await c.run('test-scoped')
    expect(result.scope).toBe('agent:steve')
    expect(result.dryRun).toBe(true)
    expect(result.phasesCompleted).toContain('consolidate')

    // Check audit_log for any dry-run mutations outside of steve's memory IDs.
    const steveIds = taskDb.run(db =>
      (db.prepare(`SELECT id FROM memories WHERE agent = 'steve'`).all() as { id: number }[]).map(r => r.id)
    )
    const steveIdSet = new Set(steveIds)

    const dryRunLogs = taskDb.run(db =>
      db.prepare(
        `SELECT memory_id, detail FROM audit_log WHERE action = 'consolidation_dry_run'`
      ).all() as { memory_id: number, detail: string }[]
    )

    for (const row of dryRunLogs) {
      expect(steveIdSet.has(row.memory_id)).toBe(true)
    }
    // We added an exact-duplicate pair for steve; expect at least one dry-run
    // mutation suggestion for a steve memory.
    expect(dryRunLogs.length).toBeGreaterThan(0)
  })

  test('dry-run consolidation with scope=agent:sadie does not touch steve or kiera', async () => {
    // Bypass saveMemory's dedup to create actual duplicate rows.
    taskDb.run(db => {
      const ins = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, classification, quality, state, source_type)
        VALUES (?, ?, 'fact', 3, 0, 'operational', 0.5, 'active', 'agent')
      `)
      ins.run('sadie', 'sadie dup content')
      ins.run('sadie', 'sadie dup content')
      ins.run('steve', 'steve dup content')
      ins.run('steve', 'steve dup content')
    })

    const c = new MemoryConsolidator(mem, taskDb, true, 50, 'agent:sadie')
    await c.run('test-scoped-sadie')

    const sadieIds = taskDb.run(db =>
      (db.prepare(`SELECT id FROM memories WHERE agent = 'sadie'`).all() as { id: number }[]).map(r => r.id)
    )
    const sadieIdSet = new Set(sadieIds)

    const dryRunLogs = taskDb.run(db =>
      db.prepare(
        `SELECT memory_id FROM audit_log WHERE action = 'consolidation_dry_run'`
      ).all() as { memory_id: number }[]
    )

    for (const row of dryRunLogs) {
      expect(sadieIdSet.has(row.memory_id)).toBe(true)
    }
  })

  test('per-agent scopes do not block each other on the lock', () => {
    const steveC = new MemoryConsolidator(mem, taskDb, true, 50, 'agent:steve')
    const sadieC = new MemoryConsolidator(mem, taskDb, true, 50, 'agent:sadie')
    expect(steveC.acquireLock()).toBe(true)
    // sadie's per-agent lock uses a different key, so it should also acquire.
    expect(sadieC.acquireLock()).toBe(true)
    // A second steve consolidator should still be blocked by the first one.
    const steveC2 = new MemoryConsolidator(mem, taskDb, true, 50, 'agent:steve')
    expect(steveC2.acquireLock()).toBe(false)
    steveC.releaseLock()
    sadieC.releaseLock()
  })

  test('global scope lock still blocks a second global run', () => {
    const allC = new MemoryConsolidator(mem, taskDb, true, 50, 'all')
    const opC = new MemoryConsolidator(mem, taskDb, true, 50, 'operational')
    expect(allC.acquireLock()).toBe(true)
    // operational shares the global 'consolidator' lock key, so it should be blocked.
    expect(opC.acquireLock()).toBe(false)
    allC.releaseLock()
    expect(opC.acquireLock()).toBe(true)
    opC.releaseLock()
  })
})

// P4 Stage 5a (#10376048/ATM-014, ATM-033) — consolidation trust-tier ceiling:
// merge NEVER writes the survivor's classification, and the live
// guardClassificationElevation callsite in the merge block is reachable but
// never blocks (equal-tier self-check only).
describe('MemoryConsolidator merge — trust-tier ceiling (ATM-014 / ATM-033 live callsite)', () => {
  const TIER_DB = '/tmp/test-autodream-consolidator-tier.db'
  let taskDb: TaskDB
  let mem: MemoryDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TIER_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TIER_DB)
    mem = new MemoryDB(taskDb)
  })

  afterEach(() => {
    taskDb.close()
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TIER_DB + suffix) } catch {}
    }
  })

  // Bypasses saveMemory's dedup (raw INSERT) to create a true duplicate pair
  // with independently-controlled classification/quality on each row, in a
  // specific insertion order. Order matters: validate()'s duplicate handler
  // only gates the whole signal on m1 (the lower-id row of the pair)'s
  // classification being foundational/strategic — it does NOT check m2. So
  // whichever row we want to end up as m1 must not be foundational/strategic,
  // or the merge action never gets created at all.
  function seedPair(
    content: string,
    firstInsert: { classification: Classification; quality: number },
    secondInsert: { classification: Classification; quality: number },
  ): { id1: number; id2: number } {
    return taskDb.run(db => {
      const ins = db.prepare(`
        INSERT INTO memories (agent, content, category, importance, pinned, classification, quality, state, source_type)
        VALUES ('tieragent', ?, 'fact', 3, 0, ?, ?, 'active', 'agent')
      `)
      const r1 = ins.run(content, firstInsert.classification, firstInsert.quality) as unknown as { lastInsertRowid: number }
      const r2 = ins.run(content, secondInsert.classification, secondInsert.quality) as unknown as { lastInsertRowid: number }
      return { id1: Number(r1.lastInsertRowid), id2: Number(r2.lastInsertRowid) }
    })
  }

  function classificationOf(id: number): Classification {
    return taskDb.run(db =>
      (db.prepare('SELECT classification FROM memories WHERE id = ?').get(id) as { classification: Classification }).classification
    )
  }

  function elevationBlockedCount(): number {
    return taskDb.run(db =>
      (db.prepare(`SELECT COUNT(*) as cnt FROM audit_log WHERE action = 'consolidation_survivor_elevation_blocked'`).get() as { cnt: number }).cnt
    )
  }

  // [survivorTier, victimTier, firstInsertIsSurvivor]. firstInsertIsSurvivor
  // picks the insertion order so m1 is never foundational/strategic (see
  // seedPair doc comment). Includes victim tier > survivor tier (the
  // interesting elevation-risk direction) and one control where victim tier <
  // survivor tier.
  const MATRIX: Array<{ survivor: Classification; victim: Classification; firstInsertIsSurvivor: boolean }> = [
    { survivor: 'observational', victim: 'operational', firstInsertIsSurvivor: false }, // required: victim tier > survivor tier
    { survivor: 'ephemeral', victim: 'foundational', firstInsertIsSurvivor: true },      // victim tier >> survivor tier
    { survivor: 'operational', victim: 'strategic', firstInsertIsSurvivor: true },       // victim tier > survivor tier
    { survivor: 'ephemeral', victim: 'observational', firstInsertIsSurvivor: false },     // victim tier > survivor tier
    { survivor: 'foundational', victim: 'ephemeral', firstInsertIsSurvivor: false },      // control: victim tier < survivor tier
  ]

  test('ATM-014: across a matrix of victim/survivor tier pairs (flag ON, live merge), survivor classification is unchanged post-merge — no elevation, no write', async () => {
    taskDb.setFeatureFlag('memory_sanitization_enabled', true)
    const consolidator = new MemoryConsolidator(mem, taskDb, false, 50)

    let idx = 0
    for (const { survivor, victim, firstInsertIsSurvivor } of MATRIX) {
      idx++
      const content = `tier-matrix duplicate content #${idx}`
      const survivorSpec = { classification: survivor, quality: 0.9 }
      const victimSpec = { classification: victim, quality: 0.1 }
      const { id1, id2 } = firstInsertIsSurvivor
        ? seedPair(content, survivorSpec, victimSpec)
        : seedPair(content, victimSpec, survivorSpec)
      const survivorId = firstInsertIsSurvivor ? id1 : id2
      const victimId = firstInsertIsSurvivor ? id2 : id1

      const before = classificationOf(survivorId)
      expect(before).toBe(survivor)

      const result = await consolidator.run(`tier-matrix-${idx}`)
      expect(result.dryRun).toBe(false)
      expect(result.mutations).toBeGreaterThanOrEqual(1)

      const after = classificationOf(survivorId)
      expect(after).toBe(survivor)
      expect(after).toBe(before)

      // Victim was actually merged away (sanity: the merge path ran).
      const victimState = taskDb.run(db =>
        (db.prepare('SELECT state FROM memories WHERE id = ?').get(victimId) as { state: string }).state
      )
      expect(victimState).toBe('superseded')
    }

    // Across the whole matrix, the live guardClassificationElevation callsite
    // is a self-check (survivor's own tier vs itself) and must never block.
    expect(elevationBlockedCount()).toBe(0)
  })

  test('ATM-033 live callsite: after a real merge (equal-tiers self-check), consolidation_survivor_elevation_blocked audit rows = 0', async () => {
    taskDb.setFeatureFlag('memory_sanitization_enabled', true)
    const consolidator = new MemoryConsolidator(mem, taskDb, false, 50)

    seedPair(
      'equal-tier duplicate content',
      { classification: 'operational', quality: 0.9 },
      { classification: 'operational', quality: 0.1 },
    )

    const result = await consolidator.run('equal-tier-merge')
    expect(result.dryRun).toBe(false)
    expect(result.mutations).toBeGreaterThanOrEqual(1)

    expect(elevationBlockedCount()).toBe(0)
  })

  test('flag-OFF byte-parity: the same merge (victim tier > survivor tier) executes identically and never invokes the guard', async () => {
    // Flag left at its default (OFF, seeded by TaskDB).
    const consolidator = new MemoryConsolidator(mem, taskDb, false, 50)

    const { id1: victimId, id2: survivorId } = seedPair(
      'flag-off duplicate content',
      { classification: 'operational', quality: 0.1 },
      { classification: 'observational', quality: 0.9 },
    )

    const result = await consolidator.run('flag-off-merge')
    expect(result.dryRun).toBe(false)
    expect(result.mutations).toBeGreaterThanOrEqual(1)

    // Merge still happens (flag gates the guard call, not the merge itself).
    expect(classificationOf(survivorId)).toBe('observational')
    const victimState = taskDb.run(db =>
      (db.prepare('SELECT state FROM memories WHERE id = ?').get(victimId) as { state: string }).state
    )
    expect(victimState).toBe('superseded')

    // No guard call was ever made -> zero elevation-blocked rows, same as pre-P4.
    expect(elevationBlockedCount()).toBe(0)
  })
})
