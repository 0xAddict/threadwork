import { describe, test, expect } from 'bun:test'
import { formatTaskCreated, formatTaskCompleted, formatTaskClaimed, esc } from '../notify'

describe('notify formatting', () => {
  test('formatTaskCreated produces correct status message', () => {
    const msg = formatTaskCreated({
      id: 5, from_agent: 'boss', to_agent: 'steve',
      description: 'Update landing page copy', priority: 'high',
      status: 'pending', result: null,
      created_at: '2026-03-31 12:00:00', claimed_at: null, completed_at: null,
    })
    expect(msg).toContain('#5')
    expect(msg).toContain('boss')
    expect(msg).toContain('steve')
    expect(msg).toContain('Update landing page copy')
  })

  test('formatTaskCompleted includes result', () => {
    const msg = formatTaskCompleted({
      id: 5, from_agent: 'boss', to_agent: 'steve',
      description: 'Update landing page copy', priority: 'normal',
      status: 'completed', result: 'Done — updated hero text and CTA',
      created_at: '2026-03-31 12:00:00', claimed_at: '2026-03-31 12:01:00',
      completed_at: '2026-03-31 12:05:00',
    })
    expect(msg).toContain('#5')
    expect(msg).toContain('Done — updated hero text and CTA')
  })

  test('formatTaskClaimed shows agent claiming', () => {
    const msg = formatTaskClaimed({
      id: 5, from_agent: 'boss', to_agent: 'steve',
      description: 'Update landing page', priority: 'normal',
      status: 'in_progress', result: null,
      created_at: '2026-03-31 12:00:00', claimed_at: '2026-03-31 12:01:00',
      completed_at: null,
    })
    expect(msg).toContain('#5')
    expect(msg).toContain('steve')
  })

  test('esc function escapes MarkdownV2 special characters', () => {
    expect(esc('#')).toBe('\\#')
    expect(esc('Task #5')).toBe('Task \\#5')
    expect(esc('(test)')).toBe('\\(test\\)')
    expect(esc('hello.world')).toBe('hello\\.world')
    expect(esc('a-b')).toBe('a\\-b')
    expect(esc('plain')).toBe('plain')
  })

  test('esc null/undefined-safety (regression #902 — to_agent nullable since 20734cd)', () => {
    // Pre-patch this threw `TypeError: null is not an object (evaluating 'text.replace')`
    // and broke every create_task call with no `to` (backlog) and any nullable formatter input.
    expect(esc(null)).toBe('')
    expect(esc(undefined)).toBe('')
    // Empty string still routes through replace — should be a no-op, not a crash.
    expect(esc('')).toBe('')
  })

  test('formatTaskCreated handles null to_agent (backlog tasks) without throwing — #902', () => {
    // Migration 0007 (commit 20734cd) made to_agent nullable for the kanban backlog column.
    // formatTaskCreated must not throw on a backlog task.
    const msg = formatTaskCreated({
      id: 99, from_agent: 'boss', to_agent: null,
      description: 'Backlog task with no assignee', priority: 'normal',
      status: 'pending', result: null,
      created_at: '2026-05-06 14:00:00', claimed_at: null, completed_at: null,
    })
    expect(msg).toContain('#99')
    expect(msg).toContain('boss')
    expect(msg).toContain('Backlog task with no assignee')
  })

  test('esc is exported and usable for inline watchdog messages', () => {
    // This verifies the Sprint 2 fix: esc is now exported from notify.ts
    // so watchdog.ts can use it for inline postToGroup calls
    const msg = `Decision \\#${42} ready to finalize: "${esc('My Decision')}" \\- ${3} positions in\\.`
    expect(msg).toContain('\\#42')
    expect(msg).toContain('My Decision') // title is escaped but has no special chars here
    expect(msg).toContain('\\-')
    expect(msg).toContain('\\.')

    // Verify that a title with special chars gets properly escaped
    const msg2 = `Decision \\#${7} ready to finalize: "${esc('Use #hashtag (beta)')}" \\- ${2} positions in\\.`
    expect(msg2).toContain('\\#hashtag')
    expect(msg2).toContain('\\(beta\\)')
  })
})
