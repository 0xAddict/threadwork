/**
 * tests/failure-classification-verify-integration.test.ts — P6 Stage 5,
 * EPIC-03 integration coverage for verify.ts's additive, flag-gated,
 * try/catch-swallowed failure-classification persistence block (ATM-011),
 * plus the ATM-012 regression-lock (interface snapshot + fault-injection).
 *
 * verify.ts is spawned as a REAL child process (Bun.spawnSync) with HOME
 * overridden to a temp fixture directory, so PROJECT = <tmpHOME>/.claude/
 * mcp-servers/task-board resolves entirely inside the fixture — the real
 * verify.ts file (and its sibling failure-classification.ts) is the code
 * under test, but every file IT inspects (memory.ts, consolidate.ts,
 * server.ts, tasks.db, etc.) lives in the isolated fixture, never the live
 * worktree or the live board db.
 *
 * Fixture design (deterministic exactly-3-rows count):
 *   - memory.ts is missing the "saveMemory" marker (but has all the OTHER
 *     SG-2..SG-5 markers) => SG-1 fails, SG-2..SG-5 pass.
 *   - consolidate.ts / server.ts / the LaunchAgent plist / launch-all.sh all
 *     carry every marker SG-6..SG-12 need => SG-6..SG-12 all pass.
 *   - one deliberately-failing test file makes `bun test` (run BY verify.ts
 *     inside PROJECT) fail fast => SG-13 fails (tests_pass: false).
 *   - SG-14 is UNCONDITIONALLY verified:false in the pristine, unmodified
 *     verify.ts (hardcoded "Always requires manual verification") — this is
 *     not something the fixture controls, it fails on every run.
 *   => non-SG-13 failing checks = { SG-1, SG-14 } = exactly 2 verify_check
 *      signals (SG-13's own failure is captured once, separately, via
 *      fromTestRun — never double-classified per the SG-13 dedup exclusion).
 *      Total expected rows = 2 verify_check + 1 test_run = 3, NOT 4.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { TaskDB } from '../db'
import { getFailureClassifications } from '../verification/failure-classification'

const VERIFY_TS_PATH = join(import.meta.dir, '..', 'verification', 'verify.ts')
const tmpDirs: string[] = []

function mkTmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'p6-verify-fixture-'))
  tmpDirs.push(d)
  return d
}

function projectDir(tmpHome: string): string {
  return join(tmpHome, '.claude', 'mcp-servers', 'task-board')
}

/**
 * Lays out a minimal fixture PROJECT under `tmpHome` such that verify.ts
 * (run with HOME=tmpHome) produces a deterministic SG-1 + SG-14 (verify_check)
 * + SG-13 (test_run) failure set — see file header for the exact design.
 */
function buildFixture(tmpHome: string, flagOn: boolean): { project: string; dbPath: string } {
  const project = projectDir(tmpHome)
  mkdirSync(project, { recursive: true })
  mkdirSync(join(project, 'tests'), { recursive: true })
  mkdirSync(join(project, 'verification'), { recursive: true })
  mkdirSync(join(tmpHome, 'Library', 'LaunchAgents'), { recursive: true })
  mkdirSync(join(tmpHome, '.claude'), { recursive: true })

  // memory.ts — deliberately missing "saveMemory" (fails SG-1 only among SG-1..SG-5).
  writeFileSync(
    join(project, 'memory.ts'),
    [
      'export function recallMemories() { /* access_count tracked elsewhere */ }',
      'export function promoteMemory() { /* sets to shared */ }',
      'export function pinMemory() { /* toggle pin */ }',
      'export function getBootBriefing() { /* NO access tracking update here */ }',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'tests', 'memory.test.ts'),
    [
      "import { test } from 'bun:test'",
      "test('recallMemories works', () => {})",
      "test('promoteMemory works', () => {})",
      "test('pinMemory works', () => {})",
      "test('getBootBriefing works', () => {})",
    ].join('\n'),
  )

  // server.ts — SG-6 needs both markers present.
  writeFileSync(
    join(project, 'server.ts'),
    "// Auto-extract task_summary\nfunction saveMemory() {}\nconst task_summary = true\n",
  )

  // consolidate.ts + its test file — SG-7..SG-10.
  writeFileSync(
    join(project, 'consolidate.ts'),
    [
      'export function runDecay() {}',
      'export function runArchive() {}',
      'export function runPrune() {}',
      'export function generateBriefing() {}',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'tests', 'consolidate.test.ts'),
    [
      "import { test } from 'bun:test'",
      "test('runDecay works', () => {})",
      "test('runArchive works', () => {})",
      "test('runPrune works', () => {})",
      "test('generateBriefing works', () => {})",
    ].join('\n'),
  )

  // SG-11: LaunchAgent plist existence (checked against tmpHome, not PROJECT).
  writeFileSync(join(tmpHome, 'Library', 'LaunchAgents', 'com.coachstokes.claude-consolidate.plist'), '<plist/>')

  // SG-12: launch-all.sh containing the nudge marker.
  writeFileSync(join(tmpHome, '.claude', 'launch-all.sh'), '#!/bin/sh\nget_boot_briefing\n')

  // SG-13: exactly one genuinely failing test so `bun test` (run BY verify.ts
  // inside PROJECT) fails fast and deterministically. The memory/consolidate
  // test files above are plain no-op `test(...)` calls with no callback —
  // bun:test treats a callback-less test as a TODO/skip, not a pass or fail,
  // so this dummy file is the ONLY thing driving tests_pass to false.
  writeFileSync(
    join(project, 'tests', 'zz-dummy-fail.test.ts'),
    [
      "import { test, expect } from 'bun:test'",
      "test('deliberately fails for ATM-011 fixture determinism', () => { expect(true).toBe(false) })",
    ].join('\n'),
  )

  const dbPath = join(project, 'tasks.db')
  const taskDb = new TaskDB(dbPath)
  taskDb.setFeatureFlag('failure_classification_enabled', flagOn)
  taskDb.close()

  return { project, dbPath }
}

