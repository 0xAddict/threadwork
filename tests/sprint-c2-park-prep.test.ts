import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { TaskReconciler } from '../watchdog'
import { AuditLog } from '../audit'
import { unlinkSync } from 'fs'

// #13012 Sub-Sprint C2 — first-class PARKED state (Item 4) + kind=prep PRE-GO
// visibility rows (Item 5). DB-layer + watchdog-selection acceptance proofs.
//
// Idiom mirrors tests/sprint-c1-card-statemachine.test.ts and
// tests/addendum.test.ts (the watchdog due-task selector exclusion proof).
// nudgeAgent/postToGroup already no-op in test mode (NUDGE_DISABLED/POST_DISABLED).

const TEST_DB = '/tmp/sprint-c2-13012-test.db'

function freshDb(): TaskDB {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix) } catch {}
  }
  return new TaskDB(TEST_DB)
}

// Same fresh-DB note as C1: base CREATE TABLE keeps to_agent NOT NULL, so a
// self-owned ('sadie' from==to) row avoids trg_require_supervision on INSERT.
function makeTask(db: TaskDB, status?: string): number {
  const t = db.createTask({ from: 'sadie', to: 'sadie', description: 'work', priority: 'normal' })
  if (status) db.run(d => d.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id))
  return t.id
}

// The due-task selection query, copied verbatim from watchdog.ts reconcileDueTasks
// (the gate Item 4/5 hardened). Used to prove which rows the watchdog WOULD pick.
function dueSelector(db: TaskDB): any[] {
  return db.run(d => d.prepare(`
    SELECT * FROM tasks
    WHERE next_check_at <= datetime('now')
    AND status NOT IN ('completed', 'cancelled', 'parked')
    AND description NOT LIKE 'ESCALATION%'
    AND COALESCE(is_addendum, 0) = 0
    AND COALESCE(is_synthetic, 0) = 0
    AND COALESCE(kind, 'task') != 'subagent'
    AND COALESCE(kind, 'task') != 'prep'
    ORDER BY next_check_at ASC
  `).all() as any[])
}

describe('#13012 C2 / Item 4 — prior_status column', () => {
  let db: TaskDB
  beforeEach(() => { db = freshDb() })

  test('prior_status column exists, defaults NULL', () => {
    const id = makeTask(db)
    const t = db.getTask(id)!
    expect(t.prior_status).toBeNull()
  })
})

describe('#13012 C2 / Item 4 — park_task / unpark_task mechanics', () => {
  let db: TaskDB
  beforeEach(() => { db = freshDb() })

  test('park saves prior_status, sets status=parked, NULLs next_check_at', () => {
    const id = makeTask(db)
    db.claimTaskWithSession(id, 'sadie') // in_progress + armed next_check_at
    const before = db.getTask(id)!
    expect(before.status).toBe('in_progress')
    expect(before.next_check_at).not.toBeNull()

    const parked = db.parkTask(id)
    expect(parked).not.toBeNull()
    expect(parked!.status).toBe('parked')
    expect(parked!.prior_status).toBe('in_progress')
    expect(parked!.next_check_at).toBeNull()
  })

  test('unpark restores prior_status and re-arms next_check_at for in_progress', () => {
    const id = makeTask(db)
    db.claimTaskWithSession(id, 'sadie')
    db.parkTask(id)
    const unparked = db.unparkTask(id)
    expect(unparked).not.toBeNull()
    expect(unparked!.status).toBe('in_progress')
    // re-armed so a resumed task is not born already-overdue
    expect(unparked!.next_check_at).not.toBeNull()
  })

  test('unpark of a pending-parked row restores pending WITHOUT arming next_check_at', () => {
    const id = makeTask(db) // status pending, no next_check_at
    const parked = db.parkTask(id)
    expect(parked!.prior_status).toBe('pending')
    const unparked = db.unparkTask(id)
    expect(unparked!.status).toBe('pending')
    expect(unparked!.next_check_at).toBeNull()
  })

  test('cannot park a terminal task', () => {
    const id = makeTask(db, 'completed')
    expect(db.parkTask(id)).toBeNull()
  })

  test('cannot double-park (already parked)', () => {
    const id = makeTask(db)
    expect(db.parkTask(id)).not.toBeNull()
    expect(db.parkTask(id)).toBeNull()
  })

  test('cannot unpark a non-parked task', () => {
    const id = makeTask(db)
    db.claimTaskWithSession(id, 'sadie')
    expect(db.unparkTask(id)).toBeNull()
  })

  test('park does NOT touch supervisor_agent (trg_prevent_supervision_removal safe)', () => {
    // A delegated row carries a supervisor; parking must not null it.
    const t = db.delegateTask({ from: 'boss', to: 'sadie', description: 'd', priority: 'normal', supervisor_agent: 'boss' })
    db.claimTaskWithSession(t.id, 'sadie')
    const parked = db.parkTask(t.id)
    expect(parked).not.toBeNull()
    expect(parked!.supervisor_agent).toBe('boss')
    const unparked = db.unparkTask(t.id)
    expect(unparked!.supervisor_agent).toBe('boss')
  })
})

