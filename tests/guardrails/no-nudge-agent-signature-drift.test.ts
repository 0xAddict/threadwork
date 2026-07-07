// tests/guardrails/no-nudge-agent-signature-drift.test.ts — ATM-023 (P5
// EPIC-07) regression lock.
//
// P5 Stage 7 adds send_directed_message/poll_directed_messages/
// ack_directed_message as a COMPLEMENTARY, additive typed message store
// (EPIC-06/EPIC-07). nudge_agent (the ephemeral tmux wake signal, no
// persistence, no ack) is explicitly OUT OF SCOPE for this work and must stay
// byte-identical.
//
// [R2-3 FIX, codex round-2 GENUINE HIGH] The PREVIOUS version of this test
// asserted `serverSrc.toContain(BASELINE_NUDGE_AGENT_TOOL_BLOCK)` /
// `nudgeSrc.toContain(BASELINE_DISPATCH_AGENT_NUDGE_SIGNATURE)` against
// baseline strings hand-transcribed into this file — a claim ("recorded
// verbatim from git show 85a11c5:...") that was never actually re-verified
// against real git history at test-run time. A transcription slip (or a
// baseline that silently drifted after the comment was written) would NEVER
// be caught. This version reads the ACTUAL pre-P5 blobs straight from git
// history via `execSync('git show 85a11c5:<path>')` (git read access is
// read-only and fine to invoke from inside a test — it never mutates
// anything), extracts the exact same block/signature from BOTH the baseline
// blob and the CURRENT worktree source using the SAME structural extraction
// function, and asserts BYTE-EQUALITY between them. This genuinely proves
// "unchanged since 85a11c5", not merely "the tool name and a function name
// still appear somewhere."
//
// Mirrors the source-level grep style of
// tests/guardrails/no-direct-nudge-paths.test.ts (fs.readFileSync + substring
// assertions) rather than importing server.ts (which connects to a live MCP
// transport at import time — never do that from a test).

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'

const REPO = resolve(__dirname, '..', '..')
const BASELINE_COMMIT = '85a11c5'

/** Read a file's exact content as it stood at BASELINE_COMMIT, via git (read-only). */
function gitShowBaseline(relPath: string): string {
  return execFileSync('git', ['show', `${BASELINE_COMMIT}:${relPath}`], {
    cwd: REPO,
    encoding: 'utf-8',
  })
}

/**
 * Extract the balanced `{ ... }` object literal whose FIRST property is the
 * one containing `anchorSubstring` (e.g. `name: 'nudge_agent'`) — walks
 * backward from the anchor to the nearest enclosing `{`, then forward,
 * tracking brace depth, to that brace's matching close. Returns the slice
 * INCLUDING both braces, EXCLUDING any trailing comma.
 */
function extractBalancedObjectBlock(src: string, anchorSubstring: string): string {
  const anchorIdx = src.indexOf(anchorSubstring)
  if (anchorIdx === -1) {
    throw new Error(`extractBalancedObjectBlock: anchor not found: ${anchorSubstring}`)
  }

  let openIdx = anchorIdx
  while (openIdx > 0 && src[openIdx] !== '{') openIdx--
  if (src[openIdx] !== '{') {
    throw new Error(`extractBalancedObjectBlock: no enclosing '{' found before anchor: ${anchorSubstring}`)
  }

  let depth = 0
  let closeIdx = -1
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        closeIdx = i
        break
      }
    }
  }
  if (closeIdx === -1) {
    throw new Error(`extractBalancedObjectBlock: unbalanced braces starting at anchor: ${anchorSubstring}`)
  }

  return src.slice(openIdx, closeIdx + 1)
}

/**
 * Extract a function's full signature — from its declaration anchor (e.g.
 * `export async function dispatchAgentNudge(`) through the parameter list,
 * the return-type annotation, and the function body's OPENING brace
 * (inclusive). Correctly skips over any `<...>`/`{...}` nesting WITHIN the
 * return-type annotation itself (e.g. `Promise<{ ok: boolean }>`) by
 * tracking a combined bracket-depth counter — the function body's brace is
 * the first `{` encountered once that counter has returned to zero.
 */
