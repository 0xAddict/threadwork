import { describe, test, expect } from 'bun:test'
import { formatTaskCreated, formatTaskCompleted, formatTaskClaimed } from '../notify'

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
})
