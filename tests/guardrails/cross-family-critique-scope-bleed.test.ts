/*
 * tests/guardrails/cross-family-critique-scope-bleed.test.ts
 *
 * P7 Stage 8 (EPIC-07 guardrails), ATM-029 and ATM-030 (REQ-020). ATM-028
 * (audit atomicity, REQ-019) was already covered in Stage 4 inside
 * tests/cross-family-critique.test.ts and is NOT duplicated here.
 *
 * ATM-029 [P1]: zero-scope-bleed static guardrail. Every P4/P5/P6-write
 * symbol/file this spec is explicitly forbidden from touching (REQ-020) is
 * proven byte-untouched since the P7 build-base commit via a
 * "git diff --numstat" call. db.ts's additive-only edit is proven via a
 * zero-deletions numstat check plus a structural presence check on the
 * decisions, decision_positions, decision_critiques, findings, and artifacts
 * table definitions. The module is also proven free of any reward-shaped
 * (-1/0/1) literal, mirroring the Stage-5 ATM-023 approach used in
 * tests/cross-family-critique.test.ts.
 *
 * ATM-030 [P1]: verify.ts non-touch guardrail. verify.ts is proven
 * byte-untouched since the build base, and a static import-graph check
 * proves that neither module imports the other.
 *
 * This file is a GUARDRAIL over the EXISTING build. Per TDD discipline for
 * this stage, every assertion below is expected to pass as written because
 * the build already honors scope. A failure here is a real scope-bleed
 * finding, not a spec the implementation still needs to grow into, so do
 * not weaken any assertion just to force a pass.
 */

import { test, expect, describe } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const BASE_COMMIT = 'f44708f'

/** Run `git diff --numstat <BASE_COMMIT> -- <relPath>` from the worktree root. */
function gitNumstat(relPath: string): string {
  return execSync(`git diff --numstat ${BASE_COMMIT} -- ${relPath}`, {
    cwd: REPO,
    encoding: 'utf-8',
  }).trim()
}

// ---------------------------------------------------------------------------
// ATM-029 / REQ-020 [P1] — zero-scope-bleed static guardrail
// ---------------------------------------------------------------------------
describe('ATM-029: zero-scope-bleed guardrail (REQ-020)', () => {
  // P4/P5/P6-write files this spec is explicitly forbidden from editing.
  // Located dynamically via `git ls-files` per the build brief rather than
  // hardcoding an assumed path, so a future file move doesn't silently
  // produce a false "empty diff" pass against a stale/wrong path.
  function findTrackedFile(basename: string): string {
    const out = execSync(`git ls-files | grep -F '${basename}'`, {
      cwd: REPO,
      encoding: 'utf-8',
    }).trim()
    const lines = out.split('\n').filter(Boolean)
    // Prefer an exact basename match (path ending in "/<basename>" or equal
    // to "<basename>") over any incidental substring match (e.g.
    // "memory-integrity-cli.ts" also contains "memory-integrity" as a
    // substring but is a DIFFERENT file).
    const exact = lines.filter(l => l === basename || l.endsWith(`/${basename}`))
    expect(exact.length).toBeGreaterThan(0)
    expect(exact.length).toBe(1)
    return exact[0]!
  }

  const protectedFiles = [
    'memory-integrity.ts',
    'memory-ordering.ts',
    'agent-messages.ts',
    'decision.ts',
    'failure-classification.ts',
  ]

  test.each(protectedFiles)(
    'ATM-029: %s is byte-untouched since build base %s (zero changed lines)',
    (basename) => {
      const relPath = findTrackedFile(basename)
      const numstat = gitNumstat(relPath)
      expect(numstat).toBe('')
    },
  )

  test('ATM-029: db.ts has ZERO deletions since build base (purely additive)', () => {
    const numstat = gitNumstat('db.ts')
    // numstat is empty when there is no diff at all; that would ALSO satisfy
    // "zero deletions" but P7 is known to have additively edited db.ts (the
    // cross_family_critiques table), so require an actual numstat line and
    // assert its deletions column is 0.
    expect(numstat).not.toBe('')
    const parts = numstat.split(/\s+/)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const deletions = Number(parts[1])
    expect(Number.isFinite(deletions)).toBe(true)
    expect(deletions).toBe(0)
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

  const MODULE_SOURCE = readFileSync(
    resolve(REPO, 'verification', 'cross-family-critique.ts'),
    'utf-8',
  )

  test('ATM-029: no reward-shaped -1/0/1 literal bound to a "reward"-named identifier in cross-family-critique.ts', () => {
    // (a) No `reward...` identifier assigned/typed to a bare -1/0/1 literal.
    expect(MODULE_SOURCE).not.toMatch(/reward[A-Za-z0-9_]*\s*[=:]\s*-?[01]\b/i)

    // (b) No `return -1|0|1` statement inside a function whose name contains
    // "reward" (a differently-named local/param still shows up in the
    // surrounding text window of a reward-named function's body).
    const lines = MODULE_SOURCE.split('\n')
    const rewardFnRe = /\breward[A-Za-z0-9_]*\s*\(/i
    lines.forEach((line, i) => {
      if (!rewardFnRe.test(line)) return
      const windowLines = lines.slice(i, Math.min(lines.length, i + 12)).join('\n')
      expect(windowLines).not.toMatch(/\breturn\s+-?[01]\b/)
    })

    // Non-vacuous "bite" proof: this scan actually inspected real text, i.e.
    // the module is non-empty and was read successfully.
    expect(MODULE_SOURCE.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// ATM-030 / REQ-020 [P1] — verify.ts non-touch guardrail
// ---------------------------------------------------------------------------
describe('ATM-030: verify.ts non-touch guardrail (REQ-020)', () => {
  test('ATM-030: verification/verify.ts is byte-untouched since build base (zero changed lines)', () => {
    const numstat = gitNumstat('verification/verify.ts')
    expect(numstat).toBe('')
  })

  test('ATM-030: cross-family-critique.ts does not import from verify.ts', () => {
    const moduleSource = readFileSync(
      resolve(REPO, 'verification', 'cross-family-critique.ts'),
      'utf-8',
    )
    expect(moduleSource).not.toMatch(/from\s+['"]\.\/verify['"]/)
    expect(moduleSource).not.toMatch(/from\s+['"]\.\.?\/?verify['"]/)
    expect(moduleSource).not.toMatch(/require\(\s*['"][^'"]*\/verify['"]\s*\)/)
  })

  test('ATM-030: verify.ts does not import from cross-family-critique.ts', () => {
    const verifySource = readFileSync(resolve(REPO, 'verification', 'verify.ts'), 'utf-8')
    expect(verifySource).not.toMatch(/from\s+['"]\.\/cross-family-critique['"]/)
    expect(verifySource).not.toMatch(
      /from\s+['"]\.\.?\/?cross-family-critique['"]/,
    )
    expect(verifySource).not.toMatch(
      /require\(\s*['"][^'"]*\/cross-family-critique['"]\s*\)/,
    )
  })
})