function extractFunctionSignature(src: string, anchor: string): string {
  const start = src.indexOf(anchor)
  if (start === -1) {
    throw new Error(`extractFunctionSignature: anchor not found: ${anchor}`)
  }
  if (!anchor.endsWith('(')) {
    throw new Error(`extractFunctionSignature: anchor must end with '(': ${anchor}`)
  }

  // Walk to the matching ')' of the parameter list.
  let i = start + anchor.length - 1 // index of the anchor's trailing '('
  let parenDepth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') parenDepth++
    else if (src[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        i++
        break
      }
    }
  }

  // Scan the return-type annotation, tracking a combined depth for '<'/'{'
  // (open) and '>'/'}' (close), until we hit the function body's own
  // opening '{' at depth 0.
  let depth = 0
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      if (depth === 0) break // function body's opening brace
      depth++
    } else if (ch === '<') {
      depth++
    } else if (ch === '>' || ch === '}') {
      depth--
    }
  }
  if (i >= src.length || src[i] !== '{') {
    throw new Error(`extractFunctionSignature: could not locate function body opening brace for anchor: ${anchor}`)
  }

  return src.slice(start, i + 1)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

const NUDGE_AGENT_TOOL_ANCHOR = "name: 'nudge_agent'"
const DISPATCH_AGENT_NUDGE_ANCHOR = 'export async function dispatchAgentNudge('

describe('ATM-023 — nudge_agent / dispatchAgentNudge signature-drift guardrail', () => {
  test('server.ts\'s nudge_agent tool-schema object is byte-identical to the pre-P5 (85a11c5) baseline, verified against real git history', () => {
    const currentSrc = readFileSync(resolve(REPO, 'server.ts'), 'utf-8')
    const baselineSrc = gitShowBaseline('server.ts')

    const currentBlock = extractBalancedObjectBlock(currentSrc, NUDGE_AGENT_TOOL_ANCHOR)
    const baselineBlock = extractBalancedObjectBlock(baselineSrc, NUDGE_AGENT_TOOL_ANCHOR)

    // Byte-equality (not merely "contains") — a genuine diff against actual
    // git history, not a hand-transcribed literal that could have drifted
    // silently.
    expect(currentBlock).toBe(baselineBlock)
    expect(sha256(currentBlock)).toBe(sha256(baselineBlock))

    // Sanity: exactly one nudge_agent tool registration exists in the
    // current source (P5 must not have introduced a second/duplicate/
    // renamed variant).
    const occurrences = currentSrc.split("name: 'nudge_agent'").length - 1
    expect(occurrences).toBe(1)
  })

  test('nudge.ts\'s dispatchAgentNudge signature is byte-identical to the pre-P5 (85a11c5) baseline, verified against real git history', () => {
    const currentSrc = readFileSync(resolve(REPO, 'nudge.ts'), 'utf-8')
    const baselineSrc = gitShowBaseline('nudge.ts')

    const currentSig = extractFunctionSignature(currentSrc, DISPATCH_AGENT_NUDGE_ANCHOR)
    const baselineSig = extractFunctionSignature(baselineSrc, DISPATCH_AGENT_NUDGE_ANCHOR)

    expect(currentSig).toBe(baselineSig)
    expect(sha256(currentSig)).toBe(sha256(baselineSig))

    // Sanity: exactly one dispatchAgentNudge export exists.
    const occurrences = currentSrc.split('export async function dispatchAgentNudge(').length - 1
    expect(occurrences).toBe(1)
  })

  test('the nudge_agent case handler in server.ts still calls dispatchAgentNudge (untouched dispatch wiring)', () => {
    const serverSrc = readFileSync(resolve(REPO, 'server.ts'), 'utf-8')

    const caseIdx = serverSrc.indexOf("case 'nudge_agent':")
    expect(caseIdx).toBeGreaterThan(-1)

    const nextCaseIdx = serverSrc.indexOf("\n      case '", caseIdx + 1)
    const blockEnd = nextCaseIdx === -1 ? caseIdx + 1500 : nextCaseIdx
    const block = serverSrc.slice(caseIdx, blockEnd)

    expect(block).toContain('dispatchAgentNudge(')
  })
})
