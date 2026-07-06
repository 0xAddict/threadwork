#!/usr/bin/env bun
/**
 * memory-integrity-cli.ts — P4 Stage 7 KO-1 (#10376057).
 *
 * Shell hooks (session-boot.sh, mentor-memory-injector.sh, freshness-check.sh)
 * SELECT memories.content directly out of SQLite and print it into an
 * agent's context, bypassing the TS sanitizer entirely (sanitizeMemoryContent
 * only guards the save/consolidate write paths, not these read paths). This
 * CLI is the pipe-through choke point that closes that bypass: hooks route
 * each memory's content through this CLI instead of printing it raw, and it
 * reuses the exact SAME sanitizeMemoryContent primitive the TS side uses —
 * no parallel/divergent sanitization logic.
 *
 * Invocation:
 *   bun memory-integrity-cli.ts --sanitize-stdin [--source-type=<agent|system|human|consolidation>]
 *
 * Behavior (flag = feature_flags.memory_sanitization_enabled in the
 * task-board DB):
 *   - Flag readable & OFF (0): write stdin to stdout BYTE-IDENTICALLY (pure
 *     passthrough, no added/trimmed newline). Exit 0.
 *   - Flag readable & ON (1): write sanitizeMemoryContent(stdin, { sourceType
 *     }).text to stdout. Exit 0.
 *   - Flag UNREADABLE for ANY reason (DB file missing, open error, query
 *     error, malformed row, any exception): FAIL-CLOSED. Write NOTHING to
 *     stdout and exit non-zero. NEVER echo the raw input on error — a hook
 *     that can't confirm the flag state must emit nothing from memories
 *     rather than risk leaking unsanitized content.
 *
 * Side effects are intentionally limited to: reading stdin, opening the DB
 * read-only for the single flag query, and writing stdout. No server import,
 * no network, no writes.
 */
import { Database } from 'bun:sqlite'
import { sanitizeMemoryContent, type SourceType } from './memory-integrity'

const FAIL_CLOSED_EXIT = 3
const VALID_SOURCE_TYPES: SourceType[] = ['agent', 'system', 'human', 'consolidation']

function parseSourceType(argv: string[]): SourceType {
  const prefix = '--source-type='
  const arg = argv.find((a) => a.startsWith(prefix))
  const value = arg ? arg.slice(prefix.length) : 'agent'
  return (VALID_SOURCE_TYPES as string[]).includes(value) ? (value as SourceType) : 'agent'
}

function resolveDbPath(): string {
  return process.env.TASKBOARD_DB || `${process.env.HOME}/.claude/mcp-servers/task-board/tasks.db`
}

/**
 * Reads the memory_sanitization_enabled flag. Throws on ANY failure (missing
 * file, open error, missing table/column, missing row) — the caller treats
 * every exception here identically: fail-closed, no distinction needed.
 */
function readSanitizationFlag(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db
      .prepare("SELECT enabled FROM feature_flags WHERE flag_name = 'memory_sanitization_enabled'")
      .get() as { enabled: number } | null
    if (!row) throw new Error('memory_sanitization_enabled flag row not found')
    return !!row.enabled
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (!argv.includes('--sanitize-stdin')) {
    // Unknown invocation shape — fail-closed rather than guess at behavior.
    process.exitCode = FAIL_CLOSED_EXIT
    return
  }

  const sourceType = parseSourceType(argv)
  const input = await Bun.stdin.text()

  let flagOn: boolean
  try {
    flagOn = readSanitizationFlag(resolveDbPath())
  } catch {
    // FAIL-CLOSED: never fall back to raw content on a flag-read failure.
    process.exitCode = FAIL_CLOSED_EXIT
    return
  }

  if (!flagOn) {
    process.stdout.write(input)
    process.exitCode = 0
    return
  }

  const { text } = sanitizeMemoryContent(input, { sourceType })
  process.stdout.write(text)
  process.exitCode = 0
}

main()