describe('#13012 C2 / Item 4 — watchdog SKIPS parked tasks', () => {
  let db: TaskDB
  beforeEach(() => { db = freshDb() })

  test('due-task selector EXCLUDES a parked row even with an overdue next_check_at', () => {
    const id = makeTask(db)
    db.claimTaskWithSession(id, 'sadie')
    db.parkTask(id)
    // Force a legacy/manual overdue next_check_at onto the parked row — proving
    // the status='parked' predicate (not just the NULLed next_check_at) excludes it.
    db.run(d => d.prepare("UPDATE tasks SET next_check_at = datetime('now','-100 seconds') WHERE id = ?").run(id))
    const due = dueSelector(db)
    expect(due.find(r => r.id === id)).toBeUndefined()
  })

  test('an unparked in_progress row IS selectable again when overdue', () => {
    const id = makeTask(db)
    db.claimTaskWithSession(id, 'sadie')
    db.parkTask(id)
    db.unparkTask(id)
    db.run(d => d.prepare("UPDATE tasks SET next_check_at = datetime('now','-100 seconds') WHERE id = ?").run(id))
    const due = dueSelector(db)
    expect(due.find(r => r.id === id)).toBeDefined()
  })

  test('reconcileDueTasks does NOT climb escalation_level on a parked overdue task', async () => {
    const audit = new AuditLog(db)
    const id = makeTask(db)
    db.claimTaskWithSession(id, 'sadie')
    db.parkTask(id)
    db.run(d => d.prepare("UPDATE tasks SET next_check_at = datetime('now','-100 seconds') WHERE id = ?").run(id))
    const before = db.getTask(id)!.escalation_level
    const reconciler = new TaskReconciler(db, audit)
    await reconciler.reconcileDueTasks()
    expect(db.getTask(id)!.escalation_level).toBe(before)
    // still parked, untouched
    expect(db.getTask(id)!.status).toBe('parked')
  })

  test('checkUnclaimedTasks never matches a parked row (status != pending)', () => {
    const id = makeTask(db) // pending
    db.parkTask(id)
    const matched = db.run(d => d.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
      AND next_check_at IS NULL
      AND description NOT LIKE 'ESCALATION%'
      AND COALESCE(is_synthetic, 0) = 0
      AND COALESCE(kind, 'task') != 'prep'
    `).all() as any[])
    expect(matched.find(r => r.id === id)).toBeUndefined()
  })
})

describe('#13012 C2 / Item 5 — kind=prep PRE-GO visibility rows', () => {
  let db: TaskDB
  beforeEach(() => { db = freshDb() })

  test('prep row attaches to a DRAFT (pre-GO) parent that spawn_subagent would reject', () => {
    const parentId = makeTask(db, 'draft')
    // A normal subagent row is refused on a draft parent...
    expect(() => db.createSubagentTask({
      description: 'normal', parent_task_id: parentId, supervisor_agent: 'sadie',
    })).toThrow()
    // ...but a prep row is accepted.
    const prep = db.createSubagentTask({
      description: 'pre-go research', parent_task_id: parentId, supervisor_agent: 'sadie', kind: 'prep',
    })
    expect(prep.kind).toBe('prep')
    expect(prep.is_synthetic).toBe(1)
    expect(prep.status).toBe('pending')
    expect(prep.next_check_at).toBeNull()
    expect(prep.description).toContain(`[prep to #${parentId}]`)
  })

  test('prep row also attaches to a pending/backlog/in_progress parent', () => {
    for (const st of ['pending', 'backlog', 'in_progress']) {
      const parentId = makeTask(db, st)
      const prep = db.createSubagentTask({
        description: 'x', parent_task_id: parentId, supervisor_agent: 'sadie', kind: 'prep',
      })
      expect(prep.kind).toBe('prep')
    }
  })

  test('prep row is rejected on a terminal parent', () => {
    const parentId = makeTask(db, 'completed')
    expect(() => db.createSubagentTask({
      description: 'x', parent_task_id: parentId, supervisor_agent: 'sadie', kind: 'prep',
    })).toThrow()
  })

  test('prep + addendum are mutually exclusive', () => {
    const parentId = makeTask(db, 'draft')
    expect(() => db.createSubagentTask({
      description: 'x', parent_task_id: parentId, supervisor_agent: 'sadie', kind: 'prep', is_addendum: true,
    })).toThrow()
  })

  test('prep row is VISIBLE via getChildTasks (read_status/get_children channel)', () => {
    const parentId = makeTask(db, 'draft')
    const prep = db.createSubagentTask({
      description: 'visible prep', parent_task_id: parentId, supervisor_agent: 'sadie', kind: 'prep',
    })
    const children = db.getChildTasks(parentId)
    const found = children.find(c => c.id === prep.id)
    expect(found).toBeDefined()
    expect(found!.kind).toBe('prep')
    // get_children labeling logic (server.ts) tags it [prep]
    const kindTag = found!.is_addendum ? '[addendum]' : (found!.kind === 'prep' ? '[prep]' : (found!.is_synthetic ? '[subagent]' : '[task]'))
    expect(kindTag).toBe('[prep]')
  })

  test('prep row is EXCLUDED from the watchdog due-task selector', () => {
    const parentId = makeTask(db, 'draft')
    const prep = db.createSubagentTask({
      description: 'x', parent_task_id: parentId, supervisor_agent: 'sadie', kind: 'prep',
    })
    // Force an overdue next_check_at onto the prep row — proving the kind='prep' /
    // is_synthetic predicates exclude it regardless.
    db.run(d => d.prepare("UPDATE tasks SET next_check_at = datetime('now','-100 seconds') WHERE id = ?").run(prep.id))
    const due = dueSelector(db)
    expect(due.find(r => r.id === prep.id)).toBeUndefined()
  })

  test('prep row is EXCLUDED from the unclaimed sweep (synthetic + kind=prep)', () => {
    const parentId = makeTask(db, 'draft')
    const prep = db.createSubagentTask({
      description: 'x', parent_task_id: parentId, supervisor_agent: 'sadie', kind: 'prep',
    })
    const matched = db.run(d => d.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
      AND next_check_at IS NULL
      AND description NOT LIKE 'ESCALATION%'
      AND COALESCE(is_synthetic, 0) = 0
      AND COALESCE(kind, 'task') != 'prep'
    `).all() as any[])
    expect(matched.find(r => r.id === prep.id)).toBeUndefined()
  })

  test('a normal subagent row is UNAFFECTED (kind=subagent, in_progress, armed)', () => {
    const parentId = makeTask(db, 'in_progress')
    const sub = db.createSubagentTask({
      description: 'normal', parent_task_id: parentId, supervisor_agent: 'sadie',
    })
    expect(sub.kind).toBe('subagent')
    expect(sub.status).toBe('in_progress')
    expect(sub.next_check_at).not.toBeNull()
  })
})
