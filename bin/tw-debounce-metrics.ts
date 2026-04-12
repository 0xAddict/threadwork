#!/usr/bin/env bun
// v2-lite watchdog sprint (2026-04-09)
//
// tw-debounce-metrics — print last-24h nudge debounce metrics.
//
// Reads v_nudge_metrics_24h (per-target) and v_nudge_metrics_24h_total
// (aggregate) from tasks.db, plus derives wake-latency percentiles from
// the raw audit_log trail (the view can't compute percentiles in pure
// SQL without PERCENTILE_CONT, which SQLite doesn't ship).
//
// Wake-latency definition: for each nudge_fired row, latency is the time
// between the earliest prior nudge_suppressed row for the same target
// (since the last previous fire) and the fire itself. A fire with no
// suppressed predecessors has latency=0 (the event fired synchronously).
//
// Usage:
//   bun run bin/tw-debounce-metrics.ts
//   bun run bin/tw-debounce-metrics.ts --json
//   bun run bin/tw-debounce-metrics.ts --agent steve
//   bun run bin/tw-debounce-metrics.ts --hours 6      # custom lookback
//   bun run bin/tw-debounce-metrics.ts --db /path/to/tasks.db

import { Database } from 'bun:sqlite'
import { resolve } from 'path'

interface PerTargetRow {
  window_start: string
  window_end: string
  target: string
  nudges_fired_24h: number
  nudges_suppressed_24h: number
  suppression_rate: number
  avg_pending_per_fire: number
  max_pending_per_fire: number
}

interface TotalRow {
  window_start: string
  window_end: string
  nudges_fired_24h: number
  nudges_suppressed_24h: number
  suppression_rate: number
}

interface LatencyStats {
  count: number
  p50_ms: number
  p95_ms: number
  p99_ms: number
  max_ms: number
}

interface Report {
  window_start: string
  window_end: string
  total: TotalRow | null
  per_target: PerTargetRow[]
  latency_by_target: Record<string, LatencyStats>
  latency_overall: LatencyStats
  sprint_criteria: {
    suppression_rate_target: number
    suppression_rate_actual: number
    suppression_rate_met: boolean
    wake_latency_p99_target_ms: number
    wake_latency_p99_actual_ms: number
    wake_latency_p99_met: boolean
  }
}

function parseArgs(argv: string[]): {
  db: string
  json: boolean
  agent?: string
  hours: number
} {
  const args = argv.slice(2)
  let dbPath = process.env.THREADWORK_TASKS_DB
    ?? resolve(import.meta.dir, '..', 'tasks.db')
  let json = false
  let agent: string | undefined
  let hours = 24
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') json = true
    else if (a === '--db') { dbPath = args[++i] }
    else if (a === '--agent') { agent = args[++i] }
    else if (a === '--hours') { hours = Number(args[++i]) || 24 }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: bun run bin/tw-debounce-metrics.ts [--json] [--agent <name>] [--hours N] [--db /path/to/tasks.db]')
      process.exit(0)
    }
  }
  return { db: dbPath, json, agent, hours }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

function computeLatencyStats(samplesMs: number[]): LatencyStats {
  if (samplesMs.length === 0) {
    return { count: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0 }
  }
  const sorted = [...samplesMs].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50_ms: Math.round(percentile(sorted, 50)),
    p95_ms: Math.round(percentile(sorted, 95)),
    p99_ms: Math.round(percentile(sorted, 99)),
    max_ms: Math.round(sorted[sorted.length - 1]),
  }
}

/**
 * Compute wake-latency samples by walking audit_log in chronological order
 * per target. For each nudge_fired row we emit one sample:
 *   latency = fire.created_at - earliest_suppressed.created_at (since prior fire)
 * A fire with no preceding suppressed rows yields latency = 0.
 */
