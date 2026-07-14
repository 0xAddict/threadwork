// tests/agent-family-registry.test.ts — T3 build-t3 packet: EPIC-04
// (ATM-011, flag registration) + EPIC-01 (ATM-001/002/003, registry
// source-of-truth + loader).
//
// PART 1 — EPIC-04 / ATM-011 (REQ-012): the new default-OFF
// `cross_family_attribution_enabled` flag registration in db.ts migrate().
//
// PART 2 — EPIC-01 / ATM-001 (REQ-001), ATM-002 (REQ-002/REQ-003),
// ATM-003 (REQ-004): config/agent-family-registry.json as the sole
// authoritative source, loadAgentFamilyRegistry()'s parse/degrade
// contract, and its module-level lazy-singleton cache.

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as fs from 'node:fs'
import { TaskDB } from '../db'
import { ALL_MODEL_FAMILIES } from '../verification/cross-family-critique'
import {
  loadAgentFamilyRegistry,
  __resetAgentFamilyRegistryCacheForTests,
} from '../verification/agent-family-registry'

const REPO_ROOT = resolve(__dirname, '..')
const REGISTRY_JSON_PATH = join(REPO_ROOT, 'config', 'agent-family-registry.json')
const REGISTRY_README_PATH = join(REPO_ROOT, 'config', 'agent-family-registry.README.md')

