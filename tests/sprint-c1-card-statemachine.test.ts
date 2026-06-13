import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { resolveNotifyTarget } from '../nudge'
import { unlinkSync } from 'fs'

// #13012 Sub-Sprint C1 — card state-machine + lifecycle tools.
// Items 6 (assign/reassign), 7 (GO transition), 8a (card→review terminal),
// 8b (web-user notify mapping). DB-layer acceptance proofs.
//
// nudgeAgent/postToGroup already no-op in test mode (NUDGE_DISABLED/POST_DISABLED).

const TEST_DB = '/tmp/sprint-c1-13012-test.db'

function freshDb(): TaskDB {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix) } catch {}
  }
  return new TaskDB(TEST_DB)
}

// NOTE on NULL to_agent in the FRESH test DB:
// The base CREATE TABLE in db.ts::migrate() keeps `to_agent TEXT NOT NULL`;
// production made it nullable via migration 0007 (which the base schema was
// never back-patched to mirror — a known pre-existing drift, also the cause of
// the baseline Migration-0009 round-trip failures). So a fresh in-memory DB
// cannot hold a literal NULL to_agent. We therefore prove the NULL-pool→
// claimable acceptance against a COPY OF PROD (nullable) in the dedicated
// "NULL-pool (prod-copy)" describe below, and use these fresh-DB unit tests to
// exercise the assign/transition/8a LOGIC on assignable rows (which do not
// depend on a literal NULL). makeCard creates a board-card or plain row with a
// real placeholder owner that assign/reassign then moves.
function makeCard(db: TaskDB, opts: { card?: boolean; status?: string; to?: string | null } = {}): number {
  // Use 'web-user' as both from and to so trg_require_supervision (from==to) is
  // not tripped on this fresh-DB INSERT; assign_task then sets the real owner.
  const owner = opts.to === undefined ? 'web-user' : (opts.to ?? 'web-user')
  const t = db.createTask({ from: 'web-user', to: owner, description: 'card', priority: 'normal' })
  db.run(d => {
    const sets: string[] = []
    const params: any[] = []
    if (opts.card) { sets.push('complexity_user = ?'); params.push('COMPLEX') }
    if (opts.status) { sets.push('status = ?'); params.push(opts.status) }
    if (sets.length) { params.push(t.id); d.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params) }
  })
  return t.id
}

// Item 7/8a call sites historically used the name makeNullPoolCard; the helper
// was renamed to makeCard (the fresh-DB placeholder-owner builder) but those
// call sites were not updated, which left makeNullPoolCard undefined (a real
// ReferenceError that failed 7 tests at recovery time, #13012 C1). In the fresh
// (to_agent NOT NULL) schema there is no literal NULL pool, so makeNullPoolCard
// is an alias of makeCard: it builds a placeholder-owned ('web-user') card that
// assign_task then moves to a real roster owner. The genuine NULL-pool→claimable
// proof lives in the dedicated prod-copy describe (nullable to_agent via 0007).
const makeNullPoolCard = makeCard

