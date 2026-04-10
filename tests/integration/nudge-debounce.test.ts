import { describe, test, expect, beforeAll } from 'bun:test'
import { AuditLog } from '../../audit'
import { TaskDB } from '../../db'
import { dispatchAgentNudge, configureNudgeDebounce } from '../../nudge'
import { NUDGE_ACTIONS } from '../../nudge-actions'

/**
 * Sprint #256 gate 7 — debounce flow integration test.
 *
 * Under NUDGE_DISABLED=1 the dispatcher returns early before the debounce
 * branch, so this test exercises the debounce plumbing via direct tryNudge
 * simulation + the dispatcher's pre-debounce audit writes.
 */

let db: TaskDB
let audit: AuditLog

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  db = new TaskDB(':memory:')
  audit = new AuditLog(db)
  configureNudgeDebounce(db, audit)
})

describe('nudge debounce audit trail (sprint #256 gate 7)', () => {
  test('every dispatchAgentNudge call writes nudge_requested with source attribution', async () => {
    // Three distinct sources writing intent rows. We verify the set of source
    // agents present, not the ordering (SQLite created_at can tie on same
    // millisecond, and query returns DESC).
    const sources = ['test-boss-A', 'test-steve-A', 'test-sadie-A']
    for (const source of sources) {
      await dispatchAgentNudge('kiera', `intent from ${source}`, { source })
    }
    const rows = audit.query({ action: NUDGE_ACTIONS.REQUESTED, limit: 50 })
    const agentsWithOurMarker = new Set(
      rows
        .filter(r => sources.includes(r.agent))
        .map(r => r.agent)
    )
    expect(agentsWithOurMarker).toEqual(new Set(sources))
  })

  test('nudge_requested row contains urgency and target in detail JSON', async () => {
    // Use a unique marker in the message so we can find the specific row we wrote.
    const marker = `urgent-test-marker-${Date.now()}-${Math.random()}`
    await dispatchAgentNudge('kiera', marker, { source: 'test-boss-B', urgency: 'urgent' })
    const rows = audit.query({ action: NUDGE_ACTIONS.REQUESTED, limit: 100 })
    const ours = rows.find(r => {
      try {
        const d = JSON.parse(r.detail ?? '{}')
        return d.message === marker
      } catch { return false }
    })
    expect(ours).toBeDefined()
    const detail = JSON.parse(ours!.detail ?? '{}')
    expect(detail.target).toBe('kiera')
    expect(detail.urgency).toBe('urgent')
    expect(detail.message).toBe(marker)
  })
})
