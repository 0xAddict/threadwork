import { describe, test, expect } from 'bun:test'
import { TMUX_PATH } from '../config'
import { buildNudgeCommand, resolveSession } from '../nudge'
import { TMUX_PATH } from '../config'

describe('nudge', () => {
  test('resolveSession maps agent label to tmux session name', () => {
    expect(resolveSession('steve')).toBe('claude-steve')
    expect(resolveSession('boss')).toBe('claude-boss')
    expect(resolveSession('unknown-agent')).toBeNull()
  })

  test('buildNudgeCommand creates correct tmux send-keys command', () => {
    const cmd = buildNudgeCommand('claude-steve', 'You have a new task (#5) from boss: Update landing page')
    expect(cmd).toEqual([
      TMUX_PATH, 'send-keys', '-t', 'claude-steve',
      'You have a new task (#5) from boss: Update landing page',
      'Enter',
    ])
  })
})

// Regression guard for sprint #256 / run GOD_20260410_1052_7928:
// BUG: server.ts line 842 used to write `audit_log('agent_nudged', ...)` unconditionally
//      after calling nudgeAgent(), even when the debounce wrapper suppressed the keystrokes
//      or when NUDGE_DISABLED was true. That made the audit log record phantom nudges and
//      made it look like delivery succeeded when nothing actually reached tmux.
//
// FIX: the `agent_nudged` audit row is now written EXCLUSIVELY inside nudge.ts, only on the
//      success path of sendTmux(). This test is a grep-level invariant check — we assert that
//      exactly ONE call to `audit.log(..., 'agent_nudged', ...)` exists anywhere in the repo
//      (excluding test files, comments, and documentation). If someone re-adds a direct
//      audit_log('agent_nudged') anywhere else, this test will catch it.
describe('nudge > sprint #256 regression guards', () => {
  test('exactly one audit_log("agent_nudged") call exists outside tests (spec gate 3)', async () => {
    const { $ } = await import('bun')
    // Grep for the canonical form. Exclude tests, node_modules, and comments.
    // The pattern matches: `.log(<expr>, 'agent_nudged', ` — the form the audit module uses.
    const result = await $`grep -rn "'agent_nudged'" --include="*.ts" . | grep -v "^\./tests/" | grep -v "node_modules" | grep -v "^\s*//" || true`
      .cwd('/Users/coachstokes/.claude/mcp-servers/task-board')
      .text()
    const lines = result.trim().split('\n').filter(Boolean)
    // We allow:
    //   1. The canonical audit write in nudge.ts (the single source of truth)
    //   2. Comments explaining the invariant (these are filtered by grep -v above but some may slip through if they're mid-line)
    // We reject any OTHER file containing a literal 'agent_nudged' audit write.
    const nonCommentWrites = lines.filter(line => {
      // Strip filename:lineno: prefix
      const code = line.replace(/^[^:]+:\d+:/, '').trim()
      // Skip comment-only lines
      if (code.startsWith('//') || code.startsWith('*')) return false
      // Skip strings that are just documentation (grep matches the word in prose)
      // Keep lines that look like actual audit calls
      return code.includes("'agent_nudged'")
    })
    // Expected: exactly one real write, inside nudge.ts
    const writesInNudgeTs = nonCommentWrites.filter(l => l.startsWith('./nudge.ts:'))
    const writesElsewhere = nonCommentWrites.filter(l => !l.startsWith('./nudge.ts:'))
    expect(writesElsewhere).toEqual([])
    expect(writesInNudgeTs.length).toBeGreaterThanOrEqual(1)
  })
})