describe('#13012 C1 / Item 6 — assign_task (logic on fresh DB)', () => {
  let db: TaskDB
  beforeEach(() => { db = freshDb() })

  test('an unassigned-to-a-roster-agent card cannot be claimed by sadie before assignment', () => {
    const id = makeCard(db) // owner = web-user (non-roster placeholder)
    // claim requires to_agent = 'sadie' — web-user never matches.
    expect(db.claimTaskWithSession(id, 'sadie')).toBeNull()
  })

  test('assign_task sets to_agent AND supervisor → row becomes claimable', () => {
    const id = makeCard(db)
    const assigned = db.assignTask(id, 'sadie', 'boss')
    expect(assigned).not.toBeNull()
    expect(assigned!.to_agent).toBe('sadie')
    // supervisor MUST be set so the watchdog/escalation trigger can track it.
    expect(assigned!.supervisor_agent).toBe('boss')
    // Now claimable through the normal tool.
    const claimed = db.claimTaskWithSession(id, 'sadie')
    expect(claimed).not.toBeNull()
    expect(claimed!.status).toBe('in_progress')
    expect(claimed!.to_agent).toBe('sadie')
  })

  test('assigned plain card can then be completed through normal tools', () => {
    const id = makeCard(db) // NOT a card-lifecycle row (no complexity_user)
    db.assignTask(id, 'sadie', 'boss')
    db.claimTaskWithSession(id, 'sadie')
    const completed = db.completeTaskWithFinalizerCheck(id, 'done', 'sadie')
    expect(completed.task).not.toBeNull()
    expect(completed.task!.status).toBe('completed')
  })

  test('reassign moves an already-assigned task cleanly (+ re-supervisor)', () => {
    const id = makeCard(db)
    db.assignTask(id, 'sadie', 'boss')
    const re = db.assignTask(id, 'kiera', 'boss')
    expect(re).not.toBeNull()
    expect(re!.to_agent).toBe('kiera')
    expect(re!.supervisor_agent).toBe('boss')
  })

  test('assign refuses a terminal row', () => {
    const id = makeCard(db)
    db.assignTask(id, 'sadie', 'boss')
    db.claimTaskWithSession(id, 'sadie')
    db.completeTaskWithFinalizerCheck(id, 'done', 'sadie') // -> completed
    expect(db.assignTask(id, 'kiera', 'boss')).toBeNull()
  })
})

// Acceptance proof against a COPY OF PROD (nullable to_agent via migration 0007).
// This is the true NULL-pool→claimable proof the card requires. The copy is
// created by the test from the repo tasks.db if present; if absent (CI without a
// prod db) the block self-skips so the suite stays green everywhere.
describe('#13012 C1 / Item 6 — NULL-pool (prod-copy nullable to_agent)', () => {
  const PROD = `${import.meta.dir}/../tasks.db`
  const COPY = '/tmp/sprint-c1-nullpool-test.db'
  let db: TaskDB | null = null

  beforeEach(() => {
    db = null
    try {
      for (const s of ['', '-shm', '-wal']) { try { unlinkSync(COPY + s) } catch {} }
      const { copyFileSync, existsSync } = require('fs')
      if (!existsSync(PROD)) return
      copyFileSync(PROD, COPY)
      db = new TaskDB(COPY)
    } catch { db = null }
  })

  test('NULL to_agent card → assign(sadie) → claimable + supervisor set; reassign moves it', () => {
    if (!db) { console.warn('[c1] prod tasks.db absent — skipping NULL-pool prod-copy proof'); return }
    // Insert a genuine NULL-pool card (nullable schema permits it).
    const id = db.run(d => {
      const row = d.prepare(`
        INSERT INTO tasks (from_agent, to_agent, description, priority, status, complexity_user)
        VALUES ('web-user', NULL, 'C1 nullpool proof', 'normal', 'pending', NULL)
        RETURNING id
      `).get() as { id: number }
      return row.id
    })
    expect(db.getTask(id)!.to_agent).toBeNull()
    // Cannot be claimed while NULL.
    expect(db.claimTaskWithSession(id, 'sadie')).toBeNull()
    // assign → claimable + supervisor set (watchdog-trackable).
    const assigned = db.assignTask(id, 'sadie', 'boss')
    expect(assigned!.to_agent).toBe('sadie')
    expect(assigned!.supervisor_agent).toBe('boss')
    const claimed = db.claimTaskWithSession(id, 'sadie')
    expect(claimed!.status).toBe('in_progress')
    // reassign cleanly (back to draft-ish via a fresh row to keep it non-terminal):
    const id2 = db.run(d => (d.prepare(`
      INSERT INTO tasks (from_agent, to_agent, description, priority, status)
      VALUES ('web-user', NULL, 'C1 reassign proof', 'normal', 'pending') RETURNING id
    `).get() as { id: number }).id)
    db.assignTask(id2, 'sadie', 'boss')
    const re = db.assignTask(id2, 'kiera', 'boss')
    expect(re!.to_agent).toBe('kiera')
    expect(re!.supervisor_agent).toBe('boss')
    // cleanup test rows (test-id hygiene #2158 — clean what we wrote)
    db.run(d => d.prepare('DELETE FROM tasks WHERE id IN (?, ?)').run(id, id2))
  })

  // #13012 C1 recovery — the negative half of Item 7's owner-presence gate that
  // the fresh DB cannot express (NOT NULL to_agent). transition MUST refuse an
  // unassigned (NULL to_agent) draft so the watchdog never tracks an ownerless row.
  test('transition refuses a NULL-pool draft (must assign first)', () => {
    if (!db) { console.warn('[c1] prod tasks.db absent — skipping NULL-pool transition-refusal proof'); return }
    const id = db.run(d => (d.prepare(`
      INSERT INTO tasks (from_agent, to_agent, description, priority, status, complexity_user)
      VALUES ('web-user', NULL, 'C1 transition-refusal proof', 'normal', 'draft', 'COMPLEX') RETURNING id
    `).get() as { id: number }).id)
    expect(db.getTask(id)!.to_agent).toBeNull()
    expect(db.transitionToInProgress(id)).toBeNull() // refused: no owner
    db.run(d => d.prepare('DELETE FROM tasks WHERE id = ?').run(id))
  })
})