function runVerify(tmpHome: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', VERIFY_TS_PATH], {
    env: { ...process.env, HOME: tmpHome },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

function readSummary(project: string): any {
  return JSON.parse(readFileSync(join(project, 'verification', 'summary.json'), 'utf-8'))
}

/**
 * Strips fields that are expected to differ between any two verify.ts
 * invocations for reasons UNRELATED to the P6 persistence block: the
 * top-level `timestamp` and per-check `checked_at` (always fresh wall-clock
 * values), and `test_output` (the last 500 chars of the nested `bun test`
 * run's stdout/stderr — for a FAILING test this embeds the fixture's own
 * absolute tmpdir path, which is randomized per mkdtempSync call and would
 * never match across two independent fixture directories regardless of any
 * P6 change). None of these three fields are written or read by the
 * additive persistence block, so comparing everything else is the correct
 * way to prove REQ-005(a): the persistence side effect has ZERO influence on
 * verify.ts's checks/verified/pending/total/tests_pass/idle_count.
 */
function normalizeSummary(summary: any): any {
  const { timestamp, checks, test_output, ...rest } = summary
  return {
    ...rest,
    checks: (checks as any[]).map(({ checked_at, ...c }) => c),
  }
}

/** Strips the leading `[<timestamp>]` prefix from verify.ts's first console.log line. */
function normalizeStdout(stdout: string): string {
  return stdout.replace(/^\[[^\]]*\]/, '[TS]')
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
})

describe('ATM-011: verify.ts additive failure-classification persistence (flag ON)', () => {
  test('ATM-011: exactly 3 failure_classifications rows (2 verify_check + 1 test_run — NOT 4; SG-13 not double-counted)', () => {
    const tmpHome = mkTmpHome()
    const { project, dbPath } = buildFixture(tmpHome, true)

    const result = runVerify(tmpHome)
    expect(existsSync(join(project, 'verification', 'summary.json'))).toBe(true)

    const summary = readSummary(project)
    expect(summary.tests_pass).toBe(false)
    const sg1 = summary.checks.find((c: any) => c.id === 'SG-1')
    const sg14 = summary.checks.find((c: any) => c.id === 'SG-14')
    const sg13 = summary.checks.find((c: any) => c.id === 'SG-13')
    expect(sg1.verified).toBe(false)
    expect(sg14.verified).toBe(false)
    expect(sg13.verified).toBe(false)
    // Sanity: every OTHER check passed, so SG-1/SG-14 are the only non-SG-13 fails.
    const otherFails = summary.checks.filter((c: any) => c.verified === false && c.id !== 'SG-1' && c.id !== 'SG-14' && c.id !== 'SG-13')
    expect(otherFails).toEqual([])

    const taskDb = new TaskDB(dbPath)
    const rows = taskDb.run(db => getFailureClassifications(db))
    taskDb.close()

    expect(rows.length).toBe(3)
    const verifyCheckRows = rows.filter(r => r.signal_source === 'verify_check')
    const testRunRows = rows.filter(r => r.signal_source === 'test_run')
    expect(verifyCheckRows.length).toBe(2)
    expect(testRunRows.length).toBe(1)

    const sourceRefs = verifyCheckRows.map(r => r.source_ref).sort()
    expect(sourceRefs).toEqual(['SG-1', 'SG-14'])
    // SG-13 must NEVER appear as a verify_check row (the adapter excludes it).
    expect(rows.some(r => r.source_ref === 'SG-13')).toBe(false)

    for (const r of verifyCheckRows) expect(r.failure_class).toBe('verification_failure')
    expect(testRunRows[0]!.failure_class).toBe('test_failure')

    expect(result.exitCode).toBe(0) // verify.ts itself always exits 0 (it's a reporter, not a gate)
  }, 30000)
})

