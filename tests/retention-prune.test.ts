import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  TaskDB,
  RETENTION_PRUNE_CONFIG,
  computePruneEligibility,
  getRewardConsumptionHighWaterMark,
  intersectHwmEligibility,
  computeTernaryEligibleIds,
} from '../db'
import { unlinkSync } from 'fs'

// PK-T1-1 — first packet of the T1 generalized retention/prune lane
// (task #10376215). Covers ONLY the additive scaffold:
//   • ATM-011 (REQ-012 / M-002): the default-OFF `retention_prune_enabled` flag
//   • ATM-005 (REQ-005 / M-005): the `ternary_rewards_archive` table + index
// The prune config, eligibility, prune bodies, HWM guard, and Step-6 runHygiene
// wiring (ATM-001..004, 006..017) land in later packets and extend THIS file.

type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

function tableInfo(db: TaskDB, table: string): ColInfo[] {
  return db.run(d => d.prepare(`PRAGMA table_info('${table}')`).all() as ColInfo[])
}

function cleanup(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

describe('T1 retention/prune — PK-T1-1 scaffold', () => {
  let dbPath: string
  let db: TaskDB

  beforeEach(() => {
    dbPath = `/tmp/t1-prune-${crypto.randomUUID()}.db`
    db = new TaskDB(dbPath)
  })

  afterEach(() => {
    try { db.close() } catch {}
    cleanup(dbPath)
  })

  // ATM-011 (REQ-012 / M-002): flag registered default-OFF via INSERT OR IGNORE.
  test('flag registered default-OFF', () => {
    // A fresh migrate() seeds the flag present and disabled.
    const row = db.run(d =>
      d.prepare(`SELECT enabled FROM feature_flags WHERE flag_name = 'retention_prune_enabled'`).get() as
        { enabled: number } | null,
    )
    expect(row).not.toBeNull()
    expect(row!.enabled).toBe(0)
    expect(db.isFeatureEnabled('retention_prune_enabled')).toBe(false)

    // INSERT OR IGNORE semantics: a manually-enabled value must survive a
    // re-run of migrate() (a second TaskDB over the same file re-runs migrate()).
    db.run(d =>
      d.prepare(`UPDATE feature_flags SET enabled = 1 WHERE flag_name = 'retention_prune_enabled'`).run(),
    )
    db.close()
    db = new TaskDB(dbPath) // re-runs migrate() on the same file
    const after = db.run(d =>
      d.prepare(`SELECT enabled FROM feature_flags WHERE flag_name = 'retention_prune_enabled'`).get() as
        { enabled: number },
    )
    expect(after.enabled).toBe(1)
  })

  // ATM-005 (REQ-005 / M-005): ternary_rewards_archive mirrors ternary_rewards's
  // base columns plus archived_at, with its archived_at index; migrate() idempotent.
  test('migrate creates ternary_rewards_archive', () => {
    const base = tableInfo(db, 'ternary_rewards')
    const archive = tableInfo(db, 'ternary_rewards_archive')
    expect(base.length).toBeGreaterThan(0)
    expect(archive.length).toBeGreaterThan(0)

    // Archive column set = base columns + exactly one new column, `archived_at`.
    const baseNames = base.map(c => c.name)
    const archiveNames = archive.map(c => c.name)
    expect(archiveNames).toEqual([...baseNames, 'archived_at'])

    // Each shared column preserves name/type/notnull/pk (the memory_archive
    // precedent drops only generated defaults like created_at's datetime('now'),
    // so dflt_value is deliberately NOT asserted here).
    const archiveByName = new Map(archive.map(c => [c.name, c]))
    for (const b of base) {
      const a = archiveByName.get(b.name)!
      expect(a).toBeDefined()
      expect(a.type).toBe(b.type)
      expect(a.notnull).toBe(b.notnull)
      expect(a.pk).toBe(b.pk)
    }

    // archived_at is TEXT NOT NULL with a datetime('now') default.
    const archivedAt = archiveByName.get('archived_at')!
    expect(archivedAt.type).toBe('TEXT')
    expect(archivedAt.notnull).toBe(1)
    expect(archivedAt.dflt_value).toContain("datetime('now')")

    // The archived_at index is registered.
    const idx = db.run(d =>
      d.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ternary_rewards_archive_archived_at'`,
      ).get() as { name: string } | null,
    )
    expect(idx?.name).toBe('idx_ternary_rewards_archive_archived_at')

    // Re-running migrate() (a second TaskDB over the same file) is a no-op.
    db.close()
    db = new TaskDB(dbPath)
    const archive2 = tableInfo(db, 'ternary_rewards_archive')
    expect(archive2.map(c => c.name)).toEqual(archiveNames)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PK-T1-2 .. PK-T1-5 — the generalized prune helper, its HWM guard, and the
// runHygiene Step-6 wiring. Extends the SAME file per the PLAN packet breakdown.
// ─────────────────────────────────────────────────────────────────────────────

// Seed one failure_classifications row `ageDays` old; returns its id.
function seedFC(db: TaskDB, ageDays: number): number {
  return db.run(d => {
    const info = d.prepare(
      `INSERT INTO failure_classifications
         (taxonomy_version, failure_class, severity, transience, domain, signal_source, summary, created_at)
       VALUES (1, 'verification_failure', 'high', 'transient', 'agent', 'verify_check', 'fixture',
               datetime('now', '-' || ? || ' days'))`,
    ).run(ageDays)
    return Number(info.lastInsertRowid)
  })
}

// Seed one cross_family_critiques row `ageDays` old; returns its id.
function seedCFC(db: TaskDB, ageDays: number): number {
  return db.run(d => {
    const info = d.prepare(
      `INSERT INTO cross_family_critiques
         (taxonomy_version, decision_id, producer_agent, producer_family, critic_agent, critic_family,
          is_cross_family, verdict, created_at)
       VALUES (1, 1, 'steve', 'openai', 'boss', 'anthropic', 1, 'block',
               datetime('now', '-' || ? || ' days'))`,
    ).run(ageDays)
    return Number(info.lastInsertRowid)
  })
}

// Seed one ternary_rewards row `ageDays` old; returns its id. In a fresh db the
// AUTOINCREMENT ids come out 1,2,3,… in seed order (relied on by ATM-009).
function seedTR(db: TaskDB, ageDays: number, reward: -1 | 0 | 1 = 1): number {
  return db.run(d => {
    const info = d.prepare(
      `INSERT INTO ternary_rewards
         (policy_version, subject_kind, failure_signal_available, reward, created_at)
       VALUES (1, 'decision', 1, ?, datetime('now', '-' || ? || ' days'))`,
    ).run(reward, ageDays)
    return Number(info.lastInsertRowid)
  })
}

// T4-owned cursor table (repo-absent today) — tests that exercise a live/valid
// HWM create+seed it themselves. `reward_consumer_enabled` is T4's flag.
function createCursorTable(db: TaskDB): void {
  db.run(d =>
    d.exec(`
      CREATE TABLE IF NOT EXISTS reward_consumption_cursor (
        consumer TEXT PRIMARY KEY,
        last_consumed_reward_id INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        claimed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
  )
}
function setCursor(db: TaskDB, consumer: string, hwm: number): void {
  db.run(d =>
    d.prepare(
      `INSERT OR REPLACE INTO reward_consumption_cursor (consumer, last_consumed_reward_id) VALUES (?, ?)`,
    ).run(consumer, hwm),
  )
}
function rowCount(db: TaskDB, table: string): number {
  return db.run(d => (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}
function tableExists(db: TaskDB, table: string): boolean {
  return db.run(d =>
    !!(d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table)),
  )
}

// ── PK-T1-2 [EPIC-01]: config, eligibility, flag-OFF parity, dryRun ──
describe('T1 retention/prune — PK-T1-2 generalized helper', () => {
  let dbPath: string
  let db: TaskDB
  beforeEach(() => {
    dbPath = `/tmp/t1-prune-${crypto.randomUUID()}.db`
    db = new TaskDB(dbPath)
  })
  afterEach(() => {
    try { db.close() } catch {}
    cleanup(dbPath)
  })

  // ATM-001 (REQ-001 / M-001)
  test('RETENTION_PRUNE_CONFIG shape', () => {
    expect(RETENTION_PRUNE_CONFIG.length).toBe(3)
    expect(RETENTION_PRUNE_CONFIG.map(c => c.table)).toEqual([
      'failure_classifications',
      'cross_family_critiques',
      'ternary_rewards',
    ])
    for (const c of RETENTION_PRUNE_CONFIG) {
      expect(c.retention_days).toBe(90)
    }
    const archiveModes = new Map(RETENTION_PRUNE_CONFIG.map(c => [c.table, c.archive_mode]))
    expect(archiveModes.get('ternary_rewards')).toBe('archive')
    expect(archiveModes.get('failure_classifications')).toBe('delete')
    expect(archiveModes.get('cross_family_critiques')).toBe('delete')
  })

  // ATM-002 (REQ-002 / M-004)
  test('age-boundary eligibility', () => {
    // For each table: a 91-day-old row is eligible, an 89-day-old row is not.
    const young = { fc: seedFC(db, 89), cfc: seedCFC(db, 89), tr: seedTR(db, 89) }
    const old = { fc: seedFC(db, 91), cfc: seedCFC(db, 91), tr: seedTR(db, 91) }

    const fcElig = db.run(d => computePruneEligibility(d, 'failure_classifications', 90))
    const cfcElig = db.run(d => computePruneEligibility(d, 'cross_family_critiques', 90))
    const trElig = db.run(d => computePruneEligibility(d, 'ternary_rewards', 90))

    expect(fcElig).toContain(old.fc)
    expect(fcElig).not.toContain(young.fc)
    expect(cfcElig).toContain(old.cfc)
    expect(cfcElig).not.toContain(young.cfc)
    expect(trElig).toContain(old.tr)
    expect(trElig).not.toContain(young.tr)
  })

  // ATM-003 (REQ-003 / M-003): flag-OFF FUNCTIONAL parity via a prepare() spy.
  test('flag-OFF functional parity', () => {
    // Flag OFF (default). Seed eligible rows in all 3 tables.
    seedFC(db, 100); seedCFC(db, 100); seedTR(db, 100)
    const before = {
      fc: rowCount(db, 'failure_classifications'),
      cfc: rowCount(db, 'cross_family_critiques'),
      tr: rowCount(db, 'ternary_rewards'),
    }

    // Wrap the handle's prepare() in a recording spy (persists on the instance,
    // so runHygiene's internal this.run(this.db => …) uses the spied handle).
    const recorded: string[] = []
    db.run(d => {
      const orig = d.prepare.bind(d)
      ;(d as any).prepare = (sql: string, ...rest: any[]) => {
        recorded.push(sql)
        return (orig as any)(sql, ...rest)
      }
    })

    const result = db.runHygiene(false) // LIVE, flag OFF

    // Restore prepare so afterEach/close is clean.
    db.run(d => { delete (d as any).prepare })

    const TARGETS = [
      'failure_classifications',
      'cross_family_critiques',
      'ternary_rewards',
      'ternary_rewards_archive',
      'reward_consumption_cursor',
    ]
    const offending = recorded.filter(sql => TARGETS.some(t => sql.includes(t)))
    expect(offending).toEqual([]) // (1) zero target/cursor-table statements

    // (2) the 3 new keys are exactly 0
    expect(result.pruned_failure_classifications).toBe(0)
    expect(result.pruned_cross_family_critiques).toBe(0)
    expect(result.archived_ternary_rewards).toBe(0)

    // (3) row-counts of all 3 tables unchanged
    expect(rowCount(db, 'failure_classifications')).toBe(before.fc)
    expect(rowCount(db, 'cross_family_critiques')).toBe(before.cfc)
    expect(rowCount(db, 'ternary_rewards')).toBe(before.tr)
  })

  // ATM-004 (REQ-004 / M-012): dryRun computes real counts, mutates nothing.
  test('dryRun computes counts without mutation', () => {
    db.setFeatureFlag('retention_prune_enabled', true)
    db.setFeatureFlag('reward_consumer_enabled', true)
    createCursorTable(db)
    seedFC(db, 100); seedFC(db, 100)
    seedCFC(db, 100)
    const t1 = seedTR(db, 100); const t2 = seedTR(db, 100)
    setCursor(db, 'memory_importance', Math.max(t1, t2) + 5) // HWM above all reward ids

    const before = {
      fc: rowCount(db, 'failure_classifications'),
      cfc: rowCount(db, 'cross_family_critiques'),
      tr: rowCount(db, 'ternary_rewards'),
      arc: rowCount(db, 'ternary_rewards_archive'),
    }

    const result = db.runHygiene(true) // dryRun

    expect(result.pruned_failure_classifications).toBeGreaterThan(0)
    expect(result.pruned_cross_family_critiques).toBeGreaterThan(0)
    expect(result.archived_ternary_rewards).toBeGreaterThan(0)

    // Zero mutation.
    expect(rowCount(db, 'failure_classifications')).toBe(before.fc)
    expect(rowCount(db, 'cross_family_critiques')).toBe(before.cfc)
    expect(rowCount(db, 'ternary_rewards')).toBe(before.tr)
    expect(rowCount(db, 'ternary_rewards_archive')).toBe(before.arc)
  })
})

// ── PK-T1-3 [EPIC-02]: archive-then-delete vs plain-delete ──
describe('T1 retention/prune — PK-T1-3 archive vs delete', () => {
  let dbPath: string
  let db: TaskDB
  beforeEach(() => {
    dbPath = `/tmp/t1-prune-${crypto.randomUUID()}.db`
    db = new TaskDB(dbPath)
  })
  afterEach(() => {
    try { db.close() } catch {}
    cleanup(dbPath)
  })

  // ATM-006 (REQ-006 / M-005): archive-then-delete round-trip, explicit columns.
  test('archive-then-delete round-trip', () => {
    db.setFeatureFlag('retention_prune_enabled', true)
    db.setFeatureFlag('reward_consumer_enabled', true)
    createCursorTable(db)
    const ids = [seedTR(db, 100), seedTR(db, 100), seedTR(db, 100)]
    setCursor(db, 'memory_importance', Math.max(...ids)) // all 3 consumed

    // Snapshot originals for column-equality assertion.
    const originals = db.run(d =>
      d.prepare(`SELECT * FROM ternary_rewards ORDER BY id ASC`).all() as any[],
    )

    const result = db.runHygiene(false) // LIVE
    expect(result.archived_ternary_rewards).toBe(3)

    // 0 of the 3 remain in the source table; exactly 3 in the archive.
    expect(rowCount(db, 'ternary_rewards')).toBe(0)
    const archived = db.run(d =>
      d.prepare(`SELECT * FROM ternary_rewards_archive ORDER BY id ASC`).all() as any[],
    )
    expect(archived.length).toBe(3)
    // Every base column value copied verbatim.
    const baseCols = ['id', 'policy_version', 'decision_id', 'task_id', 'subject_kind',
      'cross_family_verdict', 'failure_severity', 'failure_signal_available', 'reward', 'created_at']
    for (let i = 0; i < 3; i++) {
      for (const col of baseCols) {
        expect(archived[i][col]).toEqual(originals[i][col])
      }
      expect(archived[i].archived_at).toBeTruthy() // default filled
    }
  })

  // ATM-007 (REQ-007 / M-006): plain DELETE, no archive tables created.
  test('plain delete, no archive tables', () => {
    db.setFeatureFlag('retention_prune_enabled', true)
    seedFC(db, 100); seedFC(db, 100)
    seedCFC(db, 100)

    const result = db.runHygiene(false) // LIVE
    expect(result.pruned_failure_classifications).toBe(2)
    expect(result.pruned_cross_family_critiques).toBe(1)

    expect(rowCount(db, 'failure_classifications')).toBe(0)
    expect(rowCount(db, 'cross_family_critiques')).toBe(0)
    expect(tableExists(db, 'failure_classifications_archive')).toBe(false)
    expect(tableExists(db, 'cross_family_critiques_archive')).toBe(false)
  })
})

// ── PK-T1-4 [EPIC-03]: never-prune-unconsumed-rewards guard (P1 safety) ──
describe('T1 retention/prune — PK-T1-4 HWM guard', () => {
  let dbPath: string
  let db: TaskDB
  beforeEach(() => {
    dbPath = `/tmp/t1-prune-${crypto.randomUUID()}.db`
    db = new TaskDB(dbPath)
  })
  afterEach(() => {
    try { db.close() } catch {}
    cleanup(dbPath)
  })

  // ATM-008 (REQ-008/REQ-009 / M-007, M-008): HWM read cases (a)-(e).
  test('HWM read cases', () => {
    // (a) reward_consumer_enabled OFF → null
    expect(db.run(d => getRewardConsumptionHighWaterMark(d))).toBeNull()

    // (b) ON, no cursor table (today's repo state) → null, no exception
    db.setFeatureFlag('reward_consumer_enabled', true)
    expect(db.run(d => getRewardConsumptionHighWaterMark(d))).toBeNull()

    // (c) ON, table present, zero rows → null
    createCursorTable(db)
    expect(db.run(d => getRewardConsumptionHighWaterMark(d))).toBeNull()

    // (d) ON, rows ('memory_importance',7) + ('reputation',3) → MIN = 3
    setCursor(db, 'memory_importance', 7)
    setCursor(db, 'reputation', 3)
    expect(db.run(d => getRewardConsumptionHighWaterMark(d))).toBe(3)

    // (e) ON, single row value 42 → 42
    const db2Path = `/tmp/t1-prune-${crypto.randomUUID()}.db`
    const db2 = new TaskDB(db2Path)
    try {
      db2.setFeatureFlag('reward_consumer_enabled', true)
      createCursorTable(db2)
      setCursor(db2, 'memory_importance', 42)
      expect(db2.run(d => getRewardConsumptionHighWaterMark(d))).toBe(42)
    } finally {
      db2.close(); cleanup(db2Path)
    }
  })

  // ATM-009 (REQ-009/REQ-010 / M-008, M-009): HWM ∩ age eligibility.
  test('HWM intersection eligibility', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(intersectHwmEligibility(ids, 5)).toEqual([1, 2, 3, 4, 5]) // intersection, not age-union
    expect(intersectHwmEligibility(ids, 0)).toEqual([]) // T4 seed value ⇒ nothing
    expect(intersectHwmEligibility(ids, null)).toEqual([]) // absent/invalid ⇒ nothing

    // End-to-end through computeTernaryEligibleIds: 10 age-eligible reward rows,
    // ids 1..10 (fresh-db AUTOINCREMENT), cursor drives the bound.
    db.setFeatureFlag('reward_consumer_enabled', true)
    createCursorTable(db)
    for (let i = 0; i < 10; i++) seedTR(db, 100)
    setCursor(db, 'memory_importance', 5)
    expect(db.run(d => computeTernaryEligibleIds(d, 90))).toEqual([1, 2, 3, 4, 5])
    setCursor(db, 'memory_importance', 0)
    expect(db.run(d => computeTernaryEligibleIds(d, 90))).toEqual([])
  })

  // ATM-010 (REQ-011 / M-008): null HWM never blocks the other two tables.
  test('null HWM does not block other tables', () => {
    db.setFeatureFlag('retention_prune_enabled', true)
    // reward_consumer_enabled OFF ⇒ HWM null ⇒ zero ternary pruned…
    seedFC(db, 100); seedCFC(db, 100)
    const tr = seedTR(db, 100)

    const result = db.runHygiene(false) // LIVE
    // …but the other two tables still prune their age-eligible rows.
    expect(result.pruned_failure_classifications).toBe(1)
    expect(result.pruned_cross_family_critiques).toBe(1)
    expect(result.archived_ternary_rewards).toBe(0)
    expect(rowCount(db, 'failure_classifications')).toBe(0)
    expect(rowCount(db, 'cross_family_critiques')).toBe(0)
    expect(rowCount(db, 'ternary_rewards')).toBe(1) // tr untouched
    expect(tr).toBeGreaterThan(0)
  })

  // ATM-017 (REQ-008/009/010 / M-008, M-009): concurrency + fault injection.
  test('HWM concurrency and fault injection', () => {
    // ── (a) interleaving / serialization ──────────────────────────────────
    // ALL sub-cases run with BOTH flags ON so outcomes are attributable to the
    // guard, never to a flag gate.
    db.setFeatureFlag('retention_prune_enabled', true)
    db.setFeatureFlag('reward_consumer_enabled', true)
    createCursorTable(db)
    const H = 5
    for (let i = 0; i < 10; i++) seedTR(db, 100) // ids 1..10, all age-eligible
    setCursor(db, 'memory_importance', H)

    // Serialization mechanism: a second connection holding BEGIN IMMEDIATE on
    // the same file blocks any other writer's BEGIN IMMEDIATE (RESERVED lock) —
    // this is what prevents a mid-prune cursor advance from interleaving INSIDE
    // the prune's transaction. Prove it with a short busy_timeout so the probe
    // fails fast instead of the 5s production default.
    db.run(d => d.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
    const connB = new Database(dbPath)
    connB.exec('BEGIN IMMEDIATE')
    connB.prepare('UPDATE reward_consumption_cursor SET last_consumed_reward_id = ?').run(H + 5)
    const connA = new Database(dbPath)
    connA.exec('PRAGMA busy_timeout=100')
    let serialized = false
    try {
      connA.exec('BEGIN IMMEDIATE') // must block behind connB's RESERVED lock
      connA.exec('ROLLBACK')
    } catch (e: any) {
      serialized = /busy|locked/i.test(String(e?.message ?? e))
    }
    connB.exec('ROLLBACK') // the advance was serialized away, never committed
    connA.close(); connB.close()
    expect(serialized).toBe(true)

    // The prune, run to completion, is bounded by the HWM read at txn start (H):
    // no ternary_rewards row with id > H is ever deleted, even though all 10 are
    // age-eligible and a concurrent writer tried to advance to H+5.
    const result = db.runHygiene(false)
    expect(result.archived_ternary_rewards).toBe(H) // exactly ids 1..5
    const remaining = db.run(d =>
      (d.prepare('SELECT id FROM ternary_rewards ORDER BY id ASC').all() as { id: number }[]).map(r => r.id),
    )
    expect(remaining).toEqual([6, 7, 8, 9, 10]) // nothing above H deleted
    const archivedIds = db.run(d =>
      (d.prepare('SELECT id FROM ternary_rewards_archive ORDER BY id ASC').all() as { id: number }[]).map(r => r.id),
    )
    expect(archivedIds.every(id => id <= H)).toBe(true)

    // ── (b) fault injection: garbage cursor states ⇒ zero ternary deletions ──
    const garbage: Array<{ label: string; apply: (d: Database) => void }> = [
      { label: 'value -5', apply: d => { d.exec('DELETE FROM reward_consumption_cursor'); d.prepare('INSERT INTO reward_consumption_cursor (consumer, last_consumed_reward_id) VALUES (?, ?)').run('c', -5) } },
      // Real T4 DDL is NOT NULL, so a literal NULL requires a malformed/legacy
      // cursor table — recreate it permissively to inject the NULL fault.
      { label: 'value NULL', apply: d => { d.exec('DROP TABLE reward_consumption_cursor'); d.exec('CREATE TABLE reward_consumption_cursor (consumer TEXT PRIMARY KEY, last_consumed_reward_id INTEGER)'); d.exec(`INSERT INTO reward_consumption_cursor (consumer, last_consumed_reward_id) VALUES ('c', NULL)`) } },
      { label: "value 'abc'", apply: d => { d.exec('DELETE FROM reward_consumption_cursor'); d.exec(`INSERT INTO reward_consumption_cursor (consumer, last_consumed_reward_id) VALUES ('c', 'abc')`) } },
      { label: 'table dropped', apply: d => { d.exec('DROP TABLE reward_consumption_cursor') } },
    ]
    for (const g of garbage) {
      const fPath = `/tmp/t1-prune-${crypto.randomUUID()}.db`
      const fdb = new TaskDB(fPath)
      try {
        fdb.setFeatureFlag('retention_prune_enabled', true)
        fdb.setFeatureFlag('reward_consumer_enabled', true)
        createCursorTable(fdb)
        for (let i = 0; i < 5; i++) seedTR(fdb, 100)
        fdb.run(d => g.apply(d))
        const r = fdb.runHygiene(false)
        expect(r.archived_ternary_rewards).toBe(0) // guard fires ⇒ zero
        expect(rowCount(fdb, 'ternary_rewards')).toBe(5) // all remain
        expect(rowCount(fdb, 'ternary_rewards_archive')).toBe(0)
      } finally {
        fdb.close(); cleanup(fPath)
      }
    }
  })
})

// ── PK-T1-5 [EPIC-04]: txn atomicity + return-shape wiring ──
describe('T1 retention/prune — PK-T1-5 txn + wiring', () => {
  let dbPath: string
  let db: TaskDB
  beforeEach(() => {
    dbPath = `/tmp/t1-prune-${crypto.randomUUID()}.db`
    db = new TaskDB(dbPath)
  })
  afterEach(() => {
    try { db.close() } catch {}
    cleanup(dbPath)
  })

  // ATM-012 (REQ-013 / M-010): a mid-sequence error rolls the WHOLE step back.
  test('mid-sequence error rolls back everything', () => {
    db.setFeatureFlag('retention_prune_enabled', true)
    db.setFeatureFlag('reward_consumer_enabled', true)
    createCursorTable(db)
    const trIds = [seedTR(db, 100), seedTR(db, 100), seedTR(db, 100)]
    setCursor(db, 'memory_importance', Math.max(...trIds)) // all eligible
    seedFC(db, 100); seedCFC(db, 100)

    // Pre-insert an archive row whose id collides with an eligible reward id →
    // the archive INSERT hits a PRIMARY KEY conflict mid-sequence.
    db.run(d =>
      d.prepare(
        `INSERT INTO ternary_rewards_archive
           (id, policy_version, decision_id, task_id, subject_kind, cross_family_verdict, failure_severity, failure_signal_available, reward, created_at)
         VALUES (?, 1, NULL, NULL, 'decision', NULL, NULL, 1, 1, datetime('now'))`,
      ).run(trIds[1]),
    )

    const before = {
      fc: rowCount(db, 'failure_classifications'),
      cfc: rowCount(db, 'cross_family_critiques'),
      tr: rowCount(db, 'ternary_rewards'),
      arc: rowCount(db, 'ternary_rewards_archive'),
    }

    expect(() => db.runHygiene(false)).toThrow() // ROLLBACK then re-throw

    // Everything unchanged: fc/cfc deletes and any archive INSERT rolled back.
    expect(rowCount(db, 'failure_classifications')).toBe(before.fc)
    expect(rowCount(db, 'cross_family_critiques')).toBe(before.cfc)
    expect(rowCount(db, 'ternary_rewards')).toBe(before.tr)
    expect(rowCount(db, 'ternary_rewards_archive')).toBe(before.arc)
  })

  // ATM-013 (REQ-014 / M-011): runHygiene return shape in both flag states.
  test('runHygiene return shape', () => {
    // Flag OFF → keys present, all 0.
    const off = db.runHygiene(true)
    expect(typeof off.pruned_failure_classifications).toBe('number')
    expect(typeof off.pruned_cross_family_critiques).toBe('number')
    expect(typeof off.archived_ternary_rewards).toBe('number')
    expect(off.pruned_failure_classifications).toBe(0)
    expect(off.pruned_cross_family_critiques).toBe(0)
    expect(off.archived_ternary_rewards).toBe(0)

    // Flag ON, dryRun → keys present, numeric, fc/cfc counts reflect eligibility.
    db.setFeatureFlag('retention_prune_enabled', true)
    seedFC(db, 100); seedCFC(db, 100)
    const on = db.runHygiene(true)
    expect(typeof on.pruned_failure_classifications).toBe('number')
    expect(typeof on.pruned_cross_family_critiques).toBe('number')
    expect(typeof on.archived_ternary_rewards).toBe('number')
    expect(on.pruned_failure_classifications).toBe(1)
    expect(on.pruned_cross_family_critiques).toBe(1)
  })
})
