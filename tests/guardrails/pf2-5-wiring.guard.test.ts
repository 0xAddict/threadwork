/*
 * tests/guardrails/pf2-5-wiring.guard.test.ts
 *
 * PK-PF2-5 Stage B — ATM-PF2-04/08/09/10 (REQ-PF2-03/04/08/09/10/11),
 * diff-allowlist gate, mirroring PK-PF1-4's own
 * `tests/guardrails/pf1-4-wiring.guard.test.ts` structure exactly (same
 * helpers, same two-job split). Two jobs:
 *
 * (1) STATIC WIRING SCAN: confirms the 3 new server.ts tool cases
 *     (create_watcher/list_watchers/disable_watcher) call the correct
 *     watchers/declarative-watchers.ts functions; confirms watchdog.ts's
 *     run() calls evaluateWatchers() as Step 3e, in the correct
 *     try/catch-wrapped position between Step 3d and the Log-cycle-summary
 *     comment; confirms evaluateWatchers() itself checks the flag as its
 *     first statement.
 *
 * (2) DIFF-ALLOWLIST: diffs server.ts/watchdog.ts against the pre-wiring
 *     baseline commit `eeed2e6` (the PK-PF2-4 seam, immediately before this
 *     Stage B). Both files' diffs must contain ZERO deleted/modified
 *     lines (pure insertions only) — directly proves ATM-PF2-04's "zero
 *     lines changed inside findStaleTasks()/determineAction()/existing
 *     escalation-creation code" and ATM-PF2-08's "additive, existing tool
 *     cases byte-unchanged". Also confirms zero touched lines in the
 *     watcher_heartbeat DDL/call sites (REQ-PF2-11).
 *
 * BASE_COMMIT choice: `eeed2e6` (PK-PF2-4's seam), not an earlier PF2
 * commit — this guard isolates PK-PF2-5 Stage B's OWN diff, mirroring
 * PF1-4's own "anchor to the immediately-prior seam" discipline.
 */

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = 'eeed2e6'

function sh(cmd: string): string {
  return execSync(cmd, { cwd: REPO, encoding: 'utf-8' })
}

function diffFor(file: string): string {
  try {
    return sh(`git diff ${BASE_COMMIT} -- ${file}`)
  } catch {
    return ''
  }
}

function deletedLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter(l => l.startsWith('-') && !l.startsWith('---'))
    .map(l => l.slice(1))
}

const SERVER_TS = readFileSync(resolve(REPO, 'server.ts'), 'utf-8')
const WATCHDOG_TS = readFileSync(resolve(REPO, 'watchdog.ts'), 'utf-8')

function caseBody(caseLabel: string, source: string): string {
  const startMarker = `case '${caseLabel}': {`
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const nextCase = source.indexOf("\n      case '", start + startMarker.length)
  const defaultIdx = source.indexOf('\n      default:', start + startMarker.length)
  let end = source.length
  if (nextCase > start && nextCase < end) end = nextCase
  if (defaultIdx > start && defaultIdx < end) end = defaultIdx
  return source.slice(start, end)
}

