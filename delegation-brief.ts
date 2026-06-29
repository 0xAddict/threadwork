/**
 * P3 — Curated Delegation Briefs (#10060822).
 * Spec: specs/P3-delegation-briefs-frontier-alignment.md (LOCKED @ c5d382f).
 * Measure-first study that motivates this shape: #10060825 (artifacts/10060825/).
 *
 * Frontier target (spec §2): at delegation time the delegator hands the delegatee a
 * task-specific, CURATED, FILTERED, BOOKENDED brief — a bounded subset of the relevant
 * facts — NOT a full-context dump. The study proved full-context inheritance is
 * pathological on threadwork (~759k tokens / ~97% noise), so the anti-dump guard is the
 * whole point, and ~1/3 of delegations are self-contained (no brief at all).
 *
 * Design discipline (spec §6):
 *  - ADDITIVE + backward-compatible. The caller gates ALL of this behind the default-OFF
 *    `delegation_briefs_enabled` flag, so a delegation with the flag OFF behaves
 *    byte-for-byte as it did at 10929bd (AC-5).
 *  - REUSE the shipped P0 recall path AS-IS. Relevance selection routes through
 *    `MemoryDB.recallAugmented()` (which internally calls `recall()`); this module adds
 *    NO retrieval logic and does NOT modify the retrieval stack (AC-3 / AC-9).
 *  - HARD caps: at most N memories (count cap) AND a byte budget (anti-dump, PC-5/AC-8).
 */
import type { MemoryDB, Memory } from './memory'
import type { TaskDB } from './db'

/** feature_flags row name. Default 0 (OFF). Seeded in TaskDB.migrate(). */
export const DELEGATION_BRIEFS_FLAG = 'delegation_briefs_enabled'

/** Count cap: at most this many relevant memories. Study verdict → N≈8. */
export const BRIEF_MAX_MEMORIES = 8
/** Byte budget for the whole rendered brief (anti-dump hard ceiling). ~2k tokens. */
export const BRIEF_MAX_BYTES = 8000
/** Per-item clip so one giant memory/result can't blow the budget. */
export const BRIEF_PER_ITEM_MAX_CHARS = 600

const enc = new TextEncoder()
/** UTF-8 byte length (the unit the anti-dump cap is measured in). */
export function byteLen(s: string): number {
  return enc.encode(s).length
}

/** Collapse whitespace and clip to `max` chars (adds an ellipsis when clipped). */
function clip(s: string, max = BRIEF_PER_ITEM_MAX_CHARS): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

// A minimal English function-word stoplist. The shipped FTS recall (memory.ts
// sanitizeFtsQuery) ORs *every* token — including function words like "the" — so a
// recalled memory can match the task description on a stopword alone. The relevance
// gate below therefore requires a shared DISTINCTIVE (content) token, not just any
// recall hit. This is a post-recall CURATION filter on already-retrieved rows; it does
// NOT touch the retrieval stack (AC-9) and implements PC-1's "filtered by relevance".
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one',
  'our', 'out', 'has', 'had', 'his', 'how', 'its', 'who', 'did', 'yes', 'use', 'this', 'that',
  'with', 'from', 'they', 'them', 'then', 'than', 'have', 'will', 'your', 'into', 'over', 'such',
  'also', 'only', 'when', 'what', 'which', 'were', 'been', 'being', 'does', 'done', 'each', 'more',
  'most', 'some', 'other', 'their', 'there', 'these', 'those', 'about', 'would', 'could', 'should',
  'after', 'before', 'while', 'where', 'here', 'because', 'task', 'tasks', 'please', 'need', 'needs',
])

/** Distinctive (content-bearing) tokens: lowercased [a-z0-9_]+, length >= 3, non-stopword. */
function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of (text ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t)
  }
  return out
}

/** Clamp to [1, hi]. Used to make the count cap a HARD ceiling regardless of caller input. */
function clampInt(v: number | undefined, def: number, lo: number, hi: number): number {
  const n = Number.isFinite(v as number) ? Math.floor(v as number) : def
  return Math.max(lo, Math.min(hi, n))
}

/** Thrown when a brief (typically a delegator-supplied explicit one) exceeds the cap. */
export class DelegationBriefTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly maxBytes: number) {
    super(
      `Delegation brief is ${bytes} bytes, exceeding the ${maxBytes}-byte anti-dump cap. ` +
        `Pass a curated SUBSET of the relevant facts, not a full context dump (spec PC-5).`,
    )
    this.name = 'DelegationBriefTooLargeError'
  }
}

