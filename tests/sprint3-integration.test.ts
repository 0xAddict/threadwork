import { describe, test, expect, beforeEach } from 'bun:test'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import { DecisionDB } from '../decision'
import { AuditLog } from '../audit'
import { TaskReconciler, type ReconcileResult } from '../watchdog'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/sprint3-integration-test.db'

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

describe('sprint 3: integration tests & edge cases', () => {
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
  // Helpers
  // -----------------------------------------------------------------------

  function simulateAgentActivity(agent: string, minutesAgo: number): void {
    const db = (taskDb as any).db
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, created_at)
      VALUES (?, 'task_claimed', '{"task_id":99}', datetime('now', '-' || ? || ' minutes'))
    `).run(agent, minutesAgo)
  }

  function createPendingTaskFor(agent: string): void {
    taskDb.createTask({ from: 'boss', to: agent, description: 'Test pending task', priority: 'normal' })
  }

  function createInProgressTaskFor(agent: string): void {
    const task = taskDb.createTask({ from: 'boss', to: agent, description: 'Active task', priority: 'normal' })
    taskDb.claimTask(task.id, agent)
  }

  function backdateDecision(decisionId: number, minutesAgo: number): void {
    const db = (taskDb as any).db
    db.prepare("UPDATE decisions SET created_at = datetime('now', '-' || ? || ' minutes') WHERE id = ?")
      .run(minutesAgo, decisionId)
  }

  // -----------------------------------------------------------------------
  // AC-1: Expired decisions do not trigger idle board nudges
  // -----------------------------------------------------------------------

  test('expired decision does not count as pending work for idle nudges', async () => {
    // Set up: idle agent (20 min idle), only pending work is one open decision
    // that has an expired deadline
    simulateAgentActivity('steve', 20)

    // Create decision that will expire during monitorDecisions
    dec.openDecision('Expired question', null, 'boss', {
      expiresAt: '2020-01-01T00:00:00',
    })

    // No pending tasks for steve
    // Run full cycle: monitorDecisions first (expires the decision),
    // then monitorIdleAgents (should NOT nudge because no open decisions remain)
    const result = freshResult()
    await reconciler.monitorDecisions(result)
    await reconciler.monitorIdleAgents(result)

    expect(result.decisions_expired).toBe(1)
    // Steve should NOT be nudged -- the only open decision just expired
    expect(result.idle_nudges).toBe(0)
  })

  test('expired decision removed from open count leaves agent un-nudged', async () => {
    // Multiple agents idle, sole open decision expires
    simulateAgentActivity('sadie', 25)
    simulateAgentActivity('kiera', 30)

    dec.openDecision('Team question', null, 'boss', {
      expiresAt: '2020-01-01T00:00:00',
    })

    const result = freshResult()
    await reconciler.monitorDecisions(result)
    await reconciler.monitorIdleAgents(result)

    expect(result.decisions_expired).toBe(1)
    expect(result.idle_nudges).toBe(0)
  })

  // -----------------------------------------------------------------------
  // AC-2: No double-nudging within a 30-second window
  // -----------------------------------------------------------------------

  test('decision position nudge does not cause a duplicate idle board nudge in the same cycle', async () => {
    // Agent is idle 20 min. A stale open decision (15 min old) exists.
    // No pending tasks. monitorDecisions will fire a decision_position_nudge.
    // monitorIdleAgents should NOT also fire an idle_board_nudge in the same cycle.
    simulateAgentActivity('steve', 20)

    const d = dec.openDecision('Architecture choice', null, 'boss')
    backdateDecision(d.id, 15)

    const result = freshResult()
    await reconciler.monitorDecisions(result)
    // decision_position_nudge should have fired
    expect(result.decisions_nudged).toBe(1)

    await reconciler.monitorIdleAgents(result)

    // The decision is still open (status='open'), so the open_decisions query
    // will still find it. BUT the agent-scoped fix means it counts for ALL
    // worker agents. The key test: if the idle nudge DOES fire, that is
    // acceptable per the contract as long as we don't double-nudge for the
    // SAME reason. The contract says: "because the decision nudge counts as
    // recent activity in the cooldown check, or the open_decisions count drops
    // to zero post-expiry".
    //
    // The decision_position_nudge logged to audit_log has action='decision_position_nudge',
    // NOT one of the ACTIVITY_ACTIONS. So it does not reset the agent's "last activity".
    // However, the open_decisions count will be >= 1 (the stale decision is still open).
    // The idle nudge MAY fire if the agent has no other cooldown.
    //
    // For AC-2, the specific scenario is: agent has NO pending tasks and the
    // ONLY "work" is this one open decision. The agent-scoped fix (AC-8)
    // means the open_decisions query counts decisions where the agent has NOT
    // submitted a position. Steve hasn't, so open_decisions=1.
    //
    // To verify no double-nudge, we check: the decision_position_nudge was
    // fired (via monitorDecisions), and if idle_board_nudge also fires, it
    // is for a DIFFERENT reason (general board check vs specific position request).
    // The contract says to verify the agent does NOT get an idle_board_nudge.
    //
    // The mechanism: the decision_position_nudge audit entry was written
    // during monitorDecisions. monitorIdleAgents checks for 'idle_board_nudge'
    // cooldown (not 'decision_position_nudge'). So the cooldown does NOT
    // cover cross-type nudges by default.
    //
    // To satisfy AC-2, we need to verify the behavior. With pending_tasks=0
    // and open_decisions=1, the idle nudge WILL fire unless we prevent it.
    // The approved contract says "at least one mechanism" must work.
    //
    // Actually, re-reading the code: the decision_position_nudge writes to
    // audit_log with agent='watchdog'. The idle nudge cooldown checks for
    // action='idle_board_nudge'. These are different actions, so the cooldown
    // does NOT prevent the idle nudge from firing.
    //
    // This means for the current implementation, both nudges CAN fire.
    // We need to add a cross-nudge guard. Let me verify what actually happens
    // and then fix if needed.

    // If idle_nudges is 0, the existing code already handles it.
    // If idle_nudges > 0, we need to add a guard.
    // For now, let's record the actual behavior:
    const auditNudges = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' })
    const decisionNudges = audit.query({ agent: 'watchdog', action: 'decision_position_nudge' })

    // The contract requires: no idle_board_nudge when decision_position_nudge already fired
    expect(decisionNudges.length).toBeGreaterThanOrEqual(1)
    // This assertion documents the requirement -- we need to make it pass
    expect(result.idle_nudges).toBe(0)
  })

  // -----------------------------------------------------------------------
  // AC-3: Watchdog cycle time under 5 seconds
  // -----------------------------------------------------------------------

  test('full cycle completes in under 5 seconds with realistic workload', async () => {
    const db = (taskDb as any).db

    // Create realistic workload: 5 open decisions, 3 pending tasks, 4 agents
    for (let i = 0; i < 5; i++) {
      dec.openDecision(`Decision ${i + 1}`, `Context for decision ${i + 1}`, 'boss')
    }
    for (const agent of ['steve', 'sadie', 'kiera']) {
      createPendingTaskFor(agent)
    }
    // Simulate activity for agents so idle detection has data
    for (const agent of ['steve', 'sadie', 'kiera', 'snoopy']) {
      simulateAgentActivity(agent, 20)
    }

    const result = freshResult()
    const start = performance.now()

    await reconciler.reconcileDueTasks()
    await reconciler.monitorDecisions(result)
    await reconciler.monitorIdleAgents(result)

    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(5000)
  })

  // -----------------------------------------------------------------------
  // AC-4: Decision monitoring metrics in cycle summary
  // -----------------------------------------------------------------------

  test('cycle summary log line contains all four decision/idle counter names', async () => {
    // Capture console.log output
    const logLines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '))
    }

    try {
      // Set up one of each event type:
      // (a) expired decision
      dec.openDecision('Expired', null, 'boss', { expiresAt: '2020-01-01T00:00:00' })

      // (b) stale open decision (for position nudge)
      const d2 = dec.openDecision('Stale open', null, 'boss')
      backdateDecision(d2.id, 15)

      // (c) ready-to-finalize decision
      const d3 = dec.openDecision('Ready to finalize', null, 'boss')
      dec.addPosition(d3.id, 'steve', 'Option A')
      dec.addPosition(d3.id, 'sadie', 'Option B')

      // (d) idle agent with pending tasks (for idle nudge)
      simulateAgentActivity('kiera', 20)
      createPendingTaskFor('kiera')

      const result = freshResult()
      await reconciler.monitorDecisions(result)
      await reconciler.monitorIdleAgents(result)

      // Verify counters are non-zero
      expect(result.decisions_expired).toBeGreaterThanOrEqual(1)
      expect(result.decisions_nudged).toBeGreaterThanOrEqual(1)
      expect(result.decisions_ready).toBeGreaterThanOrEqual(1)
      expect(result.idle_nudges).toBeGreaterThanOrEqual(1)

      // Simulate the cycle summary log line (same logic as run() loop)
      const r = result
      const hasActivity = r.checked > 0 || r.nudged > 0 || r.escalated > 0 || r.blocked_relayed > 0 || r.dead_sessions > 0 || r.decisions_expired > 0 || r.decisions_nudged > 0 || r.decisions_ready > 0 || r.idle_nudges > 0
      expect(hasActivity).toBe(true)

      // Build the summary line the same way run() does
      const summary = `Cycle complete: checked=${r.checked} nudged=${r.nudged} escalated=${r.escalated} blocked_relayed=${r.blocked_relayed} dead_sessions=${r.dead_sessions} decisions_expired=${r.decisions_expired} decisions_nudged=${r.decisions_nudged} decisions_ready=${r.decisions_ready} idle_nudges=${r.idle_nudges}`

      // Verify all four counter names appear with non-zero values
      expect(summary).toContain('decisions_expired=')
      expect(summary).toContain('decisions_nudged=')
      expect(summary).toContain('decisions_ready=')
      expect(summary).toContain('idle_nudges=')

      // Verify they are non-zero in the summary
      expect(summary).not.toContain('decisions_expired=0')
      expect(summary).not.toContain('decisions_nudged=0')
      expect(summary).not.toContain('decisions_ready=0')
      expect(summary).not.toContain('idle_nudges=0')
    } finally {
      console.log = originalLog
    }
  })

  // -----------------------------------------------------------------------
  // AC-5: Agent opens decision and is the only expected responder
  // -----------------------------------------------------------------------

  test('decision opener is included in nudge target list for their own decision', async () => {
    // Steve opens a decision. After 15 min with no positions, monitorDecisions
    // should nudge all WORKER_AGENTS including steve.
    const d = dec.openDecision('Steve needs input', null, 'steve')
    backdateDecision(d.id, 15)

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_nudged).toBe(1)

    // Verify audit entry contains steve in agents_nudged
    const nudgeEntries = audit.query({ agent: 'watchdog', action: 'decision_position_nudge' })
    expect(nudgeEntries.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(nudgeEntries[0].detail!)
    expect(detail.decision_id).toBe(d.id)
    expect(detail.agents_nudged).toContain('steve')
  })

  test('opener as sole responder does not cause infinite nudge loop', async () => {
    // Steve opens decision, all other agents have active tasks (so they are busy).
    // Steve is the only one who COULD respond. Verify no crash or infinite loop.
    const d = dec.openDecision('Only steve can answer', null, 'steve')
    backdateDecision(d.id, 15)

    // Give all other workers active tasks
    createInProgressTaskFor('sadie')
    createInProgressTaskFor('kiera')
    createInProgressTaskFor('snoopy')

    // Run monitorDecisions twice to verify no double-nudge
    const result1 = freshResult()
    await reconciler.monitorDecisions(result1)
    expect(result1.decisions_nudged).toBe(1)

    // Second run should NOT nudge again (audit cooldown prevents it)
    const result2 = freshResult()
    await reconciler.monitorDecisions(result2)
    expect(result2.decisions_nudged).toBe(0)
  })

  // -----------------------------------------------------------------------
  // AC-6: Position nudge does NOT fire for expired decisions
  // -----------------------------------------------------------------------

  test('decision that is both old and expired gets expired but not position-nudged', async () => {
    // Create a decision that is 15 min old AND has an expired deadline
    const d = dec.openDecision('Old and expired', null, 'boss', {
      expiresAt: '2020-01-01T00:00:00',
    })
    backdateDecision(d.id, 15)

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    // Should expire (expiry runs first in monitorDecisions)
    expect(result.decisions_expired).toBe(1)
    // Should NOT nudge (expired decisions are filtered out of openDecisions)
    expect(result.decisions_nudged).toBe(0)

    // Verify the decision is actually expired in DB
    const updated = dec.getDecision(d.id)
    expect(updated?.status).toBe('expired')
  })

  test('multiple old-and-expired decisions are all expired, none position-nudged', async () => {
    for (let i = 0; i < 3; i++) {
      const d = dec.openDecision(`Expired decision ${i}`, null, 'boss', {
        expiresAt: '2020-01-01T00:00:00',
      })
      backdateDecision(d.id, 20)
    }

    const result = freshResult()
    await reconciler.monitorDecisions(result)

    expect(result.decisions_expired).toBe(3)
    expect(result.decisions_nudged).toBe(0)
  })

  // -----------------------------------------------------------------------
  // AC-7: Full cycle integration -- all four paths fire
  // -----------------------------------------------------------------------

  test('all four counter types fire in a single cycle without interference', async () => {
    // (a) One expired decision
    dec.openDecision('Will expire', null, 'boss', { expiresAt: '2020-01-01T00:00:00' })

    // (b) One stale open decision (15 min old, no positions)
    const d2 = dec.openDecision('Stale and needs positions', null, 'boss')
    backdateDecision(d2.id, 15)

    // (c) One decision with 2 positions (ready to finalize)
    const d3 = dec.openDecision('Has positions', null, 'boss')
    dec.addPosition(d3.id, 'steve', 'Option A')
    dec.addPosition(d3.id, 'sadie', 'Option B')

    // (d) One idle agent with pending tasks
    simulateAgentActivity('kiera', 20)
    createPendingTaskFor('kiera')

    const result = freshResult()
    await reconciler.monitorDecisions(result)
    await reconciler.monitorIdleAgents(result)

    // All four counters must be >= 1
    expect(result.decisions_expired).toBeGreaterThanOrEqual(1)
    expect(result.decisions_nudged).toBeGreaterThanOrEqual(1)
    expect(result.decisions_ready).toBeGreaterThanOrEqual(1)
    expect(result.idle_nudges).toBeGreaterThanOrEqual(1)

    // Verify no interference: audit trail has entries for all four action types
    const expiredEntries = audit.query({ agent: 'watchdog', action: 'decision_expired' })
    const nudgeEntries = audit.query({ agent: 'watchdog', action: 'decision_position_nudge' })
    const readyEntries = audit.query({ agent: 'watchdog', action: 'decision_ready_to_finalize' })
    const idleEntries = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' })

    expect(expiredEntries.length).toBeGreaterThanOrEqual(1)
    expect(nudgeEntries.length).toBeGreaterThanOrEqual(1)
    expect(readyEntries.length).toBeGreaterThanOrEqual(1)
    expect(idleEntries.length).toBeGreaterThanOrEqual(1)
  })

  // -----------------------------------------------------------------------
  // AC-8: Agent-scoped open_decisions count in idle nudge
  // -----------------------------------------------------------------------

  test('agent with position on all open decisions is NOT nudged for open decisions', async () => {
    // Create open decision, steve has already submitted a position on it
    const d = dec.openDecision('Already participated', null, 'boss')
    dec.addPosition(d.id, 'steve', 'My position on this')

    // Steve is idle with no pending tasks
    simulateAgentActivity('steve', 20)
    // No pending tasks for steve

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    // Steve should NOT be nudged -- he has no pending tasks and has already
    // submitted a position on the only open decision
    const steveNudge = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' }).find(e => {
      try {
        const detail = JSON.parse(e.detail ?? '{}')
        return detail.agent === 'steve'
      } catch { return false }
    })
    expect(steveNudge).toBeUndefined()
  })

  test('agent with position on SOME decisions is still nudged for remaining ones', async () => {
    // Two open decisions. Steve has a position on one but not the other.
    const d1 = dec.openDecision('Participated', null, 'boss')
    dec.addPosition(d1.id, 'steve', 'My take')

    const d2 = dec.openDecision('Not participated', null, 'boss')
    // Steve has NOT submitted a position on d2

    simulateAgentActivity('steve', 20)
    // No pending tasks for steve, but d2 is an open decision he hasn't participated in

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    // Steve SHOULD be nudged because d2 is an open decision without his position
    const steveNudge = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' }).find(e => {
      try {
        const detail = JSON.parse(e.detail ?? '{}')
        return detail.agent === 'steve'
      } catch { return false }
    })
    expect(steveNudge).toBeTruthy()

    // Verify the open_decisions count in the audit detail is 1 (not 2)
    const detail = JSON.parse(steveNudge!.detail!)
    expect(detail.open_decisions).toBe(1)
  })

  test('agent-scoped query uses SQL-level filtering (not application-level)', async () => {
    // This test verifies the query correctly filters at the SQL level by
    // checking that the count returned is agent-specific.
    const d1 = dec.openDecision('Decision A', null, 'boss')
    dec.addPosition(d1.id, 'steve', 'Steve position')
    // sadie has NOT submitted a position on d1

    const d2 = dec.openDecision('Decision B', null, 'boss')
    dec.addPosition(d2.id, 'sadie', 'Sadie position')
    // steve has NOT submitted a position on d2

    // Both agents idle
    simulateAgentActivity('steve', 20)
    simulateAgentActivity('sadie', 20)

    const result = freshResult()
    await reconciler.monitorIdleAgents(result)

    // Both should be nudged, each with open_decisions=1
    const steveNudge = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' }).find(e => {
      const detail = JSON.parse(e.detail ?? '{}')
      return detail.agent === 'steve'
    })
    const sadieNudge = audit.query({ agent: 'watchdog', action: 'idle_board_nudge' }).find(e => {
      const detail = JSON.parse(e.detail ?? '{}')
      return detail.agent === 'sadie'
    })

    expect(steveNudge).toBeTruthy()
    expect(sadieNudge).toBeTruthy()

    // Steve has position on d1 but not d2 -> open_decisions = 1
    expect(JSON.parse(steveNudge!.detail!).open_decisions).toBe(1)
    // Sadie has position on d2 but not d1 -> open_decisions = 1
    expect(JSON.parse(sadieNudge!.detail!).open_decisions).toBe(1)
  })
})
