import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { MemoryConsolidator } from '../consolidator'
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
