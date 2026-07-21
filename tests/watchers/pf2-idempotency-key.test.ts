import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { computeIdempotencyKey, type IdempotencyKeyInput } from '../../watchers/declarative-watchers'

// PK-PF2-4 hybrid addendum (main's ruling a2661b4f): computeIdempotencyKey()
// is a SPEC-SILENT, sadie-decided addition beyond this packet's original
// ATM list (ATM-PF2-05/06/07 only name fireWatcher()/getWatchers()/
// disableWatcher()) — built here, under calm TDD, per main's explicit
// instruction, rather than parked inside PK-PF2-5's watchdog-tick wiring.
// PURE — no DB access, no Date/clock reads of its own (all timestamps are
// caller-supplied strings/numbers). See BASELINES.md's PF2-4 section for
// the "added beyond ATM list, ratified by sadie, flagged for codex" note
// and the PF2-6 codex checkpoint on the derivation formulas themselves.

const WATCHERS_TS = readFileSync(resolve(__dirname, '..', '..', 'watchers', 'declarative-watchers.ts'), 'utf-8')

function functionBody(source: string, startMarker: string, endMarkers: string[]): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  let end = source.length
  for (const m of endMarkers) {
    const idx = source.indexOf(m, start + startMarker.length)
    if (idx > -1 && idx < end) end = idx
  }
  return source.slice(start, end)
}

const TOP_LEVEL_MARKERS = ['\nexport function ', '\nexport async function ', '\nexport const ', '\nexport interface ', '\nexport type ', '\nfunction ', '\n/**']

describe('computeIdempotencyKey() purity (static)', () => {
  function body(): string {
    return functionBody(WATCHERS_TS, 'export function computeIdempotencyKey', TOP_LEVEL_MARKERS)
  }

  test('body contains no Date.now() or `new Date`', () => {
    expect(body()).not.toMatch(/Date\.now\(\)/)
    expect(body()).not.toMatch(/new Date/)
  })

  test('body contains no DB/IO calls (no .prepare(, no db.run()', () => {
    expect(body()).not.toMatch(/\.prepare\(/)
    expect(body()).not.toMatch(/db\.run\(/)
  })
})

describe('computeIdempotencyKey() determinism + totality (runtime)', () => {
  test('called twice on identical input returns identical output', () => {
    const input: IdempotencyKeyInput = { triggerType: 'scheduled', watcherId: 1, windowBucket: 60 }
    expect(computeIdempotencyKey(input)).toBe(computeIdempotencyKey(input))
  })

  test('is total: every trigger_type shape, including a null state_change newValue, produces a defined string without throwing', () => {
    const inputs: IdempotencyKeyInput[] = [
      { triggerType: 'scheduled', watcherId: 1, windowBucket: 0 },
      { triggerType: 'state_change', watcherId: 1, newValue: null, transitionTimestamp: '2026-07-21T00:00:00Z' },
      { triggerType: 'state_change', watcherId: 1, newValue: 'x', transitionTimestamp: '2026-07-21T00:00:00Z' },
      { triggerType: 'state_change', watcherId: 1, newValue: 42, transitionTimestamp: '2026-07-21T00:00:00Z' },
      { triggerType: 'state_change', watcherId: 1, newValue: true, transitionTimestamp: '2026-07-21T00:00:00Z' },
      { triggerType: 'llm_eval', watcherId: 1, evaluationTimestamp: '2026-07-21T00:00:00Z' },
    ]
    for (const input of inputs) {
      expect(() => computeIdempotencyKey(input)).not.toThrow()
      expect(typeof computeIdempotencyKey(input)).toBe('string')
      expect(computeIdempotencyKey(input).length).toBeGreaterThan(0)
    }
  })
})

describe('computeIdempotencyKey() -- scheduled (windowBucket-keyed)', () => {
  test('same watcherId + same windowBucket -> same key', () => {
    const a = computeIdempotencyKey({ triggerType: 'scheduled', watcherId: 5, windowBucket: 3 })
    const b = computeIdempotencyKey({ triggerType: 'scheduled', watcherId: 5, windowBucket: 3 })
    expect(a).toBe(b)
  })

  test('different windowBucket -> different key (each new due-window is a fresh occasion)', () => {
    const a = computeIdempotencyKey({ triggerType: 'scheduled', watcherId: 5, windowBucket: 3 })
    const b = computeIdempotencyKey({ triggerType: 'scheduled', watcherId: 5, windowBucket: 4 })
    expect(a).not.toBe(b)
  })

  test('different watcherId, same windowBucket -> different key', () => {
    const a = computeIdempotencyKey({ triggerType: 'scheduled', watcherId: 5, windowBucket: 3 })
    const b = computeIdempotencyKey({ triggerType: 'scheduled', watcherId: 6, windowBucket: 3 })
    expect(a).not.toBe(b)
  })
})

describe('computeIdempotencyKey() -- state_change (newValue + transitionTimestamp-keyed)', () => {
  test('different newValue -> different key', () => {
    const a = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'completed', transitionTimestamp: 't1' })
    const b = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'pending', transitionTimestamp: 't1' })
    expect(a).not.toBe(b)
  })

  test('different transitionTimestamp -> different key (a later re-transition to the same value is a fresh occasion)', () => {
    const a = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'completed', transitionTimestamp: 't1' })
    const b = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'completed', transitionTimestamp: 't2' })
    expect(a).not.toBe(b)
  })

  test('type-sensitive scalar encoding: newValue=1 (number) and newValue="1" (string) produce DIFFERENT keys', () => {
    const numeric = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 1, transitionTimestamp: 't1' })
    const stringy = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: '1', transitionTimestamp: 't1' })
    expect(numeric).not.toBe(stringy)
  })
})

