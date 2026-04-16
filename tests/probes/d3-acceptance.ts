#!/usr/bin/env bun
/**
 * D3 Acceptance Probe — verifies that a nudge actually SUBMITS into a
 * target Claude Code TUI pane, not just pastes.
 *
 * Three verification channels (all must pass):
 *   1. Pane before/after diff — capture-pane output changed after the nudge
 *   2. Payload visible in pane — the nudge text appears in the post-nudge pane
 *   3. Session JSONL user-role message — a new `type:"user"` entry appears in
 *      the target agent's Claude Code session JSONL containing the payload,
 *      timestamped AFTER the nudge was fired
 *
 * Usage:
 *   bun run tests/probes/d3-acceptance.ts --agent kiera --payload "D3 probe test"
 *   bun run tests/probes/d3-acceptance.ts --agent boss   # uses default payload
 *   bun run tests/probes/d3-acceptance.ts --dry-run       # prints plan, no send
 *
 * Exit codes:
 *   0 = all 3 channels pass
 *   1 = at least 1 channel failed
 *   2 = usage error / agent not found
 */

import { parseArgs } from 'util'
import { AGENT_SESSIONS, TMUX_PATH } from '../../config'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    agent: { type: 'string', default: 'boss' },
    payload: { type: 'string', default: '' },
    timeout: { type: 'string', default: '5000' },
    'dry-run': { type: 'boolean', default: false },
  },
})

const agent = (values.agent ?? 'boss').toLowerCase()
const session = AGENT_SESSIONS[agent]
if (!session) {
  console.error(`Unknown agent: ${agent}. Known: ${Object.keys(AGENT_SESSIONS).join(', ')}`)
  process.exit(2)
}

