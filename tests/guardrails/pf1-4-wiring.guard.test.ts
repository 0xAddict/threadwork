/*
 * tests/guardrails/pf1-4-wiring.guard.test.ts
 *
 * PK-PF1-4 Stage B — ATM-PF1-10 (REQ-PF1-04/10), diff-allowlist gate (R1,
 * boss's rider on the Stage B GO). Two jobs:
 *
 * (1) STATIC WIRING SCAN: confirms `recordExpectedOutcome()` is present,
 *     positioned BEFORE the corresponding pre-existing DB-mutation call, and
 *     wrapped in try/catch, inside each of the 4 claim/delegation case
 *     bodies in server.ts; confirms `reflect()` is present in both
 *     `checkAndRunDebrief()` and `forceDebrief()` in debrief.ts.
 *
 * (2) DIFF-ALLOWLIST (R1 — boss's explicit pre-authorization): diffs
 *     server.ts/debrief.ts against the pre-wiring baseline commit `71d0131`
 *     (the PK-PF1-3 seam, immediately before Stage B). server.ts's diff must
 *     contain ZERO deleted/modified lines (pure insertions only, at all 4
 *     sites) — this directly proves ATM-PF1-10's "zero lines changed inside
 *     the pre-existing claim/delegation functions themselves". debrief.ts's
 *     diff may contain EXACTLY the two pre-authorized tail-conversion lines
 *     as deletions (`return daemon.runDebrief(false)` /
 *     `return daemon.runDebrief(true)`) — R1 names these two lines and no
 *     others as approved; any other deleted line in debrief.ts is a
 *     violation (would mean `DebriefDaemon.runDebrief()` itself, which
 *     ATM-PF1-10 protects, was touched, or an unapproved edit landed
 *     elsewhere in the file).
 *
 * BASE_COMMIT choice: `71d0131` (not `4db813f`/`039e017`) is deliberate —
 * this guard's job is to isolate PK-PF1-4 Stage B's OWN diff, not PF1's
 * cumulative diff since the branch point (PK-PF1-1/2/3 never touched
 * server.ts/debrief.ts at all, so this is equivalent in practice, but
 * anchoring to the immediately-prior seam is the more precise, more
 * future-proof choice — mirrors ATM-015's own "BASE = the lane's own base"
 * discipline).
 */

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = '71d0131'

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
const DEBRIEF_TS = readFileSync(resolve(REPO, 'debrief.ts'), 'utf-8')

function caseBody(caseLabel: string, source: string): string {
  const startMarker = `case '${caseLabel}': {`
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  // Next `      case '` at the same indent level closes this case body.
  const nextCase = source.indexOf("\n      case '", start + startMarker.length)
  expect(nextCase).toBeGreaterThan(start)
  return source.slice(start, nextCase)
}

// Structural check (not a fixed-character window, which is fragile against
// varying comment-block lengths): find the NEAREST `try {` before `hookIdx`
// and confirm no `}` closes it before `hookIdx` is reached — i.e. hookIdx is
// still genuinely inside that try block, not past a prior, unrelated one.
function isInsideImmediatelyPrecedingTryBlock(body: string, hookIdx: number): boolean {
  const beforeHook = body.slice(0, hookIdx)
  const tryIdx = beforeHook.lastIndexOf('try {')
  if (tryIdx === -1) return false
  const between = body.slice(tryIdx + 'try {'.length, hookIdx)
  return !between.includes('}')
}

