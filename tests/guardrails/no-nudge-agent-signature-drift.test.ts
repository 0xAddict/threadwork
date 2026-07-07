// tests/guardrails/no-nudge-agent-signature-drift.test.ts — ATM-023 (P5
// EPIC-07) regression lock.
//
// P5 Stage 7 adds send_directed_message/poll_directed_messages/
// ack_directed_message as a COMPLEMENTARY, additive typed message store
// (EPIC-06/EPIC-07). nudge_agent (the ephemeral tmux wake signal, no
// persistence, no ack) is explicitly OUT OF SCOPE for this work and must stay
// byte-identical. This guardrail snapshots two things against a pre-P5
// baseline recorded from `git show 85a11c5:server.ts` / `git show
// 85a11c5:nudge.ts` (verified identical to server.ts/nudge.ts as they stood
// immediately before Stage 6/7 touched either file):
//
//   1. The `nudge_agent` tool-schema object in server.ts's tools array
//      (name/description/inputSchema shape + param names) — byte-identical.
//   2. `dispatchAgentNudge`'s exported signature in nudge.ts (parameter
//      count/names/types + return type) — byte-identical.
//
// Mirrors the source-level grep style of
// tests/guardrails/no-direct-nudge-paths.test.ts (fs.readFileSync + substring
// assertions) rather than importing server.ts (which connects to a live MCP
// transport at import time — never do that from a test).

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const REPO = resolve(__dirname, '..', '..')

// Recorded verbatim from `git show 85a11c5:server.ts` (lines 198-208 at that
// commit) — confirmed via diff to be byte-identical to the current
// server.ts's nudge_agent tool block (only its surrounding line numbers have
// shifted, from unrelated additions earlier in the tools array).
const BASELINE_NUDGE_AGENT_TOOL_BLOCK = `      name: 'nudge_agent',
      description: 'Send a wake message to another agent without creating a task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['agent', 'message'],
      },
    },`

// Recorded verbatim from `git show 85a11c5:nudge.ts` (lines 449-453 at that
// commit) — confirmed via diff to be byte-identical to the current
// nudge.ts's dispatchAgentNudge signature.
const BASELINE_DISPATCH_AGENT_NUDGE_SIGNATURE = `export async function dispatchAgentNudge(
  agent: string,
  message: string,
  options?: NudgeOptions,
): Promise<{ ok: boolean; error?: string; suppressed?: boolean; pendingCount?: number }> {`

describe('ATM-023 — nudge_agent / dispatchAgentNudge signature-drift guardrail', () => {
  test('server.ts\'s nudge_agent tool-schema object is byte-identical to the pre-P5 (85a11c5) baseline', () => {
    const serverSrc = readFileSync(resolve(REPO, 'server.ts'), 'utf-8')

    expect(serverSrc).toContain(BASELINE_NUDGE_AGENT_TOOL_BLOCK)

    // Sanity: exactly one nudge_agent tool registration exists (P5 must not
    // have introduced a second/duplicate/renamed variant).
    const occurrences = serverSrc.split("name: 'nudge_agent'").length - 1
    expect(occurrences).toBe(1)
  })

  test('nudge.ts\'s dispatchAgentNudge signature is byte-identical to the pre-P5 (85a11c5) baseline', () => {
    const nudgeSrc = readFileSync(resolve(REPO, 'nudge.ts'), 'utf-8')

    expect(nudgeSrc).toContain(BASELINE_DISPATCH_AGENT_NUDGE_SIGNATURE)

    // Sanity: exactly one dispatchAgentNudge export exists.
    const occurrences = nudgeSrc.split('export async function dispatchAgentNudge(').length - 1
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
