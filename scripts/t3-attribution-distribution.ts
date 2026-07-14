// scripts/t3-attribution-distribution.ts — T3 EPIC-06 ATM-020 (REQ-023, M-009/M-010).
//
// READ-ONLY before/after distribution verifier. Compares the proportion of
// neutral (reward=0) ternary_rewards rows recorded BEFORE vs AFTER a simulated/
// real activation timestamp, using the UNMODIFIED getTernaryRewards() accessor
// (verification/ternary-reward.ts). It is the closure evidence for #10376186
// (jointly #10376172/#10376173): once attribution is live and ≥1 genuine
// cross-family critique exists in the post-activation set, the post-activation
// reward=0 proportion should be strictly LOWER than pre-activation.
//
// MECHANISM ONLY (KO-T3-5): this script is NOT wired into CI. Running it against
// the live/prod DB is a POST-ACTIVATION operator job, out of build scope. The
// pure core (computeRewardZeroDistribution) is unit-tested in
// tests/t3-epic06-activation.test.ts (ATM-020); this file adds only a thin,
// read-only CLI wrapper.
//
// It performs NO writes of any kind and imports NO write helper — its only
// host-module import is the read-only getTernaryRewards accessor + its row type.
//
// Usage: bun scripts/t3-attribution-distribution.ts <db-path> <activation-ts>
//   where <activation-ts> is canonical SQLite datetime text 'YYYY-MM-DD HH:MM:SS'
//   (UTC), the format created_at is stored in — so the split is a plain
//   lexicographic string comparison against created_at.

import { Database } from 'bun:sqlite'
import { getTernaryRewards, type PersistedTernaryReward } from '../verification/ternary-reward'

/** One side of the before/after split. */
export interface DistributionBucket {
  total: number
  rewardZero: number
  /** rewardZero / total, or 0 when the bucket is empty. */
  proportionZero: number
}

/** The full before/after comparison report. */
export interface DistributionReport {
  activationTimestamp: string
  before: DistributionBucket
  after: DistributionBucket
  /** after.proportionZero strictly < before.proportionZero (the expected shift). */
  postProportionStrictlyLower: boolean
}

function bucketOf(rows: PersistedTernaryReward[]): DistributionBucket {
  const total = rows.length
  const rewardZero = rows.filter(r => r.reward === 0).length
  return { total, rewardZero, proportionZero: total === 0 ? 0 : rewardZero / total }
}

/**
 * PURE core (ATM-020): split rows on `created_at` vs `activationTimestamp`
 * (floor-inclusive on the AFTER side: created_at >= activation => after) and
 * compute each side's reward=0 proportion. Canonical SQLite datetime text sorts
 * lexicographically, so the comparison is a plain string `<` / `>=`.
 */
export function computeRewardZeroDistribution(
  rows: PersistedTernaryReward[],
  activationTimestamp: string,
): DistributionReport {
  const before: PersistedTernaryReward[] = []
  const after: PersistedTernaryReward[] = []
  for (const r of rows) {
    if (r.created_at < activationTimestamp) before.push(r)
    else after.push(r)
  }
  const beforeBucket = bucketOf(before)
  const afterBucket = bucketOf(after)
  return {
    activationTimestamp,
    before: beforeBucket,
    after: afterBucket,
    postProportionStrictlyLower: afterBucket.proportionZero < beforeBucket.proportionZero,
  }
}

/**
 * Read-only DB path: open the DB read-only, read ALL ternary_rewards rows via
 * the unmodified accessor, and compute the report. Opens no transaction, writes
 * nothing.
 */
export function analyzeDistribution(dbPath: string, activationTimestamp: string): DistributionReport {
  const db = new Database(dbPath, { readonly: true })
  try {
    return computeRewardZeroDistribution(getTernaryRewards(db), activationTimestamp)
  } finally {
    db.close()
  }
}

function formatReport(rep: DistributionReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  return [
    `T3 EPIC-06 (ATM-020) reward=0 distribution vs activation ${rep.activationTimestamp}`,
    `  BEFORE: ${rep.before.rewardZero}/${rep.before.total} neutral (${pct(rep.before.proportionZero)})`,
    `  AFTER : ${rep.after.rewardZero}/${rep.after.total} neutral (${pct(rep.after.proportionZero)})`,
    `  post-activation neutral proportion strictly lower: ${rep.postProportionStrictlyLower ? 'YES' : 'NO'}`,
  ].join('\n')
}

if (import.meta.main) {
  const [dbPath, activationTs] = process.argv.slice(2)
  if (!dbPath || !activationTs) {
    console.error('usage: bun scripts/t3-attribution-distribution.ts <db-path> <activation-ts "YYYY-MM-DD HH:MM:SS">')
    process.exit(2)
  }
  console.log(formatReport(analyzeDistribution(dbPath, activationTs)))
}