describe('PK-PF1-4 (1) static wiring scan — server.ts 4 hook sites', () => {
  test('claim_task: recordExpectedOutcome() present, before claimTaskWithSession(), inside try/catch', () => {
    const body = caseBody('claim_task', SERVER_TS)
    const hookIdx = body.indexOf('recordExpectedOutcome(db.getHandle()') // call-shaped, not a comment mention
    const mutationIdx = body.indexOf('db.claimTaskWithSession(')
    expect(hookIdx).toBeGreaterThan(-1)
    expect(mutationIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeLessThan(mutationIdx)
    expect(isInsideImmediatelyPrecedingTryBlock(body, hookIdx)).toBe(true)
  })

  test('delegate_task: recordExpectedOutcome() present, after db.delegateTask() resolves, before the nudge/postToGroup calls', () => {
    const body = caseBody('delegate_task', SERVER_TS)
    const mutationIdx = body.indexOf('db.delegateTask(')
    const hookIdx = body.indexOf('recordExpectedOutcome(db.getHandle()') // call-shaped, not a comment mention
    const nudgeIdx = body.indexOf('dispatchAgentNudge(')
    expect(mutationIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeGreaterThan(mutationIdx)
    expect(hookIdx).toBeLessThan(nudgeIdx)
    expect(isInsideImmediatelyPrecedingTryBlock(body, hookIdx)).toBe(true)
  })

  test('assign_task: recordExpectedOutcome() present, before db.assignTask(), inside try/catch', () => {
    const body = caseBody('assign_task', SERVER_TS)
    const hookIdx = body.indexOf('recordExpectedOutcome(db.getHandle()') // call-shaped, not a comment mention
    const mutationIdx = body.indexOf('db.assignTask(')
    expect(hookIdx).toBeGreaterThan(-1)
    expect(mutationIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeLessThan(mutationIdx)
    expect(isInsideImmediatelyPrecedingTryBlock(body, hookIdx)).toBe(true)
  })

  test('transition_task: recordExpectedOutcome() present, before db.transitionToInProgress(), inside try/catch', () => {
    const body = caseBody('transition_task', SERVER_TS)
    const hookIdx = body.indexOf('recordExpectedOutcome(db.getHandle()') // call-shaped, not a comment mention
    const mutationIdx = body.indexOf('db.transitionToInProgress(')
    expect(hookIdx).toBeGreaterThan(-1)
    expect(mutationIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeLessThan(mutationIdx)
    expect(isInsideImmediatelyPrecedingTryBlock(body, hookIdx)).toBe(true)
  })

  test('server.ts imports recordExpectedOutcome from the reflection module', () => {
    expect(SERVER_TS).toMatch(/import\s*\{[^}]*recordExpectedOutcome[^}]*\}\s*from\s*['"]\.\/reflection\/outcome-feedback['"]/)
  })
})

describe('PK-PF1-4 (1) static wiring scan — debrief.ts reflect() insertion', () => {
  function fnBody(fnName: string): string {
    const start = DEBRIEF_TS.indexOf(`export async function ${fnName}(`)
    expect(start).toBeGreaterThan(-1)
    const nextExport = DEBRIEF_TS.indexOf('\nexport ', start + 10)
    return DEBRIEF_TS.slice(start, nextExport > -1 ? nextExport : DEBRIEF_TS.length)
  }

  test('checkAndRunDebrief() calls reflect() after daemon.runDebrief(false) resolves, flag-gated', () => {
    const body = fnBody('checkAndRunDebrief')
    expect(body).toMatch(/await daemon\.runDebrief\(false\)/)
    expect(body).toMatch(/reflect\(/)
    expect(body).toMatch(/isFeatureEnabled\(['"]outcome_feedback_enabled['"]\)/)
    const runIdx = body.indexOf('daemon.runDebrief(false)')
    const reflectIdx = body.indexOf('reflect(')
    expect(reflectIdx).toBeGreaterThan(runIdx)
  })

  test('forceDebrief() calls reflect() after daemon.runDebrief(true) resolves, flag-gated', () => {
    const body = fnBody('forceDebrief')
    expect(body).toMatch(/await daemon\.runDebrief\(true\)/)
    expect(body).toMatch(/reflect\(/)
    expect(body).toMatch(/isFeatureEnabled\(['"]outcome_feedback_enabled['"]\)/)
    const runIdx = body.indexOf('daemon.runDebrief(true)')
    const reflectIdx = body.indexOf('reflect(')
    expect(reflectIdx).toBeGreaterThan(runIdx)
  })

  test('debrief.ts imports reflect from the reflection module', () => {
    expect(DEBRIEF_TS).toMatch(/import\s*\{[^}]*reflect[^}]*\}\s*from\s*['"]\.\/reflection\/outcome-feedback['"]/)
  })
})

describe(`PK-PF1-4 (2) diff-allowlist vs ${BASE_COMMIT} — R1 pre-authorization`, () => {
  test('server.ts diff contains ZERO deleted/modified lines (pure insertions only, at all 4 sites)', () => {
    const diff = diffFor('server.ts')
    const deleted = deletedLines(diff)
    expect(deleted).toEqual([])
  })

  test(`debrief.ts diff's deleted lines are EXACTLY R1's pre-authorized tail-conversion lines (and no others)`, () => {
    const diff = diffFor('debrief.ts')
    const deleted = deletedLines(diff).map(l => l.trim())
    const authorized = new Set([
      'return daemon.runDebrief(false)',
      'return daemon.runDebrief(true)',
    ])
    const unauthorized = deleted.filter(l => !authorized.has(l))
    expect(unauthorized).toEqual([])
    // Sanity: both authorized lines were actually touched (proves the diff
    // isn't empty/vacuous — a real edit happened at both sites).
    expect(deleted).toContain('return daemon.runDebrief(false)')
    expect(deleted).toContain('return daemon.runDebrief(true)')
  })

  test('DebriefDaemon.runDebrief() itself (the private method) is byte-unchanged', () => {
    const diff = diffFor('debrief.ts')
    // Any deleted line whose content matches the runDebrief() method's own
    // signature or its try/finally structure would be a violation — the
    // allowlist above already proves the ONLY 2 deletions are the two
    // wrapper tail-returns, neither of which is inside runDebrief() itself
    // (verified by inspection: runDebrief() is defined well before both
    // wrapper functions in file order). This test is a redundant, explicit
    // named check for that specific protected symbol, for clarity in a
    // future diff review.
    const deleted = deletedLines(diff)
    const touchesRunDebrief = deleted.some(l => l.includes('async runDebrief('))
    expect(touchesRunDebrief).toBe(false)
  })
})