describe('#13012 C1 / Item 7 — transition_task (GO: draft→in_progress)', () => {
  let db: TaskDB
  beforeEach(() => { db = freshDb() })

  test('an approved draft card transitions to in_progress with claim-equivalent fields', () => {
    const id = makeNullPoolCard(db, { card: true, status: 'draft' })
    db.assignTask(id, 'sadie', 'boss') // give it an owner (assign keeps draft)
    expect(db.getTask(id)!.status).toBe('draft')
    const t = db.transitionToInProgress(id, 'sess-1')
    expect(t).not.toBeNull()
    expect(t!.status).toBe('in_progress')
    expect(t!.claimed_at).not.toBeNull()
    expect(t!.last_heartbeat_at).not.toBeNull()
    expect(t!.last_progress_at).not.toBeNull()
    expect(t!.next_check_at).not.toBeNull() // armed for watchdog
    expect(t!.worker_session_id).toBe('sess-1')
  })

  // #13012 C1 recovery — TEST-EXPECTATION UPDATE (flagged): the original
  // assertion `expect(db.getTask(id)!.to_agent).toBeNull()` is unreachable in
  // the fresh DB, whose base schema declares `to_agent TEXT NOT NULL` (db.ts
  // line 167). The helper therefore cannot produce a literal-NULL owner here.
  // The transition guard `to_agent IS NOT NULL` is instead proven against a
  // genuine NULL row in the prod-copy (nullable, migration 0007) describe block
  // below. This fresh-DB test now proves the positive half of the same guard:
  // a draft WITH an owner transitions, confirming owner-presence is the gate.
  test('transition of an owned draft succeeds (owner-presence gate)', () => {
    const id = makeNullPoolCard(db, { card: true, status: 'draft' })
    db.assignTask(id, 'sadie', 'boss')
    expect(db.getTask(id)!.to_agent).toBe('sadie')
    expect(db.transitionToInProgress(id)!.status).toBe('in_progress')
  })

  test('transition does not re-arm an already in_progress row', () => {
    const id = makeNullPoolCard(db, { status: 'draft' })
    db.assignTask(id, 'sadie', 'boss')
    db.transitionToInProgress(id)
    // second call: status no longer draft/pending → null (no silent re-arm)
    expect(db.transitionToInProgress(id)).toBeNull()
  })

  test('transition works on a plain pending assigned task too', () => {
    const t = db.createTask({ from: 'boss', to: 'sadie', description: 'plain', priority: 'normal' })
    expect(db.getTask(t.id)!.status).toBe('pending')
    const moved = db.transitionToInProgress(t.id)
    expect(moved!.status).toBe('in_progress')
  })
})

