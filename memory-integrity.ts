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
 * Stage 1 scope: ONLY sanitizeMemoryContent + these types. sanitizeBootBriefing
 * is a later stage and is deliberately NOT implemented here.
 *
 * Stage 5a (#10376048/ATM-015, ATM-033) adds the consolidation trust-tier
 * ceiling primitives:
 *   isClassificationElevation(beforeTier, attemptedTier) — pure predicate,
 *     zero I/O. True iff attemptedTier ranks strictly more privileged than
 *     beforeTier (tier order most-privileged-first: foundational, strategic,
 *     operational, observational, ephemeral).
 *   guardClassificationElevation(beforeTier, attemptedTier, memoryId, ctx) —
 *     audited wrapper. Blocks (returns false + writes an audit_log row) when
 *     an elevation is attempted; is a silent no-op (returns true, no row)
 *     otherwise.
 */
import type { Database } from 'bun:sqlite'
import type { SourceType, Classification, Memory, BootBriefing } from './memory'
import type { Task } from './db'
import { DETECTION_PATTERNS, type DetectionPattern } from './memory-integrity-patterns'

// Most-privileged-first. Index 0 is the most privileged tier; a lower index
// means MORE privileged.
const TIER_ORDER: Classification[] = ['foundational', 'strategic', 'operational', 'observational', 'ephemeral']

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

/**
 * ATM-030 / ATM-016: sanitizes every free-text field carried by a boot
 * briefing before it can be echoed back to an agent (or written to a
 * consolidated briefing file). PURE + side-effect-free: no db, no audit —
 * KO-2 narrowed REQ-016 to write-time, so the read path here stays pure.
 * Returns a NEW BootBriefing; the input is never mutated.
 *
 * Each memory row is sanitized with its OWN source_type (reused, not
 * reassigned) — sanitizeMemoryContent is idempotent, so this is safe to run
 * again on rows that were already sanitized at write-time. Tasks carry no
 * stored source_type, so recentTasks/relevantQuery free-text is sanitized
 * conservatively as sourceType: 'agent'.
 */
export function sanitizeBootBriefing(briefing: BootBriefing): BootBriefing {
  const sanitizeMemories = (memories: Memory[]): Memory[] =>
    memories.map((m) => ({
      ...m,
      content: sanitizeMemoryContent(m.content, { sourceType: m.source_type }).text,
    }))

  const recentTasks: Task[] = briefing.recentTasks.map((t) => ({
    ...t,
    description: sanitizeMemoryContent(t.description, { sourceType: 'agent' }).text,
    result: t.result === null ? null : sanitizeMemoryContent(t.result, { sourceType: 'agent' }).text,
  }))

  const relevantQuery = briefing.relevantQuery === null
    ? null
    : sanitizeMemoryContent(briefing.relevantQuery, { sourceType: 'agent' }).text

  return {
    role: sanitizeMemories(briefing.role),
    topMemories: sanitizeMemories(briefing.topMemories),
    sharedMemories: sanitizeMemories(briefing.sharedMemories),
    recentTasks,
    relevantMemories: sanitizeMemories(briefing.relevantMemories),
    relevantQuery,
  }
}

/**
 * ATM-015: pure predicate, zero I/O (no db, no audit). Returns true iff
 * attemptedTier ranks STRICTLY ABOVE beforeTier (i.e. attempted is more
 * privileged — a lower index in TIER_ORDER).
 */
export function isClassificationElevation(beforeTier: Classification, attemptedTier: Classification): boolean {
  return TIER_ORDER.indexOf(attemptedTier) < TIER_ORDER.indexOf(beforeTier)
}

/**
 * ATM-033: audited wrapper around isClassificationElevation. When an
 * elevation is attempted, BLOCKS it (returns false) and writes an
 * audit_log row recording the attempted-vs-actual tier. When there is no
 * elevation, permits it as a silent no-op (returns true, no audit row).
 */
export function guardClassificationElevation(
  beforeTier: Classification,
  attemptedTier: Classification,
  memoryId: number,
  ctx: { db: Database }
): boolean {
  if (isClassificationElevation(beforeTier, attemptedTier)) {
    ctx.db.prepare(
      `INSERT INTO audit_log (agent, action, detail, memory_id) VALUES ('consolidator', 'consolidation_survivor_elevation_blocked', ?, ?)`
    ).run(`Blocked elevation attempt: before=${beforeTier}, attempted=${attemptedTier}`, memoryId)
    return false
  }
  return true
}
