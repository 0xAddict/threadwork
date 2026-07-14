/*
 * tests/guardrails/retention-prune-hwm-isolation.guard.test.ts
 *
 * T1 KO-SWEEP (#10376215) — ATM-010 (REQ-011 / M-008), STATIC half.
 *
 * The never-prune-unconsumed-rewards guard scopes ONLY `ternary_rewards`. This
 * guardrail proves the two non-reward tables' prune function
 * (`deleteAgeEligibleRows`, used identically for `failure_classifications` and
 * `cross_family_critiques`) contains ZERO reference to
 * `getRewardConsumptionHighWaterMark` — so a missing/invalid T4 cursor can never
 * interfere with those two tables' retention. The runtime half (null HWM does
 * not block the other tables) lives in tests/retention-prune.test.ts.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const DB_SOURCE = readFileSync(resolve(REPO, 'db.ts'), 'utf-8')

const HELPERS_BEGIN = '// ── T1 KO-SWEEP prune helpers (BEGIN) ──'
const HELPERS_END = '// ── T1 KO-SWEEP prune helpers (END) ──'

function sliceBetween(src: string, begin: string, end: string): string {
  const i = src.indexOf(begin)
  const j = src.indexOf(end)
  expect(i).toBeGreaterThanOrEqual(0)
  expect(j).toBeGreaterThan(i)
  return src.slice(i, j)
}

describe('ATM-010 static: HWM isolation from the non-reward prune path', () => {
  const helpers = sliceBetween(DB_SOURCE, HELPERS_BEGIN, HELPERS_END)

  test('deleteAgeEligibleRows (the fc/cfc prune fn) never references the HWM', () => {
    const start = helpers.indexOf('export function deleteAgeEligibleRows')
    const end = helpers.indexOf('export function archiveThenDeleteTernaryEligible')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const fnSource = helpers.slice(start, end)
    expect(fnSource).not.toContain('getRewardConsumptionHighWaterMark')
    expect(fnSource).not.toContain('reward_consumption_cursor')
    expect(fnSource).not.toContain('computeTernaryEligibleIds')
  })

  test('both non-reward tables are pruned through deleteAgeEligibleRows only', () => {
    // The Step-6 method routes failure_classifications and cross_family_critiques
    // through deleteAgeEligibleRows (no HWM), and ternary_rewards through
    // archiveThenDeleteTernaryEligible (HWM-gated). Prove the routing.
    const method = sliceBetween(
      DB_SOURCE,
      '// ── T1 KO-SWEEP Step-6 method (BEGIN) ──',
      '// ── T1 KO-SWEEP Step-6 method (END) ──',
    )
    expect(method).toContain("deleteAgeEligibleRows(db, fcCfg.table")
    expect(method).toContain("deleteAgeEligibleRows(db, cfcCfg.table")
    expect(method).toContain('archiveThenDeleteTernaryEligible(db, trCfg.retention_days)')
  })
})
