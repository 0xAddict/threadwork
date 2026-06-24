/**
 * src/inhibit/index.ts — re-export wrapper for the root inhibit-engine.ts
 *
 * Sprint 4 §EXT-1: emit.log cross-cutting backfill.
 * The InhibitEngine implementation lives at the root (inhibit-engine.ts) for
 * Sprint-1 compatibility. This wrapper re-exports it and provides the emit-log
 * integration point required by C0.14.
 */

// emit-log import required by C0.14 cross-cutting contract
export { writeEmitLog } from '../alert-review/emit-log.js'

// Re-export the inhibit engine from root
// (Sprint-1 code uses the root path directly; this is additive)
export type { InhibitRule, InhibitRuleFile, MatchResult } from '../../inhibit-engine.js'
