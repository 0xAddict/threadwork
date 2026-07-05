/**
 * P4 — Anti-laundering memory sanitization, Stage 1 (#10376048).
 *
 * `sanitizeMemoryContent` sweeps DETECTION_PATTERNS (memory-integrity-patterns.ts)
 * over a memory's content and neutralizes any adversarial trigger tokens it finds
 * (fake role headers, "ignore instructions" phrasing, embedded fake tool-call
 * strings, forged trust markers). It is a pure function: no db access, no I/O.
 *
 * Frozen contract (P5 depends on this exactly — see build brief):
 *   sanitizeMemoryContent(content: string, ctx: SanitizeContext): SanitizeResult
 *   SanitizeContext = { sourceType: SourceType }
 *   SanitizeResult  = { text: string; neutralized: boolean; tripped?: string[] }
 *
 * This module also re-exports SourceType, Classification, and DetectionPattern
 * so P5 and other consumers can import everything they need from one place.
 *
 * Stage 1 scope: ONLY sanitizeMemoryContent + these types. sanitizeBootBriefing,
 * isClassificationElevation, and guardClassificationElevation are later stages
 * and are deliberately NOT implemented here.
 */
import type { SourceType, Classification } from './memory'
import { DETECTION_PATTERNS, type DetectionPattern } from './memory-integrity-patterns'

export type { SourceType, Classification, DetectionPattern }

export interface SanitizeContext {
  sourceType: SourceType
}

export interface SanitizeResult {
  text: string
  neutralized: boolean
  tripped?: string[]
}

export function sanitizeMemoryContent(content: string, ctx: SanitizeContext): SanitizeResult {
  let text = content
  const tripped: string[] = []

  for (const pattern of DETECTION_PATTERNS) {
    if (pattern.agentTierOnly && ctx.sourceType === 'system') continue

    // Clone the regex per-application: defends against any accidental lastIndex
    // statefulness across calls/patterns even though a fresh String.replace on a
    // global regex already resets lastIndex per the spec.
    const re = new RegExp(pattern.regex.source, pattern.regex.flags)
    let matched = false
    const next = text.replace(re, (m) => {
      matched = true
      return pattern.transform(m)
    })

    if (matched) {
      tripped.push(pattern.id)
      text = next
    }
  }

  if (tripped.length === 0) {
    // Byte-identical to input — no normalization, no trimming.
    return { text: content, neutralized: false }
  }

  return { text, neutralized: true, tripped }
}
