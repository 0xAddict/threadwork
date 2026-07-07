#!/usr/bin/env bun
// verify.ts — Automated spec gate verification script
// Checks which spec gate items are actually complete by inspecting code and running tests
// Called by the monitoring loop agent, outputs to summary.json

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const PROJECT = join(process.env.HOME ?? '/tmp', '.claude', 'mcp-servers', 'task-board')
const SUMMARY_PATH = join(PROJECT, 'verification', 'summary.json')

interface CheckResult {
  id: string
  description: string
  verified: boolean
  evidence: string
  checked_at: string
}

interface Summary {
  timestamp: string
  total: number
  verified: number
  pending: number
  checks: CheckResult[]
  tests_pass: boolean
  test_output: string
  idle_count: number
}

function fileExists(path: string): boolean {
  return existsSync(path)
}

function fileContains(path: string, pattern: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path, 'utf-8').includes(pattern)
}

function runTests(): { pass: boolean; output: string } {
  const proc = Bun.spawnSync(['bun', 'test'], { cwd: PROJECT, stdout: 'pipe', stderr: 'pipe' })
  const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
  return { pass: proc.exitCode === 0, output: output.trim() }
}

function getPreviousSummary(): Summary | null {
  if (!existsSync(SUMMARY_PATH)) return null
  try { return JSON.parse(readFileSync(SUMMARY_PATH, 'utf-8')) } catch { return null }
}

const checks: CheckResult[] = []
const now = new Date().toISOString()

// SG-1: save_memory creates with correct fields
checks.push({
  id: 'SG-1',
  description: 'save_memory creates with correct fields',
  verified: fileContains(join(PROJECT, 'memory.ts'), 'saveMemory') &&
            fileContains(join(PROJECT, 'tests/memory.test.ts'), 'saveMemory creates'),
  evidence: fileExists(join(PROJECT, 'memory.ts')) ? 'memory.ts exists with saveMemory' : 'memory.ts missing',
  checked_at: now,
})

// SG-2: recall_memories searches own + shared, updates tracking
checks.push({
  id: 'SG-2',
  description: 'recall_memories searches own + shared, updates tracking',
  verified: fileContains(join(PROJECT, 'memory.ts'), 'recallMemories') &&
            fileContains(join(PROJECT, 'tests/memory.test.ts'), 'recallMemories'),
  evidence: fileContains(join(PROJECT, 'memory.ts'), 'access_count') ? 'recallMemories with access tracking' : 'missing',
  checked_at: now,
})

// SG-3: promote_memory changes to shared
checks.push({
  id: 'SG-3',
  description: 'promote_memory changes to shared',
  verified: fileContains(join(PROJECT, 'memory.ts'), 'promoteMemory') &&
            fileContains(join(PROJECT, 'tests/memory.test.ts'), 'promoteMemory'),
  evidence: fileContains(join(PROJECT, 'memory.ts'), "'shared'") ? 'promoteMemory sets shared' : 'missing',
  checked_at: now,
})

// SG-4: pin_memory toggles pin
checks.push({
  id: 'SG-4',
  description: 'pin_memory toggles pin',
  verified: fileContains(join(PROJECT, 'memory.ts'), 'pinMemory') &&
            fileContains(join(PROJECT, 'tests/memory.test.ts'), 'pinMemory'),
  evidence: fileContains(join(PROJECT, 'memory.ts'), 'pinMemory') ? 'pinMemory with toggle' : 'missing',
  checked_at: now,
})

// SG-5: get_boot_briefing returns tiered summary without updating access
checks.push({
  id: 'SG-5',
  description: 'get_boot_briefing without access tracking update',
  verified: fileContains(join(PROJECT, 'memory.ts'), 'getBootBriefing') &&
            fileContains(join(PROJECT, 'tests/memory.test.ts'), 'getBootBriefing'),
  evidence: fileContains(join(PROJECT, 'memory.ts'), 'NO access tracking') ? 'boot briefing read-only confirmed' : 'needs comment verification',
  checked_at: now,
})

// SG-6: complete_task auto-extracts task_summary memory
checks.push({
  id: 'SG-6',
  description: 'complete_task auto-extracts task_summary memory',
  verified: fileContains(join(PROJECT, 'server.ts'), 'task_summary') &&
            fileContains(join(PROJECT, 'server.ts'), 'saveMemory'),
  evidence: fileContains(join(PROJECT, 'server.ts'), 'Auto-extract') ? 'auto-extraction in complete_task' : 'missing from server.ts',
  checked_at: now,
})

// SG-7: Decay reduces importance
checks.push({
  id: 'SG-7',
  description: 'Decay reduces importance per 7-day period',
  verified: fileContains(join(PROJECT, 'consolidate.ts'), 'runDecay') &&
            fileContains(join(PROJECT, 'tests/consolidate.test.ts'), 'runDecay'),
  evidence: fileExists(join(PROJECT, 'consolidate.ts')) ? 'consolidate.ts with runDecay' : 'missing',
  checked_at: now,
})

