// tests/guardrails/t3-production-diff-allowlist.test.ts — T3 ATM-022
// (REQ-008/REQ-011/REQ-034, M-005): production-diff allowlist guardrail that
// covers ALL protected files by construction, augmenting the source-block
// spot-checks in ATM-007 (and, later, ATM-010).
//
// Two assertions, per the spec's ATM-022 verifier:
//   1. Every changed PRODUCTION path within T3's frozen era 88bcbf5..c47a6c6 is
//      within the declared allowlist; the six protected files are ABSENT from the diff.
//   2. server.ts diff hunks are confined to the critique_position case block +
//      import lines; db.ts diff hunks are confined to migrate() additions.
//
// SCOPE OF THE DIFF (ERA-FREEZE DOUBLE-PIN — boss ruling #10376214): T3's allowlist
// invariant is a property of T3's OWN era, which is now immutable history. The
// allowlist diff is DOUBLE-PINNED to the commit range BASE_COMMIT..TIP_COMMIT
// (88bcbf5 -> c47a6c6, T3's merge commit), NOT the live working tree. So the
// assertion is a frozen historical invariant: it still trips on a T3-history
// rewrite, but can NEVER collide with a sibling lane (e.g. T4) stacked on top of
// T3. (Previously it single-pinned BASE and diffed to the CURRENT head, which
// structurally tripped on every lane merged after T3.) The two hunk-confinement
// describes further down are ALSO double-pinned to this same frozen range — their
// diffs use BASE_COMMIT..TIP_COMMIT and their line anchors are read via
// linesAt(TIP_COMMIT, ...) — so they too are sibling-lane-immune and trip only on a
// T3-history rewrite, NOT on a stacked lane's mere presence.

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = '88bcbf5'
const TIP_COMMIT = 'c47a6c6' // T3's merge commit — era-freeze tip pin (boss ruling, KO-sweep T4 merge #10376214)

function sh(cmd: string): string {
  return execSync(cmd, { cwd: REPO, encoding: 'utf-8' }).trim()
}

/**
 * All PRODUCTION paths changed within T3's OWN era — the frozen commit range
 * BASE_COMMIT..TIP_COMMIT (88bcbf5 -> c47a6c6, T3's merge commit). DOUBLE-PINNED
 * to immutable history (NOT the live working tree) so the invariant can never
 * collide with a sibling lane stacked on top of T3 (boss era-freeze ruling,
 * #10376214). The untracked-files union is intentionally dropped: a two-endpoint
 * commit range has no working-tree/untracked component.
 */
function changedPathsVsBase(): string[] {
  return sh(`git diff --name-only ${BASE_COMMIT} ${TIP_COMMIT}`).split('\n').filter(Boolean).sort()
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

describe('ATM-022: production-diff allowlist vs T3 era 88bcbf5..c47a6c6 (REQ-008/034, M-005)', () => {
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

/** File content AS AT a commit (frozen), split into lines. The hunk-scope line
 *  anchors below are computed against the SAME endpoint the diff is pinned to
 *  (TIP_COMMIT=c47a6c6), decoupling the assertion from any stacked lane's working
 *  tree (boss era-freeze ruling, #10376214). */
function linesAt(commit: string, relPath: string): string[] {
  return execSync(`git show ${commit}:${relPath}`, { cwd: REPO, encoding: 'utf-8' }).split('\n')
}

describe('ATM-022: server.ts hunks confined to critique_position case block + imports', () => {
  test('every changed server.ts line is inside the critique_position case block or an import line', () => {
    const lines = linesAt(TIP_COMMIT, 'server.ts')
    // 1-based line index of `case 'critique_position': {` and the next case.
    const caseStart = lines.findIndex(l => /^\s*case 'critique_position':\s*\{/.test(l)) + 1
    const caseEnd = lines.findIndex((l, i) => i + 1 > caseStart && /^\s*case '/.test(l)) + 1
    expect(caseStart).toBeGreaterThan(0)
    expect(caseEnd).toBeGreaterThan(caseStart)

    const diff = sh(`git diff -U0 ${BASE_COMMIT} ${TIP_COMMIT} -- server.ts`)
    const ranges = newSideHunkRanges(diff)
    // Under the frozen BASE..TIP range server.ts always has ranges (T3's edit is
    // in-range); the zero-range branch is retained only as a defensive no-op.
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
    const lines = linesAt(TIP_COMMIT, 'db.ts')
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

    const diff = sh(`git diff -U0 ${BASE_COMMIT} ${TIP_COMMIT} -- db.ts`)
    const ranges = newSideHunkRanges(diff)
    for (const [s, e] of ranges) {
      for (let L = s; L < e; L++) {
        expect(L >= migrateStart && L < migrateEnd).toBe(true)
      }
    }
  })
})
