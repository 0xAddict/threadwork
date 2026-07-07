// P4 — Anti-laundering memory sanitization, Stage 1 (#10376048).
// ATM-028: signature lock. This file is BOTH a trivial bun test (runtime no-op)
// AND a tsc compile-time target (see tsconfig.p4.json / scripts/typecheck-p4.sh).
//
// P5 depends on sanitizeMemoryContent having EXACTLY this two-argument shape —
// (content: string, ctx: SanitizeContext) => SanitizeResult, no `db` parameter,
// ever. If a future edit widens/narrows this signature, `tsc -p tsconfig.p4.json`
// must fail here before it fails downstream in P5.

import { test, expect } from 'bun:test'
import { sanitizeMemoryContent } from '../memory-integrity'
import type { SanitizeContext, SanitizeResult, SourceType } from '../memory-integrity'

// Compile-time-only shapes: these are never invoked, only type-checked. Naming
// them `_` prefixes signals "unused by design" to both eslint and tsc's noUnused
// checks (noUnusedLocals/Parameters are intentionally left off in tsconfig.p4.json
// for this reason — see that file's comment).
function _typeLockCallShape(x: string, y: SourceType): SanitizeResult {
  // The EXACT call shape frozen by the brief: sanitizeMemoryContent(x as string, { sourceType: y as SourceType })
  const result: SanitizeResult = sanitizeMemoryContent(x as string, { sourceType: y as SourceType })
  return result
}

function _typeLockResultShape(r: SanitizeResult): { text: string; neutralized: boolean } {
  // Type-level assertion: the return has at least `text: string` and `neutralized: boolean`.
  const text: string = r.text
  const neutralized: boolean = r.neutralized
  return { text, neutralized }
}

function _typeLockContextShape(ctx: SanitizeContext): SourceType {
  // SanitizeContext = { sourceType: SourceType } — exactly one required field.
  return ctx.sourceType
}

// Silence "declared but never read" for the type-lock functions above without
// disabling any tsc strictness flags: reference them from a const tuple.
void ([_typeLockCallShape, _typeLockResultShape, _typeLockContextShape] as const)

test('ATM-028: signature lock compiles and the runtime call shape matches', () => {
  // Runtime body is trivial by design (ATM-028): the real assertion is that this
  // whole file type-checks cleanly under tsconfig.p4.json / typecheck-p4.sh.
  const result = sanitizeMemoryContent('hello world', { sourceType: 'agent' })
  expect(typeof result.text).toBe('string')
  expect(typeof result.neutralized).toBe('boolean')
})
