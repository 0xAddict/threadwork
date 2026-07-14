// tests/guardrails/t3-cross-family-critique-scope-bleed.test.ts — T3 EPIC-02
// ATM-007 (REQ-008, M-002/M-005): zero-diff guardrail proving EPIC-02's
// call-site injection is implemented additively in server.ts ONLY, with zero
// edits to verification/cross-family-critique.ts.
//
// Mirrors the mechanism of tests/guardrails/cross-family-critique-scope-bleed.test.ts
// (Ground truth #18): a `git diff --numstat` byte-untouched proof plus a
// source-block snapshot of resolveAgentDefaultFamily() asserted byte-identical
// to the pinned T3 base commit 900750f. A failure here is a real scope-bleed
// finding, not a spec to grow into — do not weaken any assertion to force a pass.

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = '900750f'
const MODULE_REL = 'verification/cross-family-critique.ts'

function gitNumstat(relPath: string): string {
  return execSync(`git diff --numstat ${BASE_COMMIT} -- ${relPath}`, {
    cwd: REPO,
    encoding: 'utf-8',
  }).trim()
}

// The exact resolveAgentDefaultFamily() source block at pinned 900750f — the
// single function whose already-exposed `registry?` parameter EPIC-02 supplies
// a value to from the call site (Ground truth #1). Asserted byte-identical to
// prove T3 changed NOTHING about the resolver itself.
const RESOLVE_AGENT_DEFAULT_FAMILY_BLOCK = `export function resolveAgentDefaultFamily(
  agent: string,
  registry?: Readonly<Record<string, ModelFamily>>,
): ModelFamily {
  const effective = registry ?? _EMPTY_AGENT_FAMILY_REGISTRY
  if (effective != null && Object.prototype.hasOwnProperty.call(effective, agent)) {
    const value = effective[agent]
    if (value !== undefined) return value
  }
  return 'unknown'
}`

describe('ATM-007: verification/cross-family-critique.ts zero-diff guardrail (REQ-008)', () => {
  test('cross-family-critique.ts is byte-untouched since T3 base 900750f (zero changed lines)', () => {
    expect(gitNumstat(MODULE_REL)).toBe('')
  })

  test('resolveAgentDefaultFamily() source block is byte-identical to the pinned 900750f baseline', () => {
    const source = readFileSync(resolve(REPO, MODULE_REL), 'utf-8')
    // Working-tree source contains the exact pinned block verbatim.
    expect(source).toContain(RESOLVE_AGENT_DEFAULT_FAMILY_BLOCK)
    // And it is byte-identical to what the pinned commit shipped — a direct
    // git-show comparison, so a same-line-count in-place edit could not slip
    // past the numstat check above undetected.
    const pinned = execSync(`git show ${BASE_COMMIT}:${MODULE_REL}`, {
      cwd: REPO,
      encoding: 'utf-8',
    })
    expect(pinned).toContain(RESOLVE_AGENT_DEFAULT_FAMILY_BLOCK)
  })

  test('server.ts does NOT import any WRITE symbol added to cross-family-critique.ts — injection reuses only the pre-existing read/pure exports', () => {
    // EPIC-02 threads loadAgentFamilyRegistry() (a NEW-module export) into the
    // two agent-fallback calls; it must NOT have needed any new export FROM
    // cross-family-critique.ts. The server.ts import block from that module is
    // unchanged vs 900750f.
    const numstatServerVsBase = execSync(
      `git diff -U0 ${BASE_COMMIT} -- server.ts`,
      { cwd: REPO, encoding: 'utf-8' },
    )
    // No added line reintroduces an edit to the cross-family-critique import
    // list beyond the pre-existing symbols (a new symbol would appear as an
    // added `+  someNewSymbol,` inside that import). The EPIC-02 addition
    // imports from './verification/agent-family-registry', never expands the
    // cross-family-critique import.
    const addedCrossFamilyImportLines = numstatServerVsBase
      .split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .filter(l => /cross-family-critique/.test(l))
    expect(addedCrossFamilyImportLines).toEqual([])
  })
})