/** Anti-dump guard (PC-5/AC-8): reject anything over the byte ceiling. */
export function enforceAntiDumpBrief(text: string, maxBytes = BRIEF_MAX_BYTES): void {
  const b = byteLen(text)
  if (b > maxBytes) throw new DelegationBriefTooLargeError(b, maxBytes)
}

export interface DelegationBrief {
  /** Final rendered, bookended, byte-capped brief text (always <= maxBytes). */
  text: string
  /** 'auto' = recall-assembled; 'explicit' = delegator-supplied. */
  mode: 'auto' | 'explicit'
  /** Memory ids selected by recall for this brief (the filtered subset). */
  memoryIds: number[]
  /** UTF-8 byte length of `text`. */
  bytes: number
  /** True when context items were dropped to honor the byte budget. */
  truncated: boolean
}

const HEAD = '== DELEGATION BRIEF (curated subset — NOT a full context dump) =='
const L_CRIT = '[MOST CRITICAL]'
const L_CTX = '[CONTEXT]'
const L_RECAP = '[KEY POINTS — RECAP]'

/**
 * Bookended render (PC-1/AC-4): the most-critical lines appear at the HEAD and are
 * RECAPPED at the TAIL; lower-salience context fills the middle. The fixed bookends are
 * never dropped; only middle context is trimmed to honor `maxBytes`.
 */
function render(criticals: string[], context: string[], maxBytes: number): { text: string; truncated: boolean } {
  const critBlock = criticals.join('\n')
  const fixedHead = `${HEAD}\n\n${L_CRIT}\n${critBlock}\n\n${L_CTX}\n`
  const fixedTail = `\n\n${L_RECAP}\n${critBlock}`
  const budget = maxBytes - byteLen(fixedHead) - byteLen(fixedTail)

  const kept: string[] = []
  let used = 0
  let truncated = false
  for (const line of context) {
    const add = (kept.length ? 1 : 0) + byteLen(line)
    if (used + add > budget) {
      truncated = true
      break
    }
    kept.push(line)
    used += add
  }
  if (kept.length < context.length) {
    truncated = true
    const omitted = context.length - kept.length
    const marker = `…(${omitted} more context item${omitted === 1 ? '' : 's'} omitted by anti-dump cap)`
    if (used + (kept.length ? 1 : 0) + byteLen(marker) <= budget) kept.push(marker)
  }

  return { text: fixedHead + kept.join('\n') + fixedTail, truncated }
}

export interface AssembleBriefOpts {
  /** The delegator (whose memory pool is curated from). */
  from: string
  /** The task description — the recall query AND the brief's anchor. */
  taskDescription: string
  /** Parent task id, when delegating a child task (adds parent context). */
  parentTaskId?: number
  /** Explicit hard constraints / DO-NOTs (always treated as critical). */
  constraints?: string[]
  maxMemories?: number
  maxBytes?: number
}

/**
 * Auto-assemble a curated, bookended delegation brief (PC-1).
 *
 * Returns `null` when NOTHING clears the relevance bar (RELEVANCE GATE): no relevant
 * memories, no parent context, no constraints. ~1/3 of delegations are expected to be
 * self-contained and therefore get no brief at all (study #10060825).
 */