describe('PK-PF2-5 (1) static wiring scan — server.ts 3 new tool cases', () => {
  test('server.ts imports createWatcher/getWatchers/disableWatcher from the watchers module', () => {
    expect(SERVER_TS).toMatch(/import\s*\{[^}]*createWatcher[^}]*\}\s*from\s*['"]\.\/watchers\/declarative-watchers['"]/)
    expect(SERVER_TS).toMatch(/getWatchers/)
    expect(SERVER_TS).toMatch(/disableWatcher/)
  })

  test('create_watcher case calls createWatcher() via db.run()', () => {
    const body = caseBody('create_watcher', SERVER_TS)
    expect(body).toMatch(/createWatcher\(/)
    expect(body).toMatch(/db\.run\(/)
  })

  test('list_watchers case calls getWatchers() via db.run()', () => {
    const body = caseBody('list_watchers', SERVER_TS)
    expect(body).toMatch(/getWatchers\(/)
    expect(body).toMatch(/db\.run\(/)
  })

  test('disable_watcher case calls disableWatcher() via db.run()', () => {
    const body = caseBody('disable_watcher', SERVER_TS)
    expect(body).toMatch(/disableWatcher\(/)
    expect(body).toMatch(/db\.run\(/)
  })

  test('all 48 pre-existing tool declarations + 3 new ones = 51 total case labels in the switch', () => {
    const caseCount = (SERVER_TS.match(/^\s*case '/gm) ?? []).length
    expect(caseCount).toBe(51)
  })
})

describe('PK-PF2-5 (1) static wiring scan — watchdog.ts evaluateWatchers() Step 3e', () => {
  function runBody(): string {
    const start = WATCHDOG_TS.indexOf('async run(): Promise<never> {')
    expect(start).toBeGreaterThan(-1)
    // run() is the last method in TaskReconciler; slice to end of file's class close is fine for a substring scan.
    return WATCHDOG_TS.slice(start)
  }

  test('run() calls this.evaluateWatchers(reconcileResult), wrapped in try/catch, between Step 3d and the Log-cycle-summary comment', () => {
    const body = runBody()
    const step3dIdx = body.indexOf('Step 3d: Scheduled memory consolidation')
    const step3eIdx = body.indexOf('this.evaluateWatchers(')
    const logSummaryIdx = body.indexOf('// Log cycle summary')
    expect(step3dIdx).toBeGreaterThan(-1)
    expect(step3eIdx).toBeGreaterThan(-1)
    expect(logSummaryIdx).toBeGreaterThan(-1)
    expect(step3eIdx).toBeGreaterThan(step3dIdx)
    expect(step3eIdx).toBeLessThan(logSummaryIdx)
  })

  test('the evaluateWatchers() call site is inside its own try/catch (mirrors monitorDecisions()/monitorIdleAgents()\'s sibling shape)', () => {
    const body = runBody()
    const callIdx = body.indexOf('this.evaluateWatchers(')
    const before = body.slice(0, callIdx)
    const tryIdx = before.lastIndexOf('try {')
    expect(tryIdx).toBeGreaterThan(-1)
    const between = body.slice(tryIdx + 'try {'.length, callIdx)
    expect(between).not.toContain('}') // still inside that same try block
    const after = body.slice(callIdx)
    expect(after.slice(0, 300)).toMatch(/catch \(err\) \{\s*\n\s*logError\('Watcher evaluation failed', err\)/)
  })

  test('evaluateWatchers() method itself checks declarative_watchers_enabled as its first statement (REQ-PF2-09)', () => {
    const start = WATCHDOG_TS.indexOf('async evaluateWatchers(')
    expect(start).toBeGreaterThan(-1)
    const openBrace = WATCHDOG_TS.indexOf('{', start)
    const nextLines = WATCHDOG_TS.slice(openBrace + 1, openBrace + 300)
    const flagCheckIdx = nextLines.indexOf("isFeatureEnabled('declarative_watchers_enabled')")
    expect(flagCheckIdx).toBeGreaterThan(-1)
    expect(flagCheckIdx).toBeLessThan(120) // near-immediately, not buried after other logic
  })

  test('watchdog.ts imports the watcher-evaluation symbols it needs from the watchers module', () => {
    expect(WATCHDOG_TS).toMatch(/from\s*['"]\.\/watchers\/declarative-watchers['"]/)
  })
})

describe(`PK-PF2-5 (2) diff-allowlist vs ${BASE_COMMIT}`, () => {
  test('server.ts diff contains ZERO deleted/modified lines (pure insertions only)', () => {
    const diff = diffFor('server.ts')
    const deleted = deletedLines(diff)
    expect(deleted).toEqual([])
  })

  test('watchdog.ts diff contains ZERO deleted/modified lines (pure insertions only)', () => {
    const diff = diffFor('watchdog.ts')
    const deleted = deletedLines(diff)
    expect(deleted).toEqual([])
  })

  test('findStaleTasks() and determineAction() are byte-unchanged (no deleted line touches either symbol)', () => {
    const diff = diffFor('watchdog.ts')
    const deleted = deletedLines(diff)
    expect(deleted.some(l => l.includes('function findStaleTasks'))).toBe(false)
    expect(deleted.some(l => l.includes('function determineAction'))).toBe(false)
  })

  test('watcher_heartbeat DDL/call sites are zero-touched in db.ts (this packet makes no db.ts edit at all)', () => {
    const diff = diffFor('db.ts')
    expect(diff.trim()).toBe('') // no diff at all -- this packet touches zero db.ts lines
  })

  test('all 48 pre-existing server.ts case bodies (everything up to and including unpark_task) are byte-identical to the baseline (redundant, explicit check beyond the zero-deleted-lines guard above)', () => {
    // Re-derive the baseline's own case list and confirm each pre-existing
    // case body string still appears verbatim (not just "no deletions" --
    // this additionally guards against a delete+reinsert-elsewhere that
    // could otherwise net to the same deleted-line count).
    const baseline = sh(`git show ${BASE_COMMIT}:server.ts`)
    const baselineCaseNames = Array.from(baseline.matchAll(/^\s*case '([a-z_]+)':/gm)).map(m => m[1])
    expect(baselineCaseNames.length).toBe(48)
    for (const name of baselineCaseNames) {
      const baselineBody = caseBody(name, baseline)
      const currentBody = caseBody(name, SERVER_TS)
      expect(currentBody).toBe(baselineBody)
    }
  })
})
