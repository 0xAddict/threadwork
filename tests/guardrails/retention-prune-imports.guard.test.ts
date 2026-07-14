/*
 * tests/guardrails/retention-prune-imports.guard.test.ts
 *
 * T1 KO-SWEEP (#10376215) — ATM-012 (REQ-013 / M-010), STATIC half.
 *
 * The whole Step-6 live prune runs inside T1's OWN local BEGIN IMMEDIATE
 * (the decision.ts pattern) and takes ZERO dependency on P5's shared-write
 * primitive. This guardrail slices the two Step-6 source regions (the module
 * helpers + the runHygiene Step-6 method, both sentinel-bracketed in db.ts) and
 * asserts neither references `withMemoryWriteTxn`, `isWriteTxnActive`, or
 * `memory-ordering`. (db.ts DOES mention those tokens elsewhere — in the memory
 * table DDL comments — so the assertion is deliberately scoped to the Step-6
 * regions, not the whole file.) The rollback half (mid-sequence error) lives in
 * tests/retention-prune.test.ts.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const DB_SOURCE = readFileSync(resolve(REPO, 'db.ts'), 'utf-8')

function sliceBetween(src: string, begin: string, end: string): string {
  const i = src.indexOf(begin)
  const j = src.indexOf(end)
  expect(i).toBeGreaterThanOrEqual(0)
  expect(j).toBeGreaterThan(i)
  return src.slice(i, j + end.length)
}

// Strip line + block comments so the forbidden-token scan checks CODE only —
// the region's own doc comments deliberately NAME the primitives they avoid.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

const FORBIDDEN = ['withMemoryWriteTxn', 'isWriteTxnActive', 'memory-ordering']

describe('ATM-012 static: Step-6 uses no P5 write-ordering primitive', () => {
  const helpers = sliceBetween(
    DB_SOURCE,
    '// ── T1 KO-SWEEP prune helpers (BEGIN) ──',
    '// ── T1 KO-SWEEP prune helpers (END) ──',
  )
  const method = sliceBetween(
    DB_SOURCE,
    '// ── T1 KO-SWEEP Step-6 method (BEGIN) ──',
    '// ── T1 KO-SWEEP Step-6 method (END) ──',
  )
  const step6Code = stripComments(helpers + '\n' + method)

  test('no forbidden P5 primitive appears in the Step-6 code', () => {
    for (const tok of FORBIDDEN) {
      expect(step6Code).not.toContain(tok)
    }
  })

  test('Step-6 opens its OWN local BEGIN IMMEDIATE and COMMIT/ROLLBACK', () => {
    expect(method).toContain("db.prepare('BEGIN IMMEDIATE').run()")
    expect(method).toContain("db.prepare('COMMIT').run()")
    expect(method).toContain("db.prepare('ROLLBACK').run()")
  })
})
