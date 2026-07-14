import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskDB } from '../db'
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