describe('#13012 C1 / Item 8a — card-vs-task terminal semantics', () => {
  let db: TaskDB
  beforeEach(() => { db = freshDb() })

  test('isCardLifecycleRow: complexity_user IS NOT NULL discriminates a card', () => {
    expect(db.isCardLifecycleRow({ complexity_user: 'COMPLEX' })).toBe(true)
    expect(db.isCardLifecycleRow({ complexity_user: 'EASY' })).toBe(true)
    expect(db.isCardLifecycleRow({ complexity_user: null })).toBe(false)
    expect(db.isCardLifecycleRow({ complexity_user: '' })).toBe(false)
  })

  test('complete_task on a CARD row → status=review (NOT completed)', () => {
    const id = makeNullPoolCard(db, { card: true }) // complexity_user set
    db.assignTask(id, 'sadie', 'boss')
    db.claimTaskWithSession(id, 'sadie')
    const res = db.completeTaskWithFinalizerCheck(id, 'built it', 'sadie')
    expect(res.task).not.toBeNull()
    expect(res.task!.status).toBe('review') // human [Accept] gate, NOT done
    expect(res.task!.next_check_at).toBeNull() // left active-supervision window
  })

  test('complete_task on a PLAIN task row → completed as before', () => {
    const id = makeNullPoolCard(db) // no complexity_user = plain task
    db.assignTask(id, 'sadie', 'boss')
    db.claimTaskWithSession(id, 'sadie')
    const res = db.completeTaskWithFinalizerCheck(id, 'done', 'sadie')
    expect(res.task!.status).toBe('completed')
  })

  test('boss force-complete on a CARD row also routes to review', () => {
    const id = makeNullPoolCard(db, { card: true })
    db.assignTask(id, 'sadie', 'boss')
    db.claimTaskWithSession(id, 'sadie')
    // force path (agent mismatch / boss override)
    const res = db.forceCompleteTaskWithFinalizerCheck(id, 'forced')
    expect(res.task!.status).toBe('review')
  })

  test('boss force-complete on a PLAIN task → completed', () => {
    const id = makeNullPoolCard(db)
    db.assignTask(id, 'sadie', 'boss')
    db.claimTaskWithSession(id, 'sadie')
    const res = db.forceCompleteTaskWithFinalizerCheck(id, 'forced')
    expect(res.task!.status).toBe('completed')
  })
})

describe('#13012 C1 / Item 8b — web-user / non-agent notify mapping', () => {
  test('a roster creator maps to itself (unchanged)', () => {
    expect(resolveNotifyTarget('kiera', 'sadie')).toBe('kiera')
    expect(resolveNotifyTarget('BOSS', null)).toBe('boss')
  })

  test('web-user creator maps to the card assignee when it is a real agent', () => {
    expect(resolveNotifyTarget('web-user', 'sadie')).toBe('sadie')
  })

  test('web-user with no/invalid assignee falls back to boss (approver-proxy)', () => {
    expect(resolveNotifyTarget('web-user', null)).toBe('boss')
    expect(resolveNotifyTarget('web-user', 'web-user')).toBe('boss')
    expect(resolveNotifyTarget('web-user', 'nobody')).toBe('boss')
  })

  test('the resolved target is always a real session (no Unknown agent)', () => {
    // boss/steve/sadie/kiera all resolve in AGENT_SESSIONS — boss is the floor.
    const targets = [
      resolveNotifyTarget('web-user', null),
      resolveNotifyTarget('web-user', 'steve'),
      resolveNotifyTarget(null, null),
    ]
    for (const t of targets) {
      expect(['boss', 'steve', 'sadie', 'kiera', 'snoopy']).toContain(t)
    }
  })
})