describe('ATM-011: verify.ts additive failure-classification persistence (flag OFF) — zero rows, summary.json unaffected', () => {
  test('ATM-011: flag OFF -> 0 rows; summary.json is unaffected by persistence (byte-identical modulo timestamp/checked_at/idle_count, which the persistence block cannot touch anyway)', () => {
    const tmpHomeOn = mkTmpHome()
    buildFixture(tmpHomeOn, true)
    runVerify(tmpHomeOn)
    const summaryOn = readSummary(projectDir(tmpHomeOn))

    const tmpHomeOff = mkTmpHome()
    const { project: projectOff, dbPath: dbPathOff } = buildFixture(tmpHomeOff, false)
    runVerify(tmpHomeOff)
    const summaryOff = readSummary(projectOff)

    const taskDbOff = new TaskDB(dbPathOff)
    const rowsOff = taskDbOff.run(db => getFailureClassifications(db))
    taskDbOff.close()
    expect(rowsOff.length).toBe(0)

    // timestamp/checked_at are always-fresh wall-clock values (never equal
    // across two separate process invocations); idle_count is a function of
    // the PRIOR summary.json for that fixture, which differs between the two
    // independent fixture directories (both start from "no prior summary",
    // i.e. idle_count=0, in THIS comparison since each fixture is fresh —
    // asserted explicitly below). None of these three fields are written or
    // read by the additive persistence block, so normalizing them away and
    // comparing everything else is the correct way to prove REQ-005(a): the
    // persistence side effect has ZERO influence on verify.ts's summary.json.
    expect(summaryOn.idle_count).toBe(0)
    expect(summaryOff.idle_count).toBe(0)
    expect(normalizeSummary(summaryOn)).toEqual(normalizeSummary(summaryOff))
  }, 30000)
})

// ---------------------------------------------------------------------------
// ATM-012: regression-lock
// ---------------------------------------------------------------------------
describe('ATM-012: regression-lock — interface snapshot + fault-injection', () => {
  test('ATM-012(a): CheckResult/Summary interface field names — zero diff vs the documented pristine shape', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'verification', 'verify.ts'), 'utf8')

    const checkResultMatch = source.match(/interface CheckResult \{([\s\S]*?)\}/)
    const summaryMatch = source.match(/interface Summary \{([\s\S]*?)\}/)
    expect(checkResultMatch).not.toBeNull()
    expect(summaryMatch).not.toBeNull()

    const extractFieldNames = (body: string): string[] =>
      body
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => l.split(':')[0]!.trim())
        .filter(Boolean)

    expect(extractFieldNames(checkResultMatch![1]!)).toEqual([
      'id',
      'description',
      'verified',
      'evidence',
      'checked_at',
    ])
    expect(extractFieldNames(summaryMatch![1]!)).toEqual([
      'timestamp',
      'total',
      'verified',
      'pending',
      'checks',
      'tests_pass',
      'test_output',
      'idle_count',
    ])
  })

  test('ATM-012(a): the additive persistence block lives strictly AFTER the summary.json write and the console.log loop (source-order check)', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'verification', 'verify.ts'), 'utf8')
    const writeIdx = source.indexOf('writeFileSync(SUMMARY_PATH')
    const consoleLoopIdx = source.lastIndexOf('console.log(`  ${c.verified')
    const blockIdx = source.indexOf('P6 Stage 5')
    expect(writeIdx).toBeGreaterThan(0)
    expect(consoleLoopIdx).toBeGreaterThan(writeIdx)
    expect(blockIdx).toBeGreaterThan(consoleLoopIdx)
  })

  test('ATM-012(b): fault-injection — a corrupt (non-sqlite) tasks.db at an EXISTING path, flag semantics irrelevant, leaves verify.ts exit code / console output / summary.json byte-identical (modulo timestamp/checked_at/idle_count) to a run with no db at all', () => {
    const tmpHomeNoDb = mkTmpHome()
    const { project: projectNoDb } = buildFixture(tmpHomeNoDb, true)
    // Remove the (validly-migrated) tasks.db this buildFixture created, so
    // this run has NO db file at all (verify.ts's existsSync gate skips the
    // whole persistence block).
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(join(projectNoDb, 'tasks.db') + suffix) } catch { /* fine */ }
    }
    const resultNoDb = runVerify(tmpHomeNoDb)
    const summaryNoDb = readSummary(projectNoDb)

    const tmpHomeCorrupt = mkTmpHome()
    const { project: projectCorrupt, dbPath: dbPathCorrupt } = buildFixture(tmpHomeCorrupt, true)
    // Corrupt the (existing) db file so `new Database(dbPath)` throws when
    // verify.ts's persistence block tries to open it.
    writeFileSync(dbPathCorrupt, 'this is not a valid sqlite file, at all')
    const resultCorrupt = runVerify(tmpHomeCorrupt)
    const summaryCorrupt = readSummary(projectCorrupt)

    expect(resultNoDb.exitCode).toBe(resultCorrupt.exitCode)
    expect(normalizeStdout(resultNoDb.stdout)).toBe(normalizeStdout(resultCorrupt.stdout))
    expect(normalizeSummary(summaryNoDb)).toEqual(normalizeSummary(summaryCorrupt))
  }, 30000)
})
