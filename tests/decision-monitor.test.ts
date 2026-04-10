import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB } from '../decision'
import { AuditLog } from '../audit'
import { TaskReconciler, type ReconcileResult } from '../watchdog'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/decision-monitor-test.db'

function freshResult(): ReconcileResult {
  return {
    checked: 0,
    nudged: 0,
    escalated: 0,
    blocked_relayed: 0,
    dead_sessions: 0,
    decisions_expired: 0,
    decisions_nudged: 0,
    decisions_ready: 0,
    idle_nudges: 0,
  }
}

describe('decision monitoring', () => {
  let taskDb: TaskDB
  let audit: AuditLog
  let mem: MemoryDB
  let dec: DecisionDB
  let reconciler: TaskReconciler

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    audit = new AuditLog(taskDb)
    mem = new MemoryDB(taskDb)
    dec = new DecisionDB(taskDb, mem)
    reconciler = new TaskReconciler(taskDb, audit, {
      cadenceSec: 30,
      sessionTimeoutSec: 180,
      leaseTimeoutSec: 120,
    })
  })

  // -----------------------------------------------------------------------
  // (a) expireStaleDecisions is called and counted
  // -----------------------------------------------------------------------

  test('monitorDecisions expires stale decisions with past expires_at', async () => {
    // Create a decision with an already-expired deadline
    const d = dec.openDecision('Should we pivot?', 'Test context', 'boss', {
      expiresAt: '2020-01-01T00:00:00',
    })
    expect(d.status).toBe('open')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_expired).toBe(1)

    // Verify the decision is now expired in DB
    const updated = dec.getDecision(d.id)
    expect(updated?.status).toBe('expired')
  })

  test('monitorDecisions does not expire decisions without expires_at', async () => {
    dec.openDecision('Open-ended question', null, 'boss')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_expired).toBe(0)
  })

  test('monitorDecisions does not expire decisions with future expires_at', async () => {
    dec.openDecision('Future decision', null, 'boss', {
      expiresAt: '2099-01-01T00:00:00',
    })

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_expired).toBe(0)
  })

  // -----------------------------------------------------------------------
  // (a) audit logging for expired decisions
  // -----------------------------------------------------------------------

  test('expired decisions are logged to audit trail', async () => {
    dec.openDecision('Expiring decision', null, 'boss', {
      expiresAt: '2020-01-01T00:00:00',
    })

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    const auditEntries = audit.query({ agent: 'watchdog', action: 'decision_expired' })
    expect(auditEntries.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(auditEntries[0].detail!)
    expect(detail.title).toBe('Expiring decision')
  })

  // -----------------------------------------------------------------------
  // (b) Position nudge for stale open decisions
  // -----------------------------------------------------------------------

  test('nudges agents when decision is open > 10 minutes with no positions', async () => {
    // Create a decision and backdate it to 15 minutes ago
    const d = dec.openDecision('Architecture choice', null, 'steve')
    const db = (taskDb as any).db
    db.prepare("UPDATE decisions SET created_at = datetime('now', '-15 minutes') WHERE id = ?").run(d.id)

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_nudged).toBe(1)

    // Verify audit entry
    const auditEntries = audit.query({ agent: 'watchdog', action: 'decision_position_nudge' })
    expect(auditEntries.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(auditEntries[0].detail!)
    expect(detail.decision_id).toBe(d.id)
    expect(detail.agents_nudged).toBeArray()
    expect(detail.agents_nudged.length).toBeGreaterThan(0)
  })

  test('does not nudge for decisions open < 10 minutes', async () => {
    // Create a fresh decision (created_at is now)
    dec.openDecision('Recent decision', null, 'steve')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_nudged).toBe(0)
  })

  test('does not nudge for decisions that already have positions', async () => {
    // Create a decision, backdate it, then add a position (transitions to 'positions')
    const d = dec.openDecision('Has positions', null, 'boss')
    const db = (taskDb as any).db
    db.prepare("UPDATE decisions SET created_at = datetime('now', '-15 minutes') WHERE id = ?").run(d.id)
    dec.addPosition(d.id, 'steve', 'I think option A')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    // Should not nudge because status is 'positions', not 'open'
    expect(result.decisions_nudged).toBe(0)
  })

  test('does not double-nudge for same decision within 10 minutes', async () => {
    const d = dec.openDecision('No double nudge', null, 'boss')
    const db = (taskDb as any).db
    db.prepare("UPDATE decisions SET created_at = datetime('now', '-15 minutes') WHERE id = ?").run(d.id)

    const result1 = freshResult()
    await reconciler.monitorDecisions(result1)
    expect(result1.decisions_nudged).toBe(1)

    // Run again immediately — should NOT nudge again
    const result2 = freshResult()
    await reconciler.monitorDecisions(result2)
    expect(result2.decisions_nudged).toBe(0)
  })

  // -----------------------------------------------------------------------
  // (c) Ready-to-finalize detection
  // -----------------------------------------------------------------------

  test('detects decision ready to finalize when quorum of positions met', async () => {
    const d = dec.openDecision('Need team input', null, 'boss')
    dec.addPosition(d.id, 'steve', 'Option A is best')
    dec.addPosition(d.id, 'sadie', 'I agree with option A')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_ready).toBe(1)

    // Verify audit entry
    const auditEntries = audit.query({ agent: 'watchdog', action: 'decision_ready_to_finalize' })
    expect(auditEntries.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(auditEntries[0].detail!)
    expect(detail.decision_id).toBe(d.id)
    expect(detail.position_count).toBe(2)
    expect(detail.agents).toContain('steve')
    expect(detail.agents).toContain('sadie')
  })

  test('does not flag decision as ready with only 1 position', async () => {
    const d = dec.openDecision('Needs more input', null, 'boss')
    dec.addPosition(d.id, 'steve', 'Only me so far')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_ready).toBe(0)
  })

  test('does not double-notify Boss for same decision within 10 minutes', async () => {
    const d = dec.openDecision('Ready decision', null, 'boss')
    dec.addPosition(d.id, 'steve', 'Option A')
    dec.addPosition(d.id, 'kiera', 'Option B')

    const result1 = freshResult()
    await reconciler.monitorDecisions(result1)
    expect(result1.decisions_ready).toBe(1)

    // Run again immediately — should NOT notify again
    const result2 = freshResult()
    await reconciler.monitorDecisions(result2)
    expect(result2.decisions_ready).toBe(0)
  })

  test('does not flag finalized decisions as ready', async () => {
    const d = dec.openDecision('Already done', null, 'boss')
    dec.addPosition(d.id, 'steve', 'Option A')
    dec.addPosition(d.id, 'sadie', 'Option B')
    dec.finalizeDecision(d.id, 'boss', 'Going with A', 'Steve convinced me')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    // Finalized decisions are not in getOpenDecisions(), so they should not be flagged
    expect(result.decisions_ready).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Edge case: expired decision should not trigger position nudges
  // -----------------------------------------------------------------------

  test('expired decisions do not trigger position nudges', async () => {
    // Create decision that is both old AND expired
    const d = dec.openDecision('Old and expired', null, 'boss', {
      expiresAt: '2020-01-01T00:00:00',
    })
    const db = (taskDb as any).db
    db.prepare("UPDATE decisions SET created_at = datetime('now', '-15 minutes') WHERE id = ?").run(d.id)

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    // Should expire but NOT nudge (expired removes from open list)
    expect(result.decisions_expired).toBe(1)
    expect(result.decisions_nudged).toBe(0)
  })

  // -----------------------------------------------------------------------
  // ReconcileResult shape
  // -----------------------------------------------------------------------

  test('ReconcileResult includes decision fields', () => {
    const result = freshResult()
    expect(result).toHaveProperty('decisions_expired')
    expect(result).toHaveProperty('decisions_nudged')
    expect(result).toHaveProperty('decisions_ready')
    expect(typeof result.decisions_expired).toBe('number')
    expect(typeof result.decisions_nudged).toBe('number')
    expect(typeof result.decisions_ready).toBe('number')
  })

  // -----------------------------------------------------------------------
  // Multiple decisions in one cycle
  // -----------------------------------------------------------------------

  test('handles multiple decisions in a single monitoring cycle', async () => {
    // One expired decision
    dec.openDecision('Expired one', null, 'boss', { expiresAt: '2020-01-01T00:00:00' })

    // One stale open decision (no positions)
    const d2 = dec.openDecision('Stale open', null, 'boss')
    const db = (taskDb as any).db
    db.prepare("UPDATE decisions SET created_at = datetime('now', '-15 minutes') WHERE id = ?").run(d2.id)

    // One ready-to-finalize decision
    const d3 = dec.openDecision('Ready to finalize', null, 'boss')
    dec.addPosition(d3.id, 'steve', 'A')
    dec.addPosition(d3.id, 'sadie', 'B')

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_expired).toBe(1)
    expect(result.decisions_nudged).toBe(1)
    expect(result.decisions_ready).toBe(1)
  })
})
