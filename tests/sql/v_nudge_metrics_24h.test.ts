import { describe, test, expect, beforeAll } from 'bun:test'
import { TaskDB } from '../../db'
import { AuditLog } from '../../audit'
import { NUDGE_ACTIONS } from '../../nudge-actions'

/**
 * Sprint #256 gate 5/7 — v_nudge_metrics_24h view smoke test.
 *
 * Inserts synthetic audit_log rows with each of the expected action strings
 * and asserts the view exposes the expected counts. Fails if the view's
 * IN clause or SELECT columns drift out of sync with the action constants
 * in nudge-actions.ts.
 */

let db: TaskDB
let audit: AuditLog

beforeAll(() => {
  db = new TaskDB(':memory:')
  audit = new AuditLog(db)
})

describe('v_nudge_metrics_24h includes canonical and legacy action strings (sprint #256 gate 5)', () => {
  test('view counts nudge_fired, nudge_suppressed, nudge_sent, nudge_delivery_failed, and agent_nudged for a target', () => {
    const target = 'sadie'

    // Seed synthetic audit rows for each of the 5 metric-tracked action strings.
    // Each row's detail JSON must include a `target` for the per-target rollup.
    const seeds = [
      { action: NUDGE_ACTIONS.FIRED, count: 5 },
      { action: NUDGE_ACTIONS.SUPPRESSED, count: 3 },
      { action: NUDGE_ACTIONS.SENT, count: 5 },
      { action: NUDGE_ACTIONS.DELIVERY_FAILED, count: 0 },
      { action: NUDGE_ACTIONS.AGENT_NUDGED_LEGACY, count: 5 },
    ]

    for (const { action, count } of seeds) {
      for (let i = 0; i < count; i++) {
        audit.log('watchdog', action, { target, urgency: 'normal', pending_count: 1 })
      }
    }

    // Query the per-target view.
    const rows = db.run(d =>
      d.prepare(
        `SELECT * FROM v_nudge_metrics_24h WHERE target = ?`
      ).all(target) as Array<Record<string, unknown>>
    )

    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.nudges_fired_24h).toBe(5)
    expect(row.nudges_suppressed_24h).toBe(3)
    expect(row.nudges_sent_24h).toBe(5)
    expect(row.nudges_delivery_failed_24h).toBe(0)
    expect(row.agent_nudged_legacy_24h).toBe(5)
    // suppression_rate = suppressed / (fired + suppressed) = 3 / 8 = 0.375
    expect(row.suppression_rate as number).toBeCloseTo(0.375, 3)
    // delivery_rate = sent / fired = 5 / 5 = 1.0
    expect(row.delivery_rate as number).toBe(1.0)
  })

  test('v_nudge_metrics_24h_total aggregates across all targets', () => {
    const rows = db.run(d =>
      d.prepare(`SELECT * FROM v_nudge_metrics_24h_total`).all() as Array<Record<string, unknown>>
    )
    expect(rows.length).toBe(1)
    const row = rows[0]
    // Columns must exist (schema shape check)
    expect(row).toHaveProperty('nudges_fired_24h')
    expect(row).toHaveProperty('nudges_suppressed_24h')
    expect(row).toHaveProperty('nudges_sent_24h')
    expect(row).toHaveProperty('nudges_delivery_failed_24h')
    expect(row).toHaveProperty('agent_nudged_legacy_24h')
    expect(row).toHaveProperty('suppression_rate')
    expect(row).toHaveProperty('delivery_rate')
  })
})