function deriveLatencySamples(
  db: Database,
  hours: number,
  agentFilter?: string,
): Record<string, number[]> {
  const rows = db.prepare(`
    SELECT
      json_extract(detail, '$.target') AS target,
      action,
      created_at
    FROM audit_log
    WHERE action IN ('nudge_fired', 'nudge_suppressed')
      AND created_at >= datetime('now', '-' || ? || ' hours')
      ${agentFilter ? "AND json_extract(detail, '$.target') = ?" : ''}
    ORDER BY target ASC, created_at ASC
  `).all(...(agentFilter ? [hours, agentFilter] : [hours])) as Array<{
    target: string | null
    action: string
    created_at: string
  }>

  const samplesByTarget: Record<string, number[]> = {}
  const pendingStartByTarget: Record<string, number | null> = {}

  for (const row of rows) {
    const target = row.target ?? '(unknown)'
    // SQLite datetimes are UTC; append 'Z' to parse as epoch ms.
    const tsMs = new Date(row.created_at + 'Z').getTime()
    if (Number.isNaN(tsMs)) continue

    if (!(target in samplesByTarget)) samplesByTarget[target] = []
    if (!(target in pendingStartByTarget)) pendingStartByTarget[target] = null

    if (row.action === 'nudge_suppressed') {
      // Record the earliest-unfired suppressed event for this target.
      if (pendingStartByTarget[target] === null) {
        pendingStartByTarget[target] = tsMs
      }
    } else {
      // nudge_fired — close out the pending batch.
      const start = pendingStartByTarget[target]
      const latency = start === null ? 0 : Math.max(0, tsMs - start)
      samplesByTarget[target].push(latency)
      pendingStartByTarget[target] = null
    }
  }

  return samplesByTarget
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function formatRate(r: number): string {
  return `${(r * 100).toFixed(1)}%`
}

function printHuman(report: Report): void {
  const { total, per_target, latency_by_target, latency_overall, sprint_criteria } = report

  console.log('──────────────────────────────────────────────────────────────')
  console.log(' tw-debounce-metrics — v2-lite watchdog sprint')
  console.log(`   window: ${report.window_start} UTC → ${report.window_end} UTC`)
  console.log('──────────────────────────────────────────────────────────────')

  if (!total || (total.nudges_fired_24h === 0 && total.nudges_suppressed_24h === 0)) {
    console.log('')
    console.log(' no nudge_fired or nudge_suppressed events in this window.')
    console.log(' (is THREADWORK_DEBOUNCE_ENABLED=1 set on server + watchdog?)')
    console.log('')
    return
  }

  console.log('')
  console.log(' TOTAL (all agents)')
  console.log(`   fired:            ${total.nudges_fired_24h}`)
  console.log(`   suppressed:       ${total.nudges_suppressed_24h}`)
  console.log(`   suppression rate: ${formatRate(total.suppression_rate)}`)
  console.log(`   wake latency:`)
  console.log(`     p50: ${formatMs(latency_overall.p50_ms)}`)
  console.log(`     p95: ${formatMs(latency_overall.p95_ms)}`)
  console.log(`     p99: ${formatMs(latency_overall.p99_ms)}`)
  console.log(`     max: ${formatMs(latency_overall.max_ms)}`)
  console.log('')

  console.log(' PER-TARGET')
  if (per_target.length === 0) {
    console.log('   (no per-target data)')
  } else {
    for (const row of per_target) {
      const lat = latency_by_target[row.target] ?? { p50_ms: 0, p95_ms: 0, p99_ms: 0, count: 0, max_ms: 0 }
      console.log(`   ${row.target.padEnd(10)} fired=${String(row.nudges_fired_24h).padStart(4)}  supp=${String(row.nudges_suppressed_24h).padStart(4)}  rate=${formatRate(row.suppression_rate).padStart(6)}  avg_pending=${row.avg_pending_per_fire.toFixed(2).padStart(5)}  max_pending=${String(row.max_pending_per_fire).padStart(3)}  p50=${formatMs(lat.p50_ms).padStart(6)}  p99=${formatMs(lat.p99_ms).padStart(6)}`)
    }
  }
  console.log('')

  console.log(' SPRINT SUCCESS CRITERIA')
  const sr = sprint_criteria
  const srSym = sr.suppression_rate_met ? 'PASS' : 'FAIL'
  const p99Sym = sr.wake_latency_p99_met ? 'PASS' : 'FAIL'
  console.log(`   [${srSym}] suppression_rate  ${formatRate(sr.suppression_rate_actual)}  (target >= ${formatRate(sr.suppression_rate_target)})`)
  console.log(`   [${p99Sym}] wake_latency_p99  ${formatMs(sr.wake_latency_p99_actual_ms)}  (target <= ${formatMs(sr.wake_latency_p99_target_ms)})`)
  console.log('')

  if (!sr.suppression_rate_met || !sr.wake_latency_p99_met) {
    console.log(' status: NOT READY for default-ON promotion.')
  } else {
    console.log(' status: READY for default-ON promotion.')
  }
  console.log('')
}

function main(): void {
  const opts = parseArgs(process.argv)
  const db = new Database(opts.db, { readonly: true })

  try {
    // Per-target
    let perTarget: PerTargetRow[] = []
    if (opts.agent) {
      perTarget = db.prepare(
        'SELECT * FROM v_nudge_metrics_24h WHERE target = ?'
      ).all(opts.agent) as PerTargetRow[]
    } else {
      perTarget = db.prepare('SELECT * FROM v_nudge_metrics_24h').all() as PerTargetRow[]
    }

    // Total
    const total = db.prepare('SELECT * FROM v_nudge_metrics_24h_total').get() as TotalRow | null

    // Latency (raw walk)
    const samplesByTarget = deriveLatencySamples(db, opts.hours, opts.agent)
    const latencyByTarget: Record<string, LatencyStats> = {}
    const allSamples: number[] = []
    for (const [target, samples] of Object.entries(samplesByTarget)) {
      latencyByTarget[target] = computeLatencyStats(samples)
      for (const s of samples) allSamples.push(s)
    }
    const latencyOverall = computeLatencyStats(allSamples)

    // Sprint criteria (per spec §Success): suppression_rate >= 0.60
    // AND wake_latency_p99 <= 90000ms.
    const SUPPRESSION_TARGET = 0.60
    const WAKE_LATENCY_P99_TARGET_MS = 90_000
    const srActual = total?.suppression_rate ?? 0
    const p99Actual = latencyOverall.p99_ms

    const report: Report = {
      window_start: total?.window_start ?? '(no data)',
      window_end: total?.window_end ?? '(no data)',
      total,
      per_target: perTarget,
      latency_by_target: latencyByTarget,
      latency_overall: latencyOverall,
      sprint_criteria: {
        suppression_rate_target: SUPPRESSION_TARGET,
        suppression_rate_actual: srActual,
        suppression_rate_met: srActual >= SUPPRESSION_TARGET,
        wake_latency_p99_target_ms: WAKE_LATENCY_P99_TARGET_MS,
        wake_latency_p99_actual_ms: p99Actual,
        wake_latency_p99_met: p99Actual === 0 ? (total?.nudges_fired_24h ?? 0) > 0 : p99Actual <= WAKE_LATENCY_P99_TARGET_MS,
      },
    }

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printHuman(report)
    }

    // Exit nonzero if sprint criteria are not met AND we have data — lets
    // CI/ops scripts use this CLI as a gate. If there's no data at all,
    // exit 0 (observation window not yet meaningful).
    const hasData = (total?.nudges_fired_24h ?? 0) + (total?.nudges_suppressed_24h ?? 0) > 0
    if (hasData && (!report.sprint_criteria.suppression_rate_met || !report.sprint_criteria.wake_latency_p99_met)) {
      process.exit(2)
    }
  } finally {
    db.close()
  }
}

main()
