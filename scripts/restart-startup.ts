#!/usr/bin/env bun
/**
 * restart-startup.ts — CLI wrapper for restart-cap startup check
 *
 * Usage:
 *   bun restart-startup.ts --service=<name> [--tracker-dir=<dir>] [--now=<unix_sec>]
 *
 * Exits with code 0 if not capped, code 1 if self-terminated-cap.
 */

import { RestartTracker } from '../src/restart-cap/tracker'

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/)
    if (m) {
      args[m[1]!] = m[2]!
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const service = args['service']
if (!service) {
  process.stderr.write('Error: --service is required\n')
  process.exit(2)
}

const trackerDir = args['tracker-dir']
const nowSec = args['now'] ? parseInt(args['now'], 10) : undefined
const maxR = args['max-r'] ? parseInt(args['max-r'], 10) : undefined
const maxTSec = args['max-t-sec'] ? parseInt(args['max-t-sec'], 10) : undefined

const tracker = new RestartTracker({
  service,
  trackerDir,
  maxR,
  maxTSec,
})

const result = tracker.onStartup(nowSec)

if (result.capped) {
  process.stderr.write(`[restart-startup] CAPPED: service=${service} restart_count=${result.filtered_count}\n`)
  process.exit(1)
} else {
  process.stdout.write(`[restart-startup] OK: service=${service}\n`)
  process.exit(0)
}
