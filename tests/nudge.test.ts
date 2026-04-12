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

// Sprint #256 guardrail tests (grep-based dispatcher boundary enforcement)
// have been moved to tests/guardrails/no-direct-nudge-paths.test.ts.
