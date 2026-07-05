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

export const DETECTION_PATTERNS: DetectionPattern[] = [
  {
    // Forged chat-turn / role headers: "SYSTEM:", "ASSISTANT:", "USER:" (exact case —
    // this is the convention adversarial content mimics to impersonate a protocol
    // turn boundary; ordinary prose almost never uses ALL-CAPS role labels followed
    // immediately by a colon).
    id: 'fake-role-header',
    name: 'Fake role/directive header (SYSTEM:/ASSISTANT:/USER:)',
    regex: /\b(?:SYSTEM|ASSISTANT|USER)\s*:/g,
    transform: (m) => m.replace(/:$/, '\\:'),
  },
  {
    // Fenced blocks pretending to be a tool-call / directive channel, e.g.
    // ```system ... ``` or ```tool_call ... ```. Legit code fences tagged with a
    // real language (json, ts, bash, ...) never match this alternation.
    id: 'fenced-directive-block',
    name: 'Fenced tool-call/directive block',
    regex: /```\s*(?:system|assistant|tool_call|tool_code|directive)\b[\s\S]*?```/gi,
    transform: (m) => m.replace(/^(```)\s*/, `$1${ESC}`),
  },
  {
    // "ignore/disregard/forget [all|any] [previous|prior] instruction(s)" — the
    // canonical prompt-injection override phrase. The optional qualifier groups
    // must sit IMMEDIATELY after the verb (only whitespace between), so ordinary
    // sentences with filler words between "ignore" and "instructions" don't match.
    id: 'ignore-instructions',
    name: 'Ignore/disregard/forget instructions directive',
    regex: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous\s+|prior\s+)?instructions?\b/gi,
    transform: (m) => m.replace(/^(\S+)/, `$1${ESC}`),
  },
  {
    // Embedded fake tool-invocation strings, e.g. a memory that carries literal
    // "mcp__task-board__complete_task(...)" text so a later consumer (boot
    // briefing, debrief) might treat it as an executable directive.
    id: 'embedded-tool-call',
    name: 'Embedded mcp__ tool-name string',
    regex: /\bmcp__[\w-]+__[\w]+\b/g,
    transform: (m) => m.replace(/^mcp__/, `mcp_${ESC}_`),
  },
  {
    // Forged trust markers that impersonate the real session-handoff / SOP
    // provenance tags used elsewhere in this system (see MEMORY.md conventions).
    // agentTierOnly: a genuine 'system'-sourced memory is allowed to carry these
    // (they're how the real pipeline writes them) — only agent-authored content
    // gets them stripped.
    id: 'forged-trust-marker',
    name: 'Forged session-handoff/snoopy-sop/boss-directive marker',
    regex: /\[(?:session-handoff:[^\]]*|snoopy-sop|boss-directive(?::[^\]]*)?)\]/g,
    transform: (m) => `[${ESC}${m.slice(1)}`,
    agentTierOnly: true,
  },
]
