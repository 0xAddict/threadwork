/*
 * tests/guardrails/retention-prune-diff-scope.guard.test.ts
 *
 * T1 KO-SWEEP (#10376215) — ATM-015 (REQ-016 / M-014).
 *
 * The PRODUCTION diff of this lane touches ONLY db.ts and server.ts. New test
 * files under tests/ are permitted and expected; the ko-t1 tooling
 * (scripts/typecheck-ko-t1.sh, tsconfig.ko-t1.json) is non-production and
 * exempt. The protected files (verification/*.ts, decision.ts, memory.ts) must
 * be byte-untouched since the lane base (4db813f, postscrub).
 *
 * "Production file" here = a tracked-or-untracked `.ts` file not under tests/.
 * The diff is taken working-tree-vs-base so the guard is valid both before and
 * after the packet-boundary commit.
 */

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE = '4db813f'

function sh(cmd: string): string {
  return execSync(cmd, { cwd: REPO, encoding: 'utf-8' }).trim()
}

// Tracked files changed vs base (working tree), plus untracked (new) files.
function changedProductionTsFiles(): string[] {
  const tracked = sh(`git diff --name-only ${BASE} --`).split('\n').filter(Boolean)
  const untracked = sh('git ls-files --others --exclude-standard').split('\n').filter(Boolean)
  const all = [...new Set([...tracked, ...untracked])]
  return all.filter(f => f.endsWith('.ts') && !f.startsWith('tests/'))
}

describe('ATM-015: production diff scope ⊆ {db.ts, server.ts}', () => {
  test('every changed production .ts file is db.ts or server.ts', () => {
    const prod = changedProductionTsFiles()
    const allowed = new Set(['db.ts', 'server.ts'])
    const strays = prod.filter(f => !allowed.has(f))
    expect(strays).toEqual([])
    // Sanity: this lane DID additively change both files.
    expect(prod).toContain('db.ts')
    expect(prod).toContain('server.ts')
  })

  test('protected files are byte-untouched since base 4db813f', () => {
    const protectedDiff = sh(
      `git diff --name-only ${BASE} -- decision.ts memory.ts verification/`,
    )
    expect(protectedDiff).toBe('')
  })
})
