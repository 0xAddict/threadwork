// verification/agent-family-registry.ts — T3 EPIC-01 registry loader.
//
// Source-of-truth decision (T3 spec, EPIC-01): the authoritative
// agent -> ModelFamily map lives in the sibling operator-maintained JSON
// file `config/agent-family-registry.json` (schema documented in the
// sibling `config/agent-family-registry.README.md`, NEVER inside the JSON
// itself). This module is the ONLY reader of that file — a pure,
// never-throwing loader that shapes the parsed result directly into
// `resolveAgentDefaultFamily()`'s (`./cross-family-critique.ts`) optional
// `registry` parameter.
//
// ATM-001/REQ-001: config/agent-family-registry.json is the sole
// authoritative source.
// ATM-002/REQ-002,REQ-003: loadAgentFamilyRegistry() parses it into a
// Readonly<Record<string, ModelFamily>>; on a missing file, unparseable
// JSON, or a value that isn't a member of the ModelFamily union, only the
// offending entries are dropped (or, for a missing/unparseable file, the
// whole file) — never throws, never returns worse than the frozen empty
// default.
// ATM-003/REQ-004: the parsed registry is cached in a module-level lazy
// singleton on the DEFAULT (no-argument) call path, so repeated production
// call sites do not re-read the file. An explicit `configPath` argument
// (test-only dependency injection) always bypasses the cache — see the
// TEST-ONLY note below.
//
// This module deliberately imports ONLY `ModelFamily` (type) and
// `ALL_MODEL_FAMILIES` (value, for membership checks) from
// `./cross-family-critique.ts` — zero edits to that module, zero other
// imports from it.

import * as fs from 'node:fs'
import { join } from 'node:path'
import type { ModelFamily } from './cross-family-critique'
import { ALL_MODEL_FAMILIES } from './cross-family-critique'

/** Frozen empty registry — the "no worse than" floor REQ-003 guarantees. */
const _EMPTY_AGENT_FAMILY_REGISTRY: Readonly<Record<string, ModelFamily>> = Object.freeze({})

/**
 * Absolute path to the operator-maintained registry config file, derived
 * from THIS module's own on-disk location (not `process.cwd()`) so the
 * loader resolves correctly regardless of the process's working directory
 * at test or runtime.
 */
const DEFAULT_CONFIG_PATH = join(import.meta.dir, '..', 'config', 'agent-family-registry.json')

/** Module-level lazy singleton cache — REQ-004/ATM-003. */
let _cachedRegistry: Readonly<Record<string, ModelFamily>> | undefined

function _isModelFamily(value: unknown): value is ModelFamily {
  return typeof value === 'string' && (ALL_MODEL_FAMILIES as readonly string[]).includes(value)
}

/**
 * Parse raw JSON text into a registry, dropping any entry whose value is
 * not a member of the ModelFamily union. Never throws: unparseable JSON or
 * a non-object top-level value degrades to the frozen empty registry.
 */
function _parseRegistry(raw: string): Readonly<Record<string, ModelFamily>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return _EMPTY_AGENT_FAMILY_REGISTRY
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return _EMPTY_AGENT_FAMILY_REGISTRY
  }
  const out: Record<string, ModelFamily> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (_isModelFamily(value)) {
      out[key] = value
    }
    // Offending entries (non-ModelFamily values) are silently dropped —
    // REQ-003. Non-string keys are impossible from JSON.parse'd objects.
  }
  return Object.freeze(out)
}

/** Read + parse a single path. Never throws: a missing/unreadable file degrades to empty. */
function _loadFromPath(configPath: string): Readonly<Record<string, ModelFamily>> {
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch {
    return _EMPTY_AGENT_FAMILY_REGISTRY
  }
  return _parseRegistry(raw)
}

/**
 * Load the authoritative agent -> ModelFamily registry.
 *
 * Production call sites invoke this with NO arguments: the result is
 * cached in a module-level singleton after the first successful load, so
 * `critique_position` does not re-read the file on every call (REQ-004).
 *
 * TEST-ONLY: an explicit `configPath` argument dependency-injects a
 * different file (e.g. a temp fixture) and always bypasses the singleton
 * cache — every call with an explicit path re-reads and re-parses that
 * path fresh. This lets tests exercise fixtures without mutating the real
 * config file and without needing to reset the singleton.
 *
 * Never throws (REQ-003).
 */
export function loadAgentFamilyRegistry(configPath?: string): Readonly<Record<string, ModelFamily>> {
  if (configPath !== undefined) {
    return _loadFromPath(configPath)
  }
  if (_cachedRegistry !== undefined) {
    return _cachedRegistry
  }
  _cachedRegistry = _loadFromPath(DEFAULT_CONFIG_PATH)
  return _cachedRegistry
}

/**
 * TEST-ONLY: reset the module-level singleton cache so a test can exercise
 * loadAgentFamilyRegistry()'s cold-cache (default-path) behavior. Never
 * called from production code.
 */
export function __resetAgentFamilyRegistryCacheForTests(): void {
  _cachedRegistry = undefined
}
