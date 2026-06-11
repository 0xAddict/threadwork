import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'
import { TaskReconciler } from '../watchdog'
import { unlinkSync } from 'fs'

// nudgeAgent and postToGroup already no-op in test mode
// (NUDGE_DISABLED / POST_DISABLED guards in nudge.ts and notify.ts)

const TEST_DB = '/tmp/addendum-1624-test.db'

function freshDb(): TaskDB {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix) } catch {}
  }
  return new TaskDB(TEST_DB)
}

// Helper: create a parent task in a given terminal/active status.
function makeParent(taskDb: TaskDB, status: 'in_progress' | 'completed' | 'cancelled'): number {
  const parent = taskDb.createTask({ from: 'boss', to: 'boss', description: 'Parent card', priority: 'normal' })
  taskDb.claimTask(parent.id, 'boss') // -> in_progress
  if (status === 'completed') {
    taskDb.completeTask(parent.id, 'accepted', 'boss')
  } else if (status === 'cancelled') {
    taskDb.run(db => db.prepare("UPDATE tasks SET status='cancelled', completed_at=datetime('now') WHERE id=?").run(parent.id))
  }
  return parent.id
}

describe('#1624: post-acceptance addendum tracking', () => {
  let taskDb: TaskDB

  beforeEach(() => { taskDb = freshDb() })

  // 1. Migration applied the column.
  test('is_addendum column exists with default 0', () => {
    const parentId = makeParent(taskDb, 'in_progress')
    const child = taskDb.createSubagentTask({
      description: 'normal sub', parent_task_id: parentId, supervisor_agent: 'boss',
    })
    expect(child.is_addendum).toBe(0)
  })

  // 2. Refusal-without-flag preserved (completed parent, addendum:false default).
  test('completed parent WITHOUT addendum flag is still refused', () => {
    const parentId = makeParent(taskDb, 'completed')
    expect(() => taskDb.createSubagentTask({
      description: 'late fix', parent_task_id: parentId, supervisor_agent: 'boss',
    })).toThrow(/not in_progress/)
  })

  // 2b. in_progress parent unchanged: addendum:false still works.
  test('in_progress parent WITHOUT addendum flag still creates a normal subagent', () => {
    const parentId = makeParent(taskDb, 'in_progress')
    const child = taskDb.createSubagentTask({
      description: 'normal sub', parent_task_id: parentId, supervisor_agent: 'boss',
    })
    expect(child.is_synthetic).toBe(1)
    expect(child.is_addendum).toBe(0)
    expect(child.next_check_at).not.toBeNull() // armed for watchdog
  })

  // 3. Accept-with-flag creates an is_addendum child under a completed parent.
  test('completed parent WITH addendum:true creates is_addendum child, labeled, watchdog-disarmed', () => {
    const parentId = makeParent(taskDb, 'completed')
    const child = taskDb.createSubagentTask({
      description: 'shipped a fix after acceptance', parent_task_id: parentId,
      supervisor_agent: 'boss', is_addendum: true,
    })
    expect(child.is_addendum).toBe(1)
    expect(child.is_synthetic).toBe(1)
    expect(child.kind).toBe('subagent')
    expect(child.status).toBe('in_progress')
    expect(child.description).toBe(`[addendum to #${parentId}] shipped a fix after acceptance`)
    expect(child.next_check_at).toBeNull() // watchdog never picks it up
  })

  // 3b. cancelled parent also accepts an addendum.
  test('cancelled parent WITH addendum:true is accepted', () => {
    const parentId = makeParent(taskDb, 'cancelled')
    const child = taskDb.createSubagentTask({
      description: 'fix on a cancelled card', parent_task_id: parentId,
      supervisor_agent: 'boss', is_addendum: true,
    })
    expect(child.is_addendum).toBe(1)
  })

  // 3c. addendum:true on an in_progress parent is rejected (use a normal subagent).
  test('addendum:true on an in_progress parent is rejected', () => {
    const parentId = makeParent(taskDb, 'in_progress')
    expect(() => taskDb.createSubagentTask({
      description: 'premature addendum', parent_task_id: parentId,
      supervisor_agent: 'boss', is_addendum: true,
    })).toThrow(/not completed\/cancelled/)
  })

  // 4. complete_task open-children check ignores open addenda.
  test('open addendum does NOT block completing a (re-opened) parent', () => {
    // Parent in_progress, with an OPEN normal subagent AND an OPEN addendum.
    // (We force is_addendum onto an in_progress parent's child directly to model
    // a re-opened parent that still carries an addendum row.)
    const parent = taskDb.createTask({ from: 'boss', to: 'boss', description: 'reopened card', priority: 'normal' })
    taskDb.claimTask(parent.id, 'boss')
    // open addendum row attached to this parent
    const addendum = taskDb.createSubagentTask({
      description: 'addendum work', parent_task_id: parent.id, supervisor_agent: 'boss',
    })
    taskDb.run(db => db.prepare('UPDATE tasks SET is_addendum = 1 WHERE id = ?').run(addendum.id))
    // completing the parent must succeed — the open addendum is excluded from the gate
    const res = taskDb.completeTaskWithFinalizerCheck(parent.id, 'done', 'boss')
    expect(res.error).toBeUndefined()
    expect(res.task?.status).toBe('completed')
  })

  test('open NON-addendum child still blocks completion (gate intact for normal subagents)', () => {
    const parent = taskDb.createTask({ from: 'boss', to: 'boss', description: 'card', priority: 'normal' })
    taskDb.claimTask(parent.id, 'boss')
    const child = taskDb.createSubagentTask({
      description: 'normal open sub', parent_task_id: parent.id, supervisor_agent: 'boss',
    })
    // synthetic children are auto-closed by the gate; force a NON-synthetic open child to prove the block
    taskDb.run(db => db.prepare('UPDATE tasks SET is_synthetic = 0 WHERE id = ?').run(child.id))
    const res = taskDb.completeTaskWithFinalizerCheck(parent.id, 'done', 'boss')
    expect(res.error).toBeDefined()
    expect(res.error).toContain(`#${child.id}`)
  })

  // 5. get_children labels addenda (SQL/shape level — server formats with [addendum]).
  test('getChildTasks returns the addendum row with is_addendum=1 for labeling', () => {
    const parentId = makeParent(taskDb, 'completed')
    const child = taskDb.createSubagentTask({
      description: 'labeled fix', parent_task_id: parentId, supervisor_agent: 'boss', is_addendum: true,
    })
    const kids = taskDb.getChildTasks(parentId, true)
    const found = kids.find(k => k.id === child.id)
    expect(found).toBeDefined()
    expect(found!.is_addendum).toBe(1)
    // mirror the server.ts get_children labeling logic
    const kindTag = found!.is_addendum ? '[addendum]' : (found!.is_synthetic ? '[subagent]' : '[task]')
    expect(kindTag).toBe('[addendum]')
  })

  // 6. close_subagent works unchanged on an addendum row.
  test('closeSubagentTask completes an addendum row', () => {
    const parentId = makeParent(taskDb, 'completed')
    const child = taskDb.createSubagentTask({
      description: 'fix', parent_task_id: parentId, supervisor_agent: 'boss', is_addendum: true,
    })
    const closed = taskDb.closeSubagentTask(child.id, 'fix verified and shipped')
    expect(closed).not.toBeNull()
    expect(closed!.status).toBe('completed')
    expect(closed!.result).toBe('fix verified and shipped')
    expect(closed!.is_addendum).toBe(1)
  })

  // 7. Watchdog SQL predicate excludes addenda (unit-test the selector directly).
  test('watchdog due-task selector excludes is_addendum=1 rows', () => {
    const parentId = makeParent(taskDb, 'completed')
    const addendum = taskDb.createSubagentTask({
      description: 'fix', parent_task_id: parentId, supervisor_agent: 'boss', is_addendum: true,
    })
    // Force a legacy/manual overdue next_check_at onto the addendum row — proving
    // the selector predicate (not just the NULL-on-insert) excludes it.
    taskDb.run(db => db.prepare("UPDATE tasks SET next_check_at = datetime('now','-100 seconds') WHERE id = ?").run(addendum.id))

    const due = taskDb.run(db => db.prepare(`
      SELECT id FROM tasks
      WHERE next_check_at <= datetime('now')
      AND status NOT IN ('completed', 'cancelled')
      AND description NOT LIKE 'ESCALATION%'
      AND COALESCE(is_addendum, 0) = 0
      ORDER BY next_check_at ASC
    `).all() as { id: number }[])
    expect(due.find(d => d.id === addendum.id)).toBeUndefined()
  })

  // 7b. End-to-end: reconciler does NOT escalate an overdue addendum row.
  test('reconcileDueTasks does NOT climb escalation_level on an overdue addendum', async () => {
    const audit = new AuditLog(taskDb)
    const reconciler = new TaskReconciler(taskDb, audit)
    taskDb.upsertAgentSession('boss', 'session-boss', 'alive')

    const parentId = makeParent(taskDb, 'completed')
    const addendum = taskDb.createSubagentTask({
      description: 'fix', parent_task_id: parentId, supervisor_agent: 'boss', is_addendum: true,
    })
    // Make it look overdue (legacy arming)
    taskDb.run(db => db.prepare(`
      UPDATE tasks SET last_heartbeat_at = datetime('now','-600 seconds'),
        next_check_at = datetime('now','-10 seconds') WHERE id = ?
    `).run(addendum.id))

    const before = taskDb.getTask(addendum.id)!
    expect(before.escalation_level).toBe(0)

    await reconciler.reconcileDueTasks()

    const after = taskDb.getTask(addendum.id)!
    // Excluded from the sweep -> escalation_level untouched, row still in_progress.
    expect(after.escalation_level).toBe(0)
    expect(after.status).toBe('in_progress')
  })

  // 7c. Control: a NON-addendum overdue subagent IS swept (escalation_level climbs),
  // proving the exclusion is specific to addenda and the sweep otherwise works.
  test('control: overdue NON-addendum subagent IS picked up by the sweep', async () => {
    const audit = new AuditLog(taskDb)
    const reconciler = new TaskReconciler(taskDb, audit)
    taskDb.upsertAgentSession('boss', 'session-boss', 'alive')

    const parent = taskDb.createTask({ from: 'boss', to: 'boss', description: 'live card', priority: 'normal' })
    taskDb.claimTask(parent.id, 'boss')
    const child = taskDb.createSubagentTask({
      description: 'normal overdue sub', parent_task_id: parent.id, supervisor_agent: 'boss',
    })
    taskDb.run(db => db.prepare(`
      UPDATE tasks SET last_heartbeat_at = datetime('now','-600 seconds'),
        next_check_at = datetime('now','-10 seconds') WHERE id = ?
    `).run(child.id))

    await reconciler.reconcileDueTasks()

    const after = taskDb.getTask(child.id)!
    // Non-addendum subagent IS reconciled (heartbeat overdue) -> escalation_level climbs.
    expect(after.escalation_level).toBeGreaterThan(0)
  })
})
