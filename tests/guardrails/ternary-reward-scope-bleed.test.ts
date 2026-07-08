/*
 * tests/guardrails/ternary-reward-scope-bleed.test.ts
 *
 * P8 Stage 8 (EPIC-07 guardrails), ATM-029 and ATM-030 (REQ-020). ATM-028
 * (audit atomicity, REQ-019) was already covered in Stage 4 inside
 * tests/ternary-reward.test.ts and is NOT duplicated here.
 *
 * ATM-029 [P1]: zero-scope-bleed static guardrail. Every P4/P5/P6-write/
 * P7-write symbol/file this spec is explicitly forbidden from touching
 * (REQ-020) is proven byte-untouched since the P8 build-base commit
 * (fceeaf2) via a "git diff --numstat" call. db.ts's AND server.ts's
 * additive-only edits are each proven via a zero-deletions numstat check.
 * The pre-existing decisions / decision_positions / decision_critiques /
 * findings / artifacts table definitions are proven present + unchanged in
 * shape. ternary-reward.ts is proven to write NO reward back into
 * memories/decisions (no UPDATE, no importance/quality writeback).
 *
 * ATM-030 [P1]: verify.ts non-touch + import-graph guardrail. verify.ts is
 * proven byte-untouched, neither module imports the other, and
 * ternary-reward.ts is proven to import NO P6/P7 write symbol.
 *
 * This file is a GUARDRAIL over the EXISTING build. Every assertion is
 * expected to pass as written because the build already honors scope. A
 * failure here is a real scope-bleed finding, not a spec to grow into.
 */

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = 'fceeaf2'

/** Run `git diff --numstat <BASE_COMMIT> -- <relPath>` from the worktree root. */
function gitNumstat(relPath: string): string {
  return execSync(`git diff --numstat ${BASE_COMMIT} -- ${relPath}`, {
    cwd: REPO,
    encoding: 'utf-8',
  }).trim()
}

/** deletions column of a numstat line, or throws if the line is empty. */
function deletionsOf(numstat: string): number {
  const parts = numstat.split(/\s+/)
  expect(parts.length).toBeGreaterThanOrEqual(2)
  const del = Number(parts[1])
  expect(Number.isFinite(del)).toBe(true)
  return del
}

