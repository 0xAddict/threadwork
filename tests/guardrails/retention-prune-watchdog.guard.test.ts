/*
 * tests/guardrails/retention-prune-watchdog.guard.test.ts
 *
 * T1 KO-SWEEP (#10376215) — ATM-014 (REQ-015 / M-013).
 *
 * The prune step's ONLY trigger is runHygiene()'s existing invocation surface
 * (the manual `run_hygiene` MCP tool, or whatever cron already drives it). It is
 * explicitly FORBIDDEN from the watchdog task-supervision loop. This guardrail
 * proves watchdog.ts references none of the new prune symbols and never calls
 * runHygiene — so no per-task-check path can ever fire a prune.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const WATCHDOG_SOURCE = readFileSync(resolve(REPO, 'watchdog.ts'), 'utf-8')

const FORBIDDEN_SYMBOLS = [
  'RETENTION_PRUNE_CONFIG',
  'runRetentionPruneStep6',
  'computePruneEligibility',
  'getRewardConsumptionHighWaterMark',
  'computeTernaryEligibleIds',
  'intersectHwmEligibility',
  'archiveThenDeleteTernaryEligible',
  'deleteAgeEligibleRows',
  'retention_prune_enabled',
  'ternary_rewards_archive',
]

describe('ATM-014: watchdog never triggers the retention prune', () => {
  test.each(FORBIDDEN_SYMBOLS)('watchdog.ts contains no reference to %s', (symbol) => {
    expect(WATCHDOG_SOURCE).not.toContain(symbol)
  })

  test('watchdog.ts never invokes runHygiene', () => {
    expect(WATCHDOG_SOURCE).not.toContain('runHygiene')
  })
})
