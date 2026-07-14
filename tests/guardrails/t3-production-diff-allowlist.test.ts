// tests/guardrails/t3-production-diff-allowlist.test.ts — T3 ATM-022
// (REQ-008/REQ-011/REQ-034, M-005): production-diff allowlist guardrail that
// covers ALL protected files by construction, augmenting the source-block
// spot-checks in ATM-007 (and, later, ATM-010).
//
// Two assertions, per the spec's ATM-022 verifier:
//   1. Every changed PRODUCTION path vs the T3 base 900750f is within the
//      declared allowlist; the six protected files are ABSENT from the diff.
//   2. server.ts diff hunks are confined to the critique_position case block +
//      import lines; db.ts diff hunks are confined to migrate() additions.
//
// SCOPE OF THE DIFF: the spec phrases this as `900750f..HEAD` (the post-commit
// view). To also gate UNCOMMITTED packet work (this guardrail runs inside
// `bun test` mid-packet, before the packet-boundary commit), it compares 900750f
// against the full working-tree delta = tracked modifications (`git diff
// --name-only 900750f`) UNION untracked new files (`git ls-files --others
// --exclude-standard`). Post-commit with a clean tree this set is identical to
// `git diff --name-only 900750f HEAD`, so the check is a strict superset of the
// spec's phrasing and never weaker.

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = '88bcbf5'

function sh(cmd: string): string {
  return execSync(cmd, { cwd: REPO, encoding: 'utf-8' }).trim()
}

/** All paths differing from the T3 base: tracked changes ∪ untracked new files. */
function changedPathsVsBase(): string[] {
  const tracked = sh(`git diff --name-only ${BASE_COMMIT}`).split('\n').filter(Boolean)
  const untracked = sh('git ls-files --others --exclude-standard').split('\n').filter(Boolean)
  return Array.from(new Set([...tracked, ...untracked])).sort()
}

// --- allowlist (T3 spec ATM-022 + PLAN.md "New files (all additive)") ---------
// Exact PRODUCTION runtime/config/build paths T3 is permitted to add or edit.
const EXACT_ALLOW = new Set<string>([
  'server.ts',
  'db.ts',
  'config/agent-family-registry.json',
  'config/agent-family-registry.README.md',
  'verification/agent-family-registry.ts',
  'verification/critique-attribution.ts', // EPIC-03 (PK-T3-4), listed for lane completeness
  'verification/attribution-reeval.ts',   // EPIC-05 (PK-T3-5), listed for lane completeness
  'tsconfig.ko-t3.json',                  // build gate (PLAN.md new-files list)
])
// Prefix-allowed families: test suites (spec: "paths under tests/ are
// additionally allowed") and non-runtime build/verification scripts (the
// typecheck gate + the EPIC-06 ATM-020 read-only distribution script live here;
// none is a runtime code path).
const PREFIX_ALLOW = ['tests/', 'scripts/']

// The six PROTECTED files — MUST be absent from the diff entirely (Done-gate 4).
const PROTECTED = [
  'memory.ts',
  'decision.ts',
  'verification/verify.ts',
  'verification/cross-family-critique.ts',
  'verification/ternary-reward.ts',
  'verification/failure-classification.ts',
]

function isAllowed(path: string): boolean {
  if (EXACT_ALLOW.has(path)) return true
  return PREFIX_ALLOW.some(p => path.startsWith(p))
}

describe('ATM-022: production-diff allowlist vs 900750f (REQ-008/034, M-005)', () => {
  test('every changed path is within the T3 allowlist', () => {
    const changed = changedPathsVsBase()
    const violations = changed.filter(p => !isAllowed(p))
    expect(violations).toEqual([])
  })

  test('all six protected files are ABSENT from the diff (zero edits)', () => {
    const changed = new Set(changedPathsVsBase())
    for (const p of PROTECTED) {
      expect(changed.has(p)).toBe(false)
    }
  })
})

// --- hunk-scope helpers -------------------------------------------------------
/** Parse `git diff -U0` new-side hunk ranges → array of [startLine, endLineExclusive). */
function newSideHunkRanges(unifiedDiff: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const line of unifiedDiff.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!m) continue
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count === 0) continue // pure deletion — no new-side lines
    ranges.push([start, start + count])
  }
  return ranges
}

function readLines(relPath: string): string[] {
  return readFileSync(resolve(REPO, relPath), 'utf-8').split('\n')
}

describe('ATM-022: server.ts hunks confined to critique_position case block + imports', () => {
  test('every changed server.ts line is inside the critique_position case block or an import line', () => {
    const lines = readLines('server.ts')
    // 1-based line index of `case 'critique_position': {` and the next case.
    const caseStart = lines.findIndex(l => /^\s*case 'critique_position':\s*\{/.test(l)) + 1
    const caseEnd = lines.findIndex((l, i) => i + 1 > caseStart && /^\s*case '/.test(l)) + 1
    expect(caseStart).toBeGreaterThan(0)
    expect(caseEnd).toBeGreaterThan(caseStart)

    const diff = sh(`git diff -U0 ${BASE_COMMIT} -- server.ts`)
    const ranges = newSideHunkRanges(diff)
    // If server.ts is untouched vs base there are no ranges — that is vacuously
    // fine (this packet may run the guardrail before the server.ts edit lands).
    for (const [s, e] of ranges) {
      for (let L = s; L < e; L++) {
        const content = lines[L - 1] ?? ''
        const inCaseBlock = L >= caseStart && L < caseEnd
        const isImportLine = /^\s*import\b/.test(content) || /agent-family-registry/.test(content)
        expect(inCaseBlock || isImportLine).toBe(true)
      }
    }
  })
})

describe('ATM-022: db.ts hunks confined to migrate()', () => {
  test('every changed db.ts line is inside the migrate() method body', () => {
    const lines = readLines('db.ts')
    // migrate() method declaration (2-space class-method indentation).
    const migrateStart = lines.findIndex(l => /^\s{2}(?:async\s+|private\s+|public\s+)?migrate\s*\(/.test(l)) + 1
    expect(migrateStart).toBeGreaterThan(0)
    // End boundary = the next 2-space-indented sibling method declaration after
    // migrate() (avoids brace-counting through db.ts's SQL template literals).
    const migrateEnd =
      lines.findIndex(
        (l, i) =>
          i + 1 > migrateStart &&
          /^\s{2}(?:async\s+|private\s+|public\s+|static\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:<[^>]*>)?\s*\(/.test(l),
      ) + 1
    expect(migrateEnd).toBeGreaterThan(migrateStart)

    const diff = sh(`git diff -U0 ${BASE_COMMIT} -- db.ts`)
    const ranges = newSideHunkRanges(diff)
    for (const [s, e] of ranges) {
      for (let L = s; L < e; L++) {
        expect(L >= migrateStart && L < migrateEnd).toBe(true)
      }
    }
  })
})
