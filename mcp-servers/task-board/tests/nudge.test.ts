import { describe, test, expect } from 'bun:test'
import { buildNudgeCommand, resolveSession } from '../nudge'

describe('nudge', () => {
  test('resolveSession maps agent label to tmux session name', () => {
    expect(resolveSession('steve')).toBe('claude-steve')
    expect(resolveSession('boss')).toBe('claude-boss')
    expect(resolveSession('unknown-agent')).toBeNull()
  })

  test('buildNudgeCommand creates correct tmux send-keys command', () => {
    const cmd = buildNudgeCommand('claude-steve', 'You have a new task (#5) from boss: Update landing page')
    expect(cmd).toEqual([
      'tmux', 'send-keys', '-t', 'claude-steve',
      'You have a new task (#5) from boss: Update landing page',
      'Enter',
    ])
  })
})