export async function assembleDelegationBrief(
  mem: MemoryDB,
  db: TaskDB,
  opts: AssembleBriefOpts,
): Promise<DelegationBrief | null> {
  // HARD caps (AC-2/AC-8): clamp to ceilings so a caller cannot widen the count/byte cap.
  const maxMemories = clampInt(opts.maxMemories, BRIEF_MAX_MEMORIES, 1, BRIEF_MAX_MEMORIES)
  const maxBytes = clampInt(opts.maxBytes, BRIEF_MAX_BYTES, 1, BRIEF_MAX_BYTES)
  const q = (opts.taskDescription ?? '').trim()

  // Relevance subset via the SHIPPED recall path (AC-3). recallAugmented() calls
  // recall() internally; we add no retrieval logic. Scope = the delegator's own pool.
  let recalled: Memory[] = []
  if (q) {
    recalled = await mem.recallAugmented(opts.from, { query: q, limit: maxMemories })
  }

  // RELEVANCE FILTER (PC-1): keep only recalled rows that share a DISTINCTIVE token with
  // the task description. Defends the gate against FTS stopword-only matches (e.g. "the")
  // since sanitizeFtsQuery ORs every token. Post-recall curation only — no retrieval change.
  const qTokens = distinctiveTokens(q)
  if (qTokens.size > 0) {
    recalled = recalled.filter((m) => {
      for (const t of distinctiveTokens(m.content)) if (qTokens.has(t)) return true
      return false
    })
  } else {
    recalled = [] // no distinctive query terms ⇒ relevance cannot be established.
  }
  // Hard count cap post-filter (defense-in-depth; recall's limit already applies it).
  if (recalled.length > maxMemories) recalled = recalled.slice(0, maxMemories)

  // Parent-task context (PC-1b): parent description/result + parent finding summaries.
  const parentLines: string[] = []
  if (opts.parentTaskId != null) {
    const parent = db.getTask(opts.parentTaskId)
    if (parent) {
      parentLines.push(`Parent task #${parent.id}: ${clip(parent.description)}`)
      if (parent.result) parentLines.push(`Parent result so far: ${clip(parent.result)}`)
      // Parent AND sibling findings (blackboard) when present — capped + clipped (PC-1).
      const findings = db.readParentAndSiblingFindings(opts.parentTaskId, 4)
      for (const f of findings) {
        if (!f?.summary) continue
        const label = f.task_id === opts.parentTaskId ? 'Parent finding' : `Sibling finding (#${f.task_id})`
        parentLines.push(`${label} [${f.finding_type ?? 'note'}]: ${clip(f.summary)}`)
      }
    }
  }

  const constraints = (opts.constraints ?? []).map((c) => clip(c)).filter((c) => c.length > 0)

  // RELEVANCE GATE (PC-1): emit NO brief when nothing cleared the bar.
  if (recalled.length === 0 && parentLines.length === 0 && constraints.length === 0) {
    return null
  }

  // Bookend criticals = constraints (always critical) + the single top-ranked memory.
  const criticals: string[] = []
  for (const c of constraints) criticals.push(`! ${c}`)
  const top = recalled[0]
  if (top) criticals.push(`#${top.id} [${top.category}] ${clip(top.content)}`)
  if (criticals.length === 0) {
    // Only parent context exists — promote its first line so the brief still has an anchor.
    criticals.push(parentLines.shift() as string)
  }

  // Middle (lower salience): remaining memories + parent context.
  const context: string[] = []
  for (const m of recalled.slice(1)) context.push(`#${m.id} [${m.category}] ${clip(m.content)}`)
  for (const p of parentLines) context.push(p)

  const { text, truncated } = render(criticals, context, maxBytes)
  enforceAntiDumpBrief(text, maxBytes) // defense-in-depth; should never throw on the auto path.

  return {
    text,
    mode: 'auto',
    memoryIds: recalled.map((m) => m.id),
    bytes: byteLen(text),
    truncated,
  }
}

/**
 * Wrap a delegator-supplied explicit brief (PC-2). The hard anti-dump cap (AC-8) is
 * enforced FIRST: a full-context dump is rejected. The delegator's content is preserved
 * verbatim and lightly bookended (headline recapped at head + tail); if the bookend
 * scaffolding would tip it over the cap, the verbatim (already-capped) brief is used.
 */
export function buildExplicitBrief(explicit: string, maxBytes = BRIEF_MAX_BYTES): DelegationBrief {
  const cap = clampInt(maxBytes, BRIEF_MAX_BYTES, 1, BRIEF_MAX_BYTES)
  const trimmed = (explicit ?? '').trim()
  enforceAntiDumpBrief(trimmed, cap) // AC-8: reject a full-context dump outright.

  // Bookend the delegator's own brief: first non-empty line becomes the recapped headline;
  // remaining lines are the body. render() guarantees the headline survives at HEAD AND TAIL
  // even when the body must be trimmed to honor the byte budget (AC-4) — no silent fallback.
  const lines = trimmed.split('\n')
  const firstIdx = lines.findIndex((l) => l.trim().length > 0)
  const headline = clip(firstIdx >= 0 ? lines[firstIdx] : trimmed, 200)
  const body = lines.filter((_, i) => i !== firstIdx).map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0)
  const { text, truncated } = render([headline], body, cap)
  enforceAntiDumpBrief(text, cap) // final ceiling assertion (throws only for a pathologically tiny cap).

  return { text, mode: 'explicit', memoryIds: [], bytes: byteLen(text), truncated }
}