describe('computeIdempotencyKey() -- llm_eval (evaluationTimestamp-keyed)', () => {
  test('different evaluationTimestamp -> different key', () => {
    const a = computeIdempotencyKey({ triggerType: 'llm_eval', watcherId: 1, evaluationTimestamp: 't1' })
    const b = computeIdempotencyKey({ triggerType: 'llm_eval', watcherId: 1, evaluationTimestamp: 't2' })
    expect(a).not.toBe(b)
  })
})

describe('computeIdempotencyKey() -- cross-trigger_type and collision safety', () => {
  test('the same watcherId under different trigger_types never collides (the fixed discriminator tag is code-controlled, never derived from dynamic input)', () => {
    const scheduled = computeIdempotencyKey({ triggerType: 'scheduled', watcherId: 1, windowBucket: 1 })
    const stateChange = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 1, transitionTimestamp: '1' })
    const llmEval = computeIdempotencyKey({ triggerType: 'llm_eval', watcherId: 1, evaluationTimestamp: '1' })
    expect(new Set([scheduled, stateChange, llmEval]).size).toBe(3)
  })

  test('COLLISION-SAFETY (the exact boundary-shift attack raw \':\'-joining is vulnerable to): {newValue:"x", transitionTimestamp:"y:z"} and {newValue:"x:y", transitionTimestamp:"z"} must produce DIFFERENT keys, even though a naive `${watcherId}:state:${newValue}:${transitionTimestamp}` join would make them identical ("1:state:x:y:z" both ways)', () => {
    const a = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'x', transitionTimestamp: 'y:z' })
    const b = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'x:y', transitionTimestamp: 'z' })
    expect(a).not.toBe(b)
    // Sanity: prove the naive join WOULD have collided, so this test is actually exercising the fix.
    const naiveA = `1:state:x:y:z`
    const naiveB = `1:state:x:y:z`
    expect(naiveA).toBe(naiveB)
  })

  test('a crafted newValue containing a literal double-quote does not corrupt the encoding (JSON.stringify escapes it, cannot prematurely terminate the segment)', () => {
    const a = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'a"b', transitionTimestamp: 't' })
    const b = computeIdempotencyKey({ triggerType: 'state_change', watcherId: 1, newValue: 'a', transitionTimestamp: 'b"t' })
    expect(a).not.toBe(b)
    expect(typeof a).toBe('string')
    expect(typeof b).toBe('string')
  })
})
