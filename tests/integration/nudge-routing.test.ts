import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { AuditLog } from '../../audit'
import { TaskDB } from '../../db'
import { dispatchAgentNudge, configureNudgeDebounce } from '../../nudge'
import { NUDGE_ACTIONS } from '../../nudge-actions'

/**
 * Sprint #256 gate 7 — nudge routing integration test.
 *
 * Exercises the dispatcher with an isolated in-memory SQLite DB and
 * NUDGE_DISABLED=1 so it doesn't fire real tmux keystrokes. Verifies that
 * each callsite writes the expected audit event sequence through the
 * dispatcher boundary.
 *
 * Full real-tmux integration (isolated `tmux -L threadwork-test` server,
 * capture-pane verification) is deferred as a follow-up — that's a 200+
 * line test harness, not a 50-line smoke test. This test covers the
 * audit-log contract; the real-tmux test covers keystroke delivery.
 */

let db: TaskDB
let audit: AuditLog

beforeAll(() => {
  process.env.NODE_ENV = 'test' // ensure NUDGE_DISABLED is set inside nudge.ts
  db = new TaskDB(':memory:')
  audit = new AuditLog(db)
  configureNudgeDebounce(db, audit)
})

afterAll(() => {
  // TaskDB doesn't expose a close() — leaving to GC is fine for :memory: dbs
})

describe('nudge routing (sprint #256 gate 7)', () => {
  test('dispatchAgentNudge writes nudge_requested intent row', async () => {
    const before = audit.query({ action: NUDGE_ACTIONS.REQUESTED, limit: 100 })
    await dispatchAgentNudge('steve', 'test message', { source: 'boss' })
    const after = audit.query({ action: NUDGE_ACTIONS.REQUESTED, limit: 100 })
    expect(after.length).toBeGreaterThan(before.length)
    const latest = after[0]
    expect(latest.agent).toBe('boss')
    const detail = JSON.parse(latest.detail ?? '{}')
    expect(detail.target).toBe('steve')
    expect(detail.message).toBe('test message')
  })

  test('dispatchAgentNudge to unknown agent returns error without writing delivery rows', async () => {
    const beforeFailed = audit.query({ action: NUDGE_ACTIONS.DELIVERY_FAILED, limit: 100 })
    const result = await dispatchAgentNudge('not-a-real-agent', 'test', { source: 'boss' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown agent')
    const afterFailed = audit.query({ action: NUDGE_ACTIONS.DELIVERY_FAILED, limit: 100 })
    expect(afterFailed.length).toBe(beforeFailed.length)
  })

  test('dispatchAgentNudge with NUDGE_DISABLED returns ok without writing agent_nudged', async () => {
    const beforeAgentNudged = audit.query({ action: NUDGE_ACTIONS.AGENT_NUDGED_LEGACY, limit: 100 })
    const result = await dispatchAgentNudge('steve', 'test2', { source: 'boss' })
    expect(result.ok).toBe(true)
    const afterAgentNudged = audit.query({ action: NUDGE_ACTIONS.AGENT_NUDGED_LEGACY, limit: 100 })
    // In test mode we bail BEFORE the debounce path, so no agent_nudged row is written.
    // This is the fix for sprint #256's root cause: phantom agent_nudged on suppressed nudges.
    expect(afterAgentNudged.length).toBe(beforeAgentNudged.length)
  })
})
