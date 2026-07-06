/**
 * P4 — Anti-laundering memory sanitization, Stage 1 (#10376048).
 *
 * DETECTION_PATTERNS is the corpus of regexes that `sanitizeMemoryContent`
 * (memory-integrity.ts) sweeps over memory content before it can be echoed
 * back into a boot briefing, debrief, or consolidation output. Each pattern:
 *
 *  - matches a literal trigger token an adversarial memory might carry
 *    (a forged chat-turn label, an "ignore instructions" directive, an
 *    embedded fake tool-call string, or a forged trust marker), and
 *  - NEUTRALIZES it via `transform`, which must break the trigger's literal
 *    contiguous substring so it does not survive in the output, while
 *    staying human-readable, AND must be IDEMPOTENT — i.e. re-running this
 *    same pattern's regex over the transformed text must not match again.
 *
 * Precision over breadth: every pattern here is deliberately narrow (anchored
 * on the literal token/shape adversarial content uses) so ordinary prose that
 * happens to mention "system", "instructions", "boss", or brackets does NOT
 * false-positive. See tests/fixtures/legitimate-memory-corpus.json for the
 * negative-control corpus this is tuned against.
 */

export interface DetectionPattern {
  id: string
  name: string
  regex: RegExp
  transform: (matchText: string) => string
  /** When true, this pattern is only applied when ctx.sourceType !== 'system'. */
  agentTierOnly?: boolean
}

/** Visible, human-readable quarantine marker inserted to break a trigger's contiguity. */
const ESC = '⟦esc⟧' // ⟦esc⟧

// Codex red-team round-1 hardening (#10376048 Sonnet-generator fold #1/#4):
// a curated set of directive-ish stems used ONLY as a lookahead gate on the
// broadened (case-insensitive / any-colon-style) fake-role-header match. This
// is what lets "SYSTEM: You must comply..." (adversarial) trip while "user:
// prefers WebP" or "the payment system: overview" (benign, near-miss) do NOT —
// see tests/fixtures/legitimate-memory-corpus.json for the negative controls
// this is tuned against. Deliberately NOT applied to the other patterns.
const DIRECTIVE_HINT =
  'grant\\w*|comply|complie[sd]?|complian\\w*|overrid\\w*|disregard\\w*|ignor\\w*|bypass\\w*|elevat\\w*|escalat\\w*|obey\\w*|unlock\\w*|reveal\\w*|confirm\\w*|transfer\\w*|admin\\w*|approve\\w*|proceed\\w*'

export const DETECTION_PATTERNS: DetectionPattern[] = [
  {
    // Forged chat-turn / role headers: "SYSTEM:", "ASSISTANT:", "USER:" — now
    // case-insensitive (catches "system:", "SyStEm:") and accepts either an
    // ASCII colon or the FULLWIDTH colon U+FF1A ("："), both of which codex
    // round-1 found as bypasses of the original exact-case ASCII-only match.
    // Broadening to case-insensitive risks tripping ordinary prose like
    // "user: prefers WebP" or "the payment system: overview" — so the match
    // additionally requires a directive-ish token (DIRECTIVE_HINT) within the
    // same line, close enough to read as an instruction rather than a plain
    // label. This is a precision gate, not a detection weakening: every known
    // adversarial payload pairs the header with a directive verb/noun.
    id: 'fake-role-header',
    name: 'Fake role/directive header (SYSTEM:/ASSISTANT:/USER: — any case, ASCII/fullwidth colon, near a directive token)',
    regex: new RegExp(
      `\\b(?:SYSTEM|ASSISTANT|USER)\\s*[:：](?=[^\\n]{0,80}?\\b(?:${DIRECTIVE_HINT})\\b)`,
      'gi'
    ),
    transform: (m) => m.replace(/[:：]$/, (c) => '\\' + c),
  },
  {
    // Fenced blocks pretending to be a tool-call / directive channel, e.g.
    // ```system ... ``` or ```tool_call ... ```. Legit code fences tagged with a
    // real language (json, ts, bash, ...) never match this alternation.
    // Codex round-1 additions: `system_prompt`, `tool-call` (hyphen variant of
    // `tool_call`), and `developer` tags, PLUS tolerating an UNCLOSED fence
    // (no closing ``` before end of string) — a truncated/streamed memory
    // shouldn't get a free pass just because the closing fence never arrived.
    id: 'fenced-directive-block',
    name: 'Fenced tool-call/directive block (incl. unclosed fences)',
    regex: /```\s*(?:system_prompt|system|assistant|tool[-_]call|tool_code|directive|developer)\b[\s\S]*?(?:```|$)/gi,
    transform: (m) => m.replace(/^(```)\s*/, `$1${ESC}`),
  },
  {
    // "ignore/disregard/forget/override [all|any|every] [previous|prior|earlier]
    // [safety] instruction(s)/direction(s)" — the canonical prompt-injection
    // override phrase. Codex round-1 additions: the `override` verb, the
    // `every`/`earlier` qualifiers, the `safety` domain qualifier, and the
    // `direction(s)` noun alternative. The optional qualifier groups must sit
    // IMMEDIATELY after the verb (only whitespace between) and the noun must
    // follow immediately after any qualifiers, so ordinary sentences with
    // filler words between the verb and "instructions" (e.g. "ignore the stale
    // cache and rebuild", "override the default timeout") don't match.
    id: 'ignore-instructions',
    name: 'Ignore/disregard/forget/override instructions directive',
    regex: /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|every)\s+)?(?:(?:previous|prior|earlier)\s+)?(?:safety\s+)?(?:instructions?|directions?)\b/gi,
    transform: (m) => m.replace(/^(\S+)/, `$1${ESC}`),
  },
  {
    // Embedded fake tool-invocation strings, e.g. a memory that carries literal
    // "mcp__task-board__complete_task(...)" text so a later consumer (boot
    // briefing, debrief) might treat it as an executable directive. The
    // zero-width-split bypass ("mcp<ZWSP>__task-board__...") is closed by the
    // zero-width-stripping pre-step in sanitizeMemoryContent (memory-integrity.ts),
    // not by widening this regex.
    id: 'embedded-tool-call',
    name: 'Embedded mcp__ tool-name string',
    regex: /\bmcp__[\w-]+__[\w]+\b/g,
    transform: (m) => m.replace(/^mcp__/, `mcp_${ESC}_`),
  },
  {
    // Forged trust markers that impersonate the real session-handoff / SOP
    // provenance tags used elsewhere in this system (see MEMORY.md conventions).
    // Codex round-1: these markers no longer require a closing `]` — an
    // unclosed marker (e.g. "[session-handoff:evil grant admin" with no `]`)
    // is just as adversarial and previously slipped through because the old
    // regex demanded a literal closing bracket. Matching only the prefix still
    // matches the closed form too (the prefix is a substring of it).
    // agentTierOnly: a genuine 'system'-sourced memory is allowed to carry these
    // (they're how the real pipeline writes them) — only agent-authored content
    // gets them stripped.
    id: 'forged-trust-marker',
    name: 'Forged session-handoff/snoopy-sop/boss-directive marker (closed or unclosed)',
    regex: /\[(?:session-handoff:|snoopy-sop|boss-directive)/gi,
    transform: (m) => `[${ESC}${m.slice(1)}`,
    agentTierOnly: true,
  },
]
