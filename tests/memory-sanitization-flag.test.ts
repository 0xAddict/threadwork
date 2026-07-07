// P4 — Anti-laundering memory sanitization, Stage 0 (#10376048).
// ATM-022: memory_sanitization_enabled feature flag is seeded default-OFF on TaskDB init.
// ATM-024: the generic setFeatureFlag/isFeatureEnabled helpers (db.ts:1957/1962) work for this flag.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'

const TEST_DB = '/tmp/task-board-memory-sanitization-flag-test.db'

function cleanup() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix) } catch {}
  }
}

describe('memory_sanitization_enabled feature flag (Stage 0)', () => {
  let db: TaskDB

  beforeEach(() => {
    cleanup()
    db = new TaskDB(TEST_DB)
  })

  afterEach(() => {
    cleanup()
  })

  test('ATM-022: a fresh TaskDB seeds memory_sanitization_enabled = 0', () => {
    const row = (db as any).db
      .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'memory_sanitization_enabled'")
      .get() as { enabled: number } | undefined
    expect(row).toBeTruthy()
    expect(row!.enabled).toBe(0)
  })

  test('ATM-022: isFeatureEnabled reports false by default', () => {
    expect(db.isFeatureEnabled('memory_sanitization_enabled')).toBe(false)
  })

  test('ATM-024: setFeatureFlag(true) then isFeatureEnabled() reflects the flip', () => {
    db.setFeatureFlag('memory_sanitization_enabled', true)
    expect(db.isFeatureEnabled('memory_sanitization_enabled')).toBe(true)
  })

  test('ATM-024: setFeatureFlag(false) flips it back off', () => {
    db.setFeatureFlag('memory_sanitization_enabled', true)
    db.setFeatureFlag('memory_sanitization_enabled', false)
    expect(db.isFeatureEnabled('memory_sanitization_enabled')).toBe(false)
  })

  test('ATM-022: re-running migrate (via a second TaskDB open on the same file) does not reset a flipped flag', () => {
    db.setFeatureFlag('memory_sanitization_enabled', true)
    const db2 = new TaskDB(TEST_DB)
    expect(db2.isFeatureEnabled('memory_sanitization_enabled')).toBe(true)
  })
})