// ---------------------------------------------------------------------------
// ATM-029 / REQ-020 [P1] — zero-scope-bleed static guardrail
// ---------------------------------------------------------------------------
describe('ATM-029: zero-scope-bleed guardrail (REQ-020)', () => {
  // Resolve EVERY tracked path whose exact basename matches — the worktree
  // carries a nested `mcp-servers/task-board/` snapshot subtree, so some
  // basenames (e.g. memory.ts) resolve to 2 real paths. We guard ALL of them
  // (both the build-root file and any snapshot copy must be byte-untouched).
  function findTrackedFiles(basename: string): string[] {
    const out = execSync(`git ls-files | grep -F '${basename}'`, {
      cwd: REPO,
      encoding: 'utf-8',
    }).trim()
    const lines = out.split('\n').filter(Boolean)
    const exact = lines.filter((l) => l === basename || l.endsWith(`/${basename}`))
    expect(exact.length).toBeGreaterThan(0)
    return exact
  }

  // P4/P5/P6-write/P7-write + decision.ts + memory.ts files P8 must NEVER edit.
  const protectedFiles = [
    'memory-integrity.ts',
    'memory-ordering.ts',
    'agent-messages.ts',
    'decision.ts',
    'failure-classification.ts',
    'cross-family-critique.ts',
    'memory.ts',
  ]

  test.each(protectedFiles)(
    'ATM-029: %s is byte-untouched since build base fceeaf2 (zero changed lines, all tracked copies)',
    (basename) => {
      const paths = findTrackedFiles(basename)
      for (const relPath of paths) {
        expect(gitNumstat(relPath)).toBe('')
      }
    },
  )

  test('ATM-029: db.ts has ZERO deletions since build base (purely additive)', () => {
    const numstat = gitNumstat('db.ts')
    expect(numstat).not.toBe('') // P8 DID additively edit db.ts (ternary_rewards table + flag)
    expect(deletionsOf(numstat)).toBe(0)
  })

  test('ATM-029: server.ts has ZERO deletions since build base (purely additive)', () => {
    const numstat = gitNumstat('server.ts')
    expect(numstat).not.toBe('') // P8 DID additively edit server.ts (the finalize hook)
    expect(deletionsOf(numstat)).toBe(0)
  })

  const DB_SOURCE = readFileSync(resolve(REPO, 'db.ts'), 'utf-8')

  test('ATM-029: decisions table definition block is present and unchanged in shape', () => {
    expect(DB_SOURCE).toMatch(
      /CREATE TABLE IF NOT EXISTS decisions \(\s*\n\s*id INTEGER PRIMARY KEY AUTOINCREMENT,\s*\n\s*title TEXT NOT NULL,\s*\n\s*context TEXT,\s*\n\s*opened_by TEXT NOT NULL,\s*\n\s*status TEXT NOT NULL DEFAULT 'open'\s*\n\s*CHECK\(status IN \('open','positions','critique','finalized','expired','cancelled'\)\),\s*\n\s*finalized_by TEXT,\s*\n\s*outcome TEXT,\s*\n\s*outcome_rationale TEXT,\s*\n\s*expires_at TEXT,\s*\n\s*memory_id INTEGER,\s*\n\s*task_id INTEGER,\s*\n\s*created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\),\s*\n\s*updated_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\),\s*\n\s*finalized_at TEXT\s*\n\s*\);/,
    )
  })

  test('ATM-029: decision_positions table definition block is present and unchanged in shape', () => {
    expect(DB_SOURCE).toMatch(
      /CREATE TABLE IF NOT EXISTS decision_positions \(\s*\n\s*id INTEGER PRIMARY KEY AUTOINCREMENT,\s*\n\s*decision_id INTEGER NOT NULL REFERENCES decisions\(id\),\s*\n\s*agent TEXT NOT NULL,\s*\n\s*position TEXT NOT NULL,\s*\n\s*rationale TEXT,\s*\n\s*evidence TEXT,\s*\n\s*created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)\s*\n\s*\);/,
    )
  })

  test('ATM-029: decision_critiques table definition block is present and unchanged in shape', () => {
    expect(DB_SOURCE).toMatch(
      /CREATE TABLE IF NOT EXISTS decision_critiques \(\s*\n\s*id INTEGER PRIMARY KEY AUTOINCREMENT,\s*\n\s*decision_id INTEGER NOT NULL REFERENCES decisions\(id\),\s*\n\s*position_id INTEGER REFERENCES decision_positions\(id\),\s*\n\s*agent TEXT NOT NULL,\s*\n\s*critique TEXT NOT NULL,\s*\n\s*severity TEXT DEFAULT 'observation'\s*\n\s*CHECK\(severity IN \('observation','concern','blocker'\)\),\s*\n\s*created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)\s*\n\s*\);/,
    )
  })

  test('ATM-029: findings table definition block is present and unchanged in shape', () => {
    expect(DB_SOURCE).toMatch(
      /CREATE TABLE IF NOT EXISTS findings \(\s*\n\s*finding_id INTEGER PRIMARY KEY AUTOINCREMENT,\s*\n\s*task_id INTEGER NOT NULL REFERENCES tasks\(id\),\s*\n\s*attempt_id INTEGER,\s*\n\s*agent_id TEXT NOT NULL,\s*\n\s*parent_agent_id TEXT,\s*\n\s*finding_type TEXT NOT NULL,\s*\n\s*summary TEXT NOT NULL,\s*\n\s*status TEXT NOT NULL DEFAULT 'draft'\s*\n\s*CHECK\(status IN \('draft', 'published', 'superseded'\)\),\s*\n\s*is_final INTEGER NOT NULL DEFAULT 0,\s*\n\s*metrics_json TEXT,\s*\n\s*refs_json TEXT,\s*\n\s*metadata_json TEXT,\s*\n\s*content_hash TEXT,\s*\n\s*priority TEXT DEFAULT 'normal',\s*\n\s*expires_at TEXT,\s*\n\s*created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)\s*\n\s*\);/,
    )
  })

  test('ATM-029: artifacts table definition block is present and unchanged in shape', () => {
    expect(DB_SOURCE).toMatch(
      /CREATE TABLE IF NOT EXISTS artifacts \(\s*\n\s*artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,\s*\n\s*task_id INTEGER NOT NULL REFERENCES tasks\(id\),\s*\n\s*finding_id INTEGER REFERENCES findings\(finding_id\),\s*\n\s*attempt_id INTEGER,\s*\n\s*agent_id TEXT NOT NULL,\s*\n\s*uri TEXT NOT NULL,\s*\n\s*mime_type TEXT DEFAULT 'text\/plain',\s*\n\s*size_bytes INTEGER,\s*\n\s*content_hash TEXT,\s*\n\s*created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\),\s*\n\s*expires_at TEXT\s*\n\s*\);/,
    )
  })

  const TR_MODULE = readFileSync(resolve(REPO, 'verification', 'ternary-reward.ts'), 'utf-8')

  test('ATM-029: ternary-reward.ts writes NO reward back into memories/decisions (no UPDATE, no importance/quality)', () => {
    expect(TR_MODULE).not.toMatch(/memories\.importance/)
    expect(TR_MODULE).not.toMatch(/memories\.quality/)
    expect(TR_MODULE).not.toMatch(/UPDATE\s+memories/i)
    expect(TR_MODULE).not.toMatch(/UPDATE\s+decisions/i)
    // The module's ONLY writes are INSERTs into ternary_rewards + audit_log —
    // there is no UPDATE SQL statement anywhere (match a real `UPDATE <tbl> SET`
    // form, not the bare word — the getTernaryRewards() doc-comment legitimately
    // says "SELECT only — never INSERT/UPDATE/DELETE").
    expect(TR_MODULE).not.toMatch(/UPDATE\s+\w+\s+SET\b/i)
    // Non-vacuous bite proof: the file was actually read.
    expect(TR_MODULE.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-030 / REQ-020 [P1] — verify.ts non-touch + import-graph guardrail
// ---------------------------------------------------------------------------
describe('ATM-030: verify.ts non-touch + import-graph guardrail (REQ-020)', () => {
  const TR_MODULE = readFileSync(resolve(REPO, 'verification', 'ternary-reward.ts'), 'utf-8')

  test('ATM-030: verification/verify.ts is byte-untouched since build base (zero changed lines)', () => {
    expect(gitNumstat('verification/verify.ts')).toBe('')
  })

  test('ATM-030: ternary-reward.ts does not import from verify.ts', () => {
    expect(TR_MODULE).not.toMatch(/from\s+['"]\.\/verify['"]/)
    expect(TR_MODULE).not.toMatch(/from\s+['"]\.\.?\/?verify['"]/)
    expect(TR_MODULE).not.toMatch(/require\(\s*['"][^'"]*\/verify['"]\s*\)/)
  })

  test('ATM-030: verify.ts does not import from ternary-reward.ts', () => {
    const verifySource = readFileSync(resolve(REPO, 'verification', 'verify.ts'), 'utf-8')
    expect(verifySource).not.toMatch(/from\s+['"]\.\/ternary-reward['"]/)
    expect(verifySource).not.toMatch(/from\s+['"]\.\.?\/?ternary-reward['"]/)
    expect(verifySource).not.toMatch(/require\(\s*['"][^'"]*\/ternary-reward['"]\s*\)/)
  })

  test('ATM-030: ternary-reward.ts imports NO P6/P7 WRITE symbol', () => {
    const WRITE_SYMBOLS = [
      'persistCrossFamilyCritique',
      'evaluateCrossFamily',
      'resolveModelFamily',
      'resolveAgentDefaultFamily',
      'classifyFailure',
      'persistFailureClassification',
    ]
    const importLines = TR_MODULE.split('\n').filter((l) => /^\s*import\b/.test(l))
    for (const line of importLines) {
      for (const sym of WRITE_SYMBOLS) {
        expect(line).not.toContain(sym)
      }
    }
  })
})