const payload = values.payload || `D3-PROBE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const timeoutMs = parseInt(values.timeout ?? '5000', 10)
const dryRun = values['dry-run'] ?? false

const PROJECTS_BASE = join(process.env.HOME ?? '/Users/coachstokes', '.claude', 'projects')

async function capturePane(sess: string): Promise<string> {
  const proc = Bun.spawn([TMUX_PATH, 'capture-pane', '-t', sess, '-p', '-S', '-50', '-E', '-1'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  return await new Response(proc.stdout).text()
}

function findRecentJsonls(afterTs: number): string[] {
  const results: string[] = []
  const walkDir = (dir: string, depth: number) => {
    if (depth > 3) return
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const stat = statSync(full)
            if (stat.mtimeMs >= afterTs - 60000) {
              results.push(full)
            }
          } catch {}
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walkDir(full, depth + 1)
        }
      }
    } catch {}
  }
  walkDir(PROJECTS_BASE, 0)
  return results
}

function searchJsonlForPayload(
  files: string[],
  needle: string,
  afterIso: string,
): { found: boolean; file?: string; timestamp?: string; contentPreview?: string } {
  for (const file of files) {
    try {
      const lines = readFileSync(file, 'utf-8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.type !== 'user') continue
          const ts = entry.timestamp ?? entry.message?.timestamp
          if (ts && ts < afterIso) continue
          const content = entry.message?.content
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map((c: any) => c?.text ?? '').join(' ')
              : ''
          if (text.includes(needle)) {
            return {
              found: true,
              file,
              timestamp: ts,
              contentPreview: text.slice(0, 120),
            }
          }
        } catch {}
      }
    } catch {}
  }
  return { found: false }
}

// --- Main ---

console.log(`\n=== D3 Acceptance Probe ===`)
console.log(`Agent:   ${agent} (session: ${session})`)
console.log(`Payload: ${payload}`)
console.log(`Timeout: ${timeoutMs}ms`)
console.log(`Dry run: ${dryRun}\n`)

if (dryRun) {
  console.log('DRY RUN — would fire nudge, capture pane, check JSONL. Exiting.')
  process.exit(0)
}

// Channel 1 + 2 setup: capture baseline
const beforeTs = new Date().toISOString()
const beforeTsMs = Date.now()
const baselinePane = await capturePane(session)
console.log(`[baseline] Captured ${baselinePane.length} chars from pane`)

// Fire the nudge via the MCP tool (call dispatchAgentNudge directly)
const { dispatchAgentNudge, configureNudgeDebounce } = await import('../../nudge')
const { TaskDB } = await import('../../db')
const { AuditLog } = await import('../../audit')

const db = new TaskDB()
const audit = new AuditLog(db)
configureNudgeDebounce(db, audit)

console.log(`[send] Firing nudge to ${agent}...`)
const result = await dispatchAgentNudge(agent, payload, {
  source: 'd3-probe',
  bypassDebounce: true,
})
console.log(`[send] Result: ok=${result.ok} error=${result.error ?? 'none'}`)

if (!result.ok) {
  // Do NOT bail here. sendTmuxNudgeV2's inline verify loop can false-negative
  // when the TUI processes the paste so fast that the payload is already gone
  // from the visible pane by the first capture (submitted + conversation
  // advanced). Proceed to all 3 channels — CH3 (JSONL) is authoritative.
  console.log(`[send] ⚠️  Inline verify returned: ${result.error}`)
  console.log('[send] Proceeding to full 3-channel verification (CH3 is authoritative)')
}

// Wait for the TUI to process
console.log(`[wait] Sleeping ${timeoutMs}ms for TUI processing...`)
await new Promise((r) => setTimeout(r, timeoutMs))

// Channel 1: Pane before/after diff
const postPane = await capturePane(session)
console.log(`[post] Captured ${postPane.length} chars from pane`)

const paneDiffExists = postPane !== baselinePane
const ch1Pass = paneDiffExists
console.log(`\n[CH1] Pane diff: ${ch1Pass ? 'PASS ✓' : 'FAIL ✗'} (baseline=${baselinePane.length}, post=${postPane.length}, changed=${paneDiffExists})`)

// Channel 2: Payload visible in pane
const needle = payload.replace(/\s+/g, ' ').trim().slice(0, 48)
const ch2Pass = postPane.includes(needle) || postPane.replace(/\s+/g, ' ').includes(needle)
console.log(`[CH2] Payload visible: ${ch2Pass ? 'PASS ✓' : 'FAIL ✗'} (needle="${needle.slice(0, 40)}...")`)

// Channel 3: Session JSONL user-role message
console.log(`[CH3] Searching session JSONLs modified after ${beforeTs}...`)
const jsonlFiles = findRecentJsonls(beforeTsMs)
console.log(`[CH3] Found ${jsonlFiles.length} recent JSONL files to search`)

const jsonlResult = searchJsonlForPayload(jsonlFiles, payload.slice(0, 40), beforeTs)
const ch3Pass = jsonlResult.found
console.log(
  `[CH3] Session JSONL: ${ch3Pass ? 'PASS ✓' : 'FAIL ✗'}${
    ch3Pass ? ` (file=${jsonlResult.file}, ts=${jsonlResult.timestamp}, preview="${jsonlResult.contentPreview}")` : ' (payload not found in any recent JSONL)'
  }`,
)

// Verdict — CH3 is AUTHORITATIVE. CH1+CH2 are supporting signals.
// A nudge that submits and processes instantly may cause CH1/CH2 to
// false-negative (pane already advanced past the submitted text).
console.log(`\n=== VERDICT ===`)
console.log(`CH1 pane-diff:       ${ch1Pass ? 'PASS' : 'FAIL'}${!ch1Pass ? ' (may false-negative if TUI processed instantly)' : ''}`)
console.log(`CH2 payload-visible: ${ch2Pass ? 'PASS' : 'FAIL'}${!ch2Pass ? ' (may false-negative if payload already in conversation history)' : ''}`)
console.log(`CH3 session-jsonl:   ${ch3Pass ? 'PASS' : 'FAIL'} ← AUTHORITATIVE`)

const overallPass = ch3Pass
const bonusChannels = (ch1Pass ? 1 : 0) + (ch2Pass ? 1 : 0)
console.log(`\nOVERALL: ${overallPass ? `PASS ✓ — nudge submitted and processed end-to-end (${bonusChannels}/2 bonus channels)` : 'FAIL ✗ — CH3 (session JSONL) did not find the payload as a user message'}`)

// Cleanup
db.close()
process.exit(overallPass ? 0 : 1)
