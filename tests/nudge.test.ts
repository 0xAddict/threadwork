import { describe, test, expect } from 'bun:test'
import { TMUX_PATH } from '../config'
import { buildNudgeCommand, buildNudgeSequence, resolveSession } from '../nudge'

describe('nudge', () => {
  test('resolveSession maps agent label to tmux session name', () => {
    expect(resolveSession('steve')).toBe('claude-steve')
    expect(resolveSession('boss')).toBe('claude-boss')
    expect(resolveSession('unknown-agent')).toBeNull()
  })

  test('buildNudgeCommand uses C-m (not Enter) as the submit keystroke', () => {
    const cmd = buildNudgeCommand(
      'claude-steve',
      'You have a new task (#5) from boss: Update landing page',
    )
    expect(cmd).toEqual([
      TMUX_PATH, 'send-keys', '-t', 'claude-steve',
      'You have a new task (#5) from boss: Update landing page',
      'C-m',
    ])
  })

  test('buildNudgeSequence returns Escape + literal-paste + C-m in order', () => {
    const [escapeCmd, literalCmd, cmCmd] = buildNudgeSequence('claude-steve', 'hello world')
    expect(escapeCmd).toEqual([TMUX_PATH, 'send-keys', '-t', 'claude-steve', 'Escape'])
    expect(literalCmd).toEqual([
      TMUX_PATH, 'send-keys', '-t', 'claude-steve', '-l', 'hello world',
    ])
    expect(cmCmd).toEqual([TMUX_PATH, 'send-keys', '-t', 'claude-steve', 'C-m'])
  })
})

// Sprint #256 guardrail tests (grep-based dispatcher boundary enforcement)
// have been moved to tests/guardrails/no-direct-nudge-paths.test.ts.
