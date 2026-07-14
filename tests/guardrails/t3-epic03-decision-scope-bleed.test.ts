// tests/guardrails/t3-epic03-decision-scope-bleed.test.ts — T3 EPIC-03 ATM-010
// (REQ-011, M-003/M-005): zero-diff guardrail proving the critic-side model-id
// adoption wrapper is wired additively in server.ts + the NEW module ONLY, with
// zero edits to verification/cross-family-critique.ts AND decision.ts.
//
// Mirrors the ATM-007 mechanism (tests/guardrails/t3-cross-family-critique-scope-bleed.test.ts),
// extended per the spec to decision.ts's addCritique/finalizeDecision source
// blocks. To avoid embedding decision.ts's nested-backtick SQL template as a
// fragile string literal, the two protected blocks are extracted DYNAMICALLY
// from the pinned 900750f source (git show) and asserted to appear verbatim in
// the working-tree file — a strict superset of the ATM-007 `toContain(BLOCK)`
// check, with no hand-copied literal to drift.
//
// A failure here is a real scope-bleed finding, not a spec to grow into — do not
// weaken any assertion to force a pass.

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = '900750f'
const DECISION_REL = 'decision.ts'
const CROSS_FAMILY_REL = 'verification/cross-family-critique.ts'

function gitNumstat(relPath: string): string {
  return execSync(`git diff --numstat ${BASE_COMMIT} -- ${relPath}`, {
    cwd: REPO,
    encoding: 'utf-8',
  }).trim()
}

function gitShow(relPath: string): string {
  return execSync(`git show ${BASE_COMMIT}:${relPath}`, { cwd: REPO, encoding: 'utf-8' })
}

/** Slice a source between an inclusive start marker and an exclusive end marker. */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const s = source.indexOf(startMarker)
  expect(s).toBeGreaterThanOrEqual(0)
  const e = source.indexOf(endMarker, s + startMarker.length)
  expect(e).toBeGreaterThan(s)
  return source.slice(s, e).trimEnd()
}

describe('ATM-010: decision.ts + cross-family-critique.ts zero-diff guardrail (REQ-011)', () => {
  test('decision.ts is byte-untouched since T3 base 900750f (zero changed lines)', () => {
    expect(gitNumstat(DECISION_REL)).toBe('')
  })

  test('verification/cross-family-critique.ts is byte-untouched since T3 base 900750f (zero changed lines)', () => {
    expect(gitNumstat(CROSS_FAMILY_REL)).toBe('')
  })

  test("decision.ts addCritique() source block is byte-identical to the pinned 900750f baseline", () => {
    const pinned = gitShow(DECISION_REL)
    const working = readFileSync(resolve(REPO, DECISION_REL), 'utf-8')
    // addCritique() body: from its declaration up to the comment that precedes
    // finalizeDecision().
    const block = sliceBetween(pinned, '  addCritique(', '  /**\n   * Finalize a decision')
    expect(block.length).toBeGreaterThan(200) // sanity: we captured a real block
    expect(working).toContain(block)
  })

  test('decision.ts finalizeDecision() signature + transaction-open block is byte-identical to the pinned 900750f baseline', () => {
    const pinned = gitShow(DECISION_REL)
    const working = readFileSync(resolve(REPO, DECISION_REL), 'utf-8')
    // finalizeDecision() declaration through the BEGIN IMMEDIATE line — the
    // structural signature of the atomic finalize path EPIC-03 must not touch.
    const startIdx = pinned.indexOf('  finalizeDecision(')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    const beginMarker = "db.prepare('BEGIN IMMEDIATE').run()"
    const beginIdx = pinned.indexOf(beginMarker, startIdx)
    expect(beginIdx).toBeGreaterThan(startIdx)
    const block = pinned.slice(startIdx, beginIdx + beginMarker.length)
    expect(block.length).toBeGreaterThan(200)
    expect(working).toContain(block)
  })

  test('server.ts adds NO import from decision.ts or cross-family-critique.ts write symbols for EPIC-03 — the wrapper import is the NEW critique-attribution module only', () => {
    const addedLines = execSync(`git diff -U0 ${BASE_COMMIT} -- server.ts`, {
      cwd: REPO,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    // EPIC-03's only new import is from './verification/critique-attribution'.
    const addedCritiqueAttributionImport = addedLines.filter(l => /critique-attribution/.test(l))
    expect(addedCritiqueAttributionImport.length).toBeGreaterThanOrEqual(1)
    // No added line expands the decision.ts or cross-family-critique.ts import lists.
    const addedProtectedImports = addedLines.filter(
      l => /from ['"]\.\/decision['"]/.test(l) || /cross-family-critique/.test(l),
    )
    expect(addedProtectedImports).toEqual([])
  })
})