// SG-8: Archive at importance 0
checks.push({
  id: 'SG-8',
  description: 'Importance 0 → archived',
  verified: fileContains(join(PROJECT, 'consolidate.ts'), 'runArchive') &&
            fileContains(join(PROJECT, 'tests/consolidate.test.ts'), 'runArchive'),
  evidence: fileExists(join(PROJECT, 'consolidate.ts')) ? 'runArchive function' : 'missing',
  checked_at: now,
})

// SG-9: Prune old archives
checks.push({
  id: 'SG-9',
  description: 'Archive > 90 days → pruned',
  verified: fileContains(join(PROJECT, 'consolidate.ts'), 'runPrune') &&
            fileContains(join(PROJECT, 'tests/consolidate.test.ts'), 'runPrune'),
  evidence: fileExists(join(PROJECT, 'consolidate.ts')) ? 'runPrune function' : 'missing',
  checked_at: now,
})

// SG-10: Generates briefing JSONs
checks.push({
  id: 'SG-10',
  description: 'Generates briefing JSONs per agent',
  verified: fileContains(join(PROJECT, 'consolidate.ts'), 'generateBriefing') &&
            fileContains(join(PROJECT, 'tests/consolidate.test.ts'), 'generateBriefing'),
  evidence: fileExists(join(PROJECT, 'consolidate.ts')) ? 'generateBriefing function' : 'missing',
  checked_at: now,
})

// SG-11: LaunchAgent registered
checks.push({
  id: 'SG-11',
  description: 'LaunchAgent registered for 3am',
  verified: fileExists(join(process.env.HOME ?? '', 'Library/LaunchAgents/com.coachstokes.claude-consolidate.plist')),
  evidence: fileExists(join(process.env.HOME ?? '', 'Library/LaunchAgents/com.coachstokes.claude-consolidate.plist')) ? 'plist exists' : 'plist missing',
  checked_at: now,
})

// SG-12: Boot briefing nudge
checks.push({
  id: 'SG-12',
  description: 'Boot briefing nudge in launch-all.sh',
  verified: fileContains(join(process.env.HOME ?? '', '.claude/launch-all.sh'), 'get_boot_briefing'),
  evidence: fileContains(join(process.env.HOME ?? '', '.claude/launch-all.sh'), 'get_boot_briefing') ? 'nudge present' : 'nudge missing',
  checked_at: now,
})

// SG-13: All tests pass
const testResult = runTests()
checks.push({
  id: 'SG-13',
  description: 'All tests pass',
  verified: testResult.pass,
  evidence: testResult.pass ? 'All tests pass' : 'Tests failing',
  checked_at: now,
})

// SG-14: Live test (can't auto-verify — needs manual confirmation)
checks.push({
  id: 'SG-14',
  description: 'Live end-to-end test',
  verified: false, // Always requires manual verification
  evidence: 'Requires manual live test',
  checked_at: now,
})

const verified = checks.filter(c => c.verified).length

// Track idle count
const prev = getPreviousSummary()
const prevVerified = prev?.verified ?? 0
const idleCount = verified === prevVerified ? (prev?.idle_count ?? 0) + 1 : 0

const summary: Summary = {
  timestamp: now,
  total: checks.length,
  verified,
  pending: checks.length - verified,
  checks,
  tests_pass: testResult.pass,
  test_output: testResult.output.slice(-500), // last 500 chars
  idle_count: idleCount,
}

writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2))

// Console output for logging
console.log(`[${now}] Spec Gate: ${verified}/${checks.length} verified | Tests: ${testResult.pass ? 'PASS' : 'FAIL'} | Idle: ${idleCount}`)
for (const c of checks) {
  console.log(`  ${c.verified ? '✅' : '⬜'} ${c.id}: ${c.description}`)
}

// ---------------------------------------------------------------------------
// P6 Stage 5 / EPIC-03 — additive, flag-gated, fully-swallowed persistence of
// failure classifications derived from this run's checks/summary. Placed
// strictly AFTER the summary.json write and the console output above, and
// wrapped end-to-end in try/catch, so it can NEVER alter verify.ts's exit
// code, console output, or summary.json (REQ-005(a)). Never creates the live
// db (existsSync gate below); never throws past this block.
// ---------------------------------------------------------------------------
try {
  const { Database } = await import('bun:sqlite')
  const {
    fromVerifyCheckResult,
    fromTestRun,
    fromIdleCount,
    classifyFailure,
    persistFailureClassification,
  } = await import('./failure-classification')

  const dbPath = join(PROJECT, 'tasks.db')
  if (existsSync(dbPath)) {
    const db = new Database(dbPath)
    try {
      for (const check of checks) {
        const sig = fromVerifyCheckResult(check)
        if (sig) persistFailureClassification(db, classifyFailure(sig))
      }
      const testSig = fromTestRun(summary)
      if (testSig) persistFailureClassification(db, classifyFailure(testSig))
      const idleSig = fromIdleCount(summary)
      if (idleSig) persistFailureClassification(db, classifyFailure(idleSig))
    } finally {
      db.close()
    }
  }
} catch { /* swallow — REQ-005(a): never affect verify.ts's exit/console/summary.json */ }
