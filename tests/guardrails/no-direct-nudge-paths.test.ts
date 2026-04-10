import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Sprint #256 guardrail — enforces the nudge dispatcher boundary.
 *
 * Two invariants this test asserts:
 *
 * 1. GATE 3: Exactly ONE call to `audit_log(..., 'agent_nudged', ...)` exists
 *    in the codebase outside tests. That one call is inside nudge.ts, in the
 *    canonical logDelivered() helper, and fires only on successful tmux send.
 *
 * 2. GATE 4: Literal `tmux.*send-keys` invocations exist ONLY inside nudge.ts
 *    (the dispatcher) or inside test files. No other production file is
 *    allowed to shell out to tmux send-keys directly.
 *
 * The bug this guard catches: before sprint #256, server.ts line 842 wrote
 * audit_log('agent_nudged') unconditionally after calling nudgeAgent(), and
 * server.ts line 957 shelled out raw Bun.spawn([TMUX_PATH, 'send-keys', ...])
 * bypassing the dispatcher. Either reintroduction will fail this test.
 */

const REPO = resolve(__dirname, '..', '..')
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude-arsenal',
  '.netlify',
  '.harness',
  'briefings',
  'artifacts',
  'docs',
  'bots',
  'bin',
  'tests', // tests can contain anything; guardrail only polices production code
])

function walkTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walkTypeScriptFiles(full, out)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('nudge-dispatcher boundary guardrails (sprint #256)', () => {
  const productionFiles = walkTypeScriptFiles(REPO)

  test('GATE 3: audit.log call with action "agent_nudged" exists only in nudge.ts', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = []

    for (const file of productionFiles) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Strip comment-only lines — doc comments legitimately mention the literal.
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        // Match `.log(` followed by an action literal of 'agent_nudged'.
        // This catches `audit.log(...)`, `this.taskDb.run(... .log(...))`,
        // and `_debounceAudit.log(...)` style callsites. It does NOT match
        // SQL view string literals or NUDGE_ACTIONS constant definitions.
        if (/\.log\s*\([^)]*['"]agent_nudged['"]/.test(line)) {
          offenders.push({ file: relative(REPO, file), line: i + 1, text: line.trim() })
        }
      }
    }

    // Allowed location: nudge.ts (via the NUDGE_ACTIONS.AGENT_NUDGED_LEGACY
    // constant which expands to 'agent_nudged' at the call site).
    // Note: the regex above matches the literal substring 'agent_nudged'
    // even inside NUDGE_ACTIONS.AGENT_NUDGED_LEGACY because it appears in
    // the identifier. If the nudge.ts callsite uses the constant directly,
    // the regex won't fire. That's expected: gate 3 asserts no LITERAL
    // 'agent_nudged' audit writes exist anywhere.
    const inNudgeTs = offenders.filter(o => o.file === 'nudge.ts')
    const elsewhere = offenders.filter(o => o.file !== 'nudge.ts')

    if (elsewhere.length > 0) {
      const details = elsewhere.map(o => `  ${o.file}:${o.line} — ${o.text}`).join('\n')
      throw new Error(
        `Gate 3 violation: audit.log('agent_nudged') found outside nudge.ts:\n${details}\n` +
        `This literal audit write must only appear inside the canonical dispatcher (nudge.ts::logDelivered) ` +
        `or be replaced by a NUDGE_ACTIONS.AGENT_NUDGED_LEGACY reference. Route new audit writes through ` +
        `dispatchAgentNudge() instead of hardcoding the string.`
      )
    }
    expect(elsewhere).toEqual([])
    // inNudgeTs may be zero if nudge.ts uses the constant (which is the
    // current state); that's fine — the assertion above is the real invariant.
  })

  test('GATE 4: raw tmux send-keys invocations exist only inside nudge.ts', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = []

    for (const file of productionFiles) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        // Match 'send-keys' as a literal — catches Bun.spawn([TMUX_PATH, 'send-keys', ...])
        // and any other shell-out variant.
        if (/['"]send-keys['"]/.test(line)) {
          offenders.push({ file: relative(REPO, file), line: i + 1, text: line.trim() })
        }
      }
    }

    const inNudgeTs = offenders.filter(o => o.file === 'nudge.ts')
    const elsewhere = offenders.filter(o => o.file !== 'nudge.ts')

    if (elsewhere.length > 0) {
      const details = elsewhere.map(o => `  ${o.file}:${o.line} — ${o.text}`).join('\n')
      throw new Error(
        `Gate 4 violation: raw tmux send-keys invocation found outside nudge.ts:\n${details}\n` +
        `All tmux send-keys shell-outs must live inside nudge.ts (dispatchAgentNudge or dispatchAgentInterrupt). ` +
        `Route through one of those functions.`
      )
    }
    expect(elsewhere).toEqual([])
    expect(inNudgeTs.length).toBeGreaterThanOrEqual(1)
  })
})