// ---------------------------------------------------------------------------
// PART 1 — EPIC-04 / ATM-011 (REQ-012)
// ---------------------------------------------------------------------------
describe('EPIC-04 ATM-011: cross_family_attribution_enabled flag registration (REQ-012)', () => {
  test('fresh in-memory DB → migrate() seeds cross_family_attribution_enabled=0, exactly one row', () => {
    const db = new TaskDB(':memory:')
    const rows = db.run(handle =>
      handle.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'cross_family_attribution_enabled'").all(),
    ) as { enabled: number }[]
    expect(rows.length).toBe(1)
    expect(rows[0]!.enabled).toBe(0)
    expect(db.isFeatureEnabled('cross_family_attribution_enabled')).toBe(false)
  })

  test('re-running migrate() (fresh TaskDB against the same file) is idempotent — flag unchanged', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'p-t3-flag-')), 'flag.db')
    try {
      const first = new TaskDB(dbPath)
      expect(first.isFeatureEnabled('cross_family_attribution_enabled')).toBe(false)

      // Re-running migrate() is exercised by constructing a fresh TaskDB
      // against the SAME file — matches the established idiom in
      // tests/cross-family-critique.test.ts's ATM-016.
      expect(() => new TaskDB(dbPath)).not.toThrow()
      const second = new TaskDB(dbPath)
      const rows = second.run(handle =>
        handle.prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'cross_family_attribution_enabled'").all(),
      ) as { enabled: number }[]
      expect(rows.length).toBe(1)
      expect(rows[0]!.enabled).toBe(0)
    } finally {
      rmSync(join(dbPath, '..'), { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// PART 2 — EPIC-01 / ATM-001 (REQ-001)
// ---------------------------------------------------------------------------
describe('EPIC-01 ATM-001: config/agent-family-registry.json is pure, valid JSON (REQ-001)', () => {
  test('JSON.parse succeeds on config/agent-family-registry.json', () => {
    const raw = readFileSync(REGISTRY_JSON_PATH, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('every key is a string and every value is a member of ALL_MODEL_FAMILIES', () => {
    const raw = readFileSync(REGISTRY_JSON_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = Object.keys(parsed)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(typeof key).toBe('string')
      const value = parsed[key]
      expect(typeof value).toBe('string')
      expect(ALL_MODEL_FAMILIES).toContain(value as (typeof ALL_MODEL_FAMILIES)[number])
    }
  })

  test('config/agent-family-registry.README.md exists (sibling schema note, not inside the JSON)', () => {
    expect(existsSync(REGISTRY_README_PATH)).toBe(true)
  })

  test('the JSON file itself contains no schema-doc comment markers (pure data)', () => {
    const raw = readFileSync(REGISTRY_JSON_PATH, 'utf8')
    // JSON has no comment syntax; this is a belt-and-suspenders sanity check
    // that nobody smuggled a "//"-prefixed pseudo-comment key/value in.
    expect(raw.includes('//')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PART 2 — EPIC-01 / ATM-002 (REQ-002, REQ-003)
// ---------------------------------------------------------------------------
describe('EPIC-01 ATM-002: loadAgentFamilyRegistry() parse + degrade-gracefully contract (REQ-002, REQ-003)', () => {
  let fixtureDir: string

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'p-t3-registry-fixture-'))
  })

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  test('(a) valid file → matching object', () => {
    const fixturePath = join(fixtureDir, 'valid.json')
    writeFileSync(fixturePath, JSON.stringify({ steve: 'anthropic', ghostwriter: 'openai' }))
    const registry = loadAgentFamilyRegistry(fixturePath)
    expect(registry).toEqual({ steve: 'anthropic', ghostwriter: 'openai' })
  })

  test('(b) missing file → frozen empty object, no throw', () => {
    const fixturePath = join(fixtureDir, 'does-not-exist.json')
    let registry: Readonly<Record<string, string>> | undefined
    expect(() => {
      registry = loadAgentFamilyRegistry(fixturePath)
    }).not.toThrow()
    expect(registry).toEqual({})
    expect(Object.isFrozen(registry)).toBe(true)
  })

  test('(c) malformed JSON → frozen empty object, no throw', () => {
    const fixturePath = join(fixtureDir, 'malformed.json')
    writeFileSync(fixturePath, '{ this is not valid json ][')
    let registry: Readonly<Record<string, string>> | undefined
    expect(() => {
      registry = loadAgentFamilyRegistry(fixturePath)
    }).not.toThrow()
    expect(registry).toEqual({})
    expect(Object.isFrozen(registry)).toBe(true)
  })

  test('(d) one bad value among good ones → bad key dropped, good keys retained', () => {
    const fixturePath = join(fixtureDir, 'partial-bad.json')
    writeFileSync(
      fixturePath,
      JSON.stringify({ boss: 'anthropic', sadie: 'not-a-real-model-family', kiera: 'google' }),
    )
    const registry = loadAgentFamilyRegistry(fixturePath)
    expect(registry).toEqual({ boss: 'anthropic', kiera: 'google' })
    expect(Object.keys(registry)).not.toContain('sadie')
  })

  test('top-level JSON array degrades to frozen empty object, no throw', () => {
    const fixturePath = join(fixtureDir, 'array.json')
    writeFileSync(fixturePath, JSON.stringify(['anthropic', 'openai']))
    let registry: Readonly<Record<string, string>> | undefined
    expect(() => {
      registry = loadAgentFamilyRegistry(fixturePath)
    }).not.toThrow()
    expect(registry).toEqual({})
  })

  test('the REAL config/agent-family-registry.json is untouched by these fixture writes', () => {
    // Guardrail: this describe block must never mutate the real config file.
    const raw = readFileSync(REGISTRY_JSON_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed).toEqual({
      boss: 'anthropic',
      steve: 'anthropic',
      sadie: 'anthropic',
      kiera: 'anthropic',
      snoopy: 'anthropic',
    })
  })
})

// ---------------------------------------------------------------------------
// PART 2 — EPIC-01 / ATM-003 (REQ-004)
// ---------------------------------------------------------------------------
describe('EPIC-01 ATM-003: loadAgentFamilyRegistry() module-level lazy-singleton cache (REQ-004)', () => {
  test('calling loadAgentFamilyRegistry() twice (default path) invokes fs.readFileSync exactly once', () => {
    // Cold cache: this test owns resetting the singleton so it is not
    // contaminated by any other test in this file/process that may have
    // already warmed it via the default (no-argument) call path.
    __resetAgentFamilyRegistryCacheForTests()

    // The loader module calls fs.readFileSync via a namespace import
    // (`import * as fs from 'node:fs'`) specifically so bun:test's spyOn
    // can patch that live ESM binding and observe the real call site —
    // the exact "namespace + spyOn" mechanism already used in this repo
    // (tests/cross-family-critique.test.ts's ATM-013).
    const spy = spyOn(fs, 'readFileSync')

    try {
      const first = loadAgentFamilyRegistry()
      const second = loadAgentFamilyRegistry()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(second).toBe(first) // same cached object identity, not just equal
    } finally {
      spy.mockRestore()
      __resetAgentFamilyRegistryCacheForTests()
    }
  })

  test('an explicit configPath argument bypasses the cache (re-reads every call)', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'p-t3-registry-cache-bypass-'))
    try {
      const fixturePath = join(fixtureDir, 'bypass.json')
      writeFileSync(fixturePath, JSON.stringify({ boss: 'anthropic' }))

      const spy = spyOn(fs, 'readFileSync')
      try {
        loadAgentFamilyRegistry(fixturePath)
        loadAgentFamilyRegistry(fixturePath)
        expect(spy).toHaveBeenCalledTimes(2)
      } finally {
        spy.mockRestore()
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})
