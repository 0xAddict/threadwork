/**
 * #1785 — board→team-chat bridge: deep-link + threading-format + nudge-digest unit tests.
 *
 * These cover the pure/format surfaces and the URL constant. The live Telegram
 * POST + per-card threading-store round-trip are exercised by the real-send
 * verification in the task (group -1003790554582), not here (no network in CI).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  formatTaskCreated,
  cardDeepLinkMd,
  escLinkUrl,
  nudgeThrottleDecision,
  __resetNudgeWindows,
} from '../notify'
import { cardDeepLink, DASHBOARD_CARD_URL_TEMPLATE } from '../config'

describe('#1785 deep-link', () => {
  test('cardDeepLink substitutes <id> into the template', () => {
    expect(cardDeepLink(42)).toBe(
      DASHBOARD_CARD_URL_TEMPLATE.replace('<id>', '42'),
    )
    expect(cardDeepLink(42)).toContain('card=42')
  })

  test('default template is the board?card=<id> shape (one-line change point)', () => {
    // Guards the single configurable constant. If Kiera #1601 finalizes a new
    // shape, this is the ONE line to update.
    expect(DASHBOARD_CARD_URL_TEMPLATE).toBe(
      'https://threadwork-dashboard.netlify.app/board?card=<id>',
    )
  })

  test('escLinkUrl only escapes ) and \\ (not . - ? = which would corrupt the URL)', () => {
    const url = 'https://x.app/board?card=5&a=b-c.d'
    const escaped = escLinkUrl(url)
    // Dots, dashes, ?, = must be preserved verbatim inside a MarkdownV2 link.
    expect(escaped).toContain('card=5')
    expect(escaped).toContain('b-c.d')
    expect(escaped).not.toContain('\\.')
    expect(escaped).not.toContain('\\-')
    // ) and backslash ARE escaped.
    expect(escLinkUrl('a)b')).toBe('a\\)b')
    expect(escLinkUrl('a\\b')).toBe('a\\\\b')
  })

  test('cardDeepLinkMd renders a MarkdownV2 inline link with the card url', () => {
    const md = cardDeepLinkMd(7)
    expect(md).toContain('[Open card]')
    expect(md).toContain('card=7')
    expect(md.startsWith('🔗 [Open card](')).toBe(true)
    expect(md.endsWith(')')).toBe(true)
  })

  test('formatTaskCreated now includes the deep-link spine line', () => {
    const msg = formatTaskCreated({
      id: 123, from_agent: 'boss', to_agent: 'sadie',
      description: 'bridge test', priority: 'normal',
      status: 'pending', result: null,
      created_at: '2026-06-11 12:00:00', claimed_at: null, completed_at: null,
    })
    expect(msg).toContain('#123')
    expect(msg).toContain('Open card')
    expect(msg).toContain('card=123')
  })
})

describe('#1785 nudge GROUP-CHAT digest (noise control)', () => {
  // Test the PURE throttle decision (nudgeThrottleDecision) — independent of
  // POST_DISABLED / real Telegram I/O. The throttle window default is 60s; we
  // drive `now` explicitly so the test is deterministic and fast.
  beforeEach(() => {
    __resetNudgeWindows()
  })
  afterEach(() => {
    __resetNudgeWindows()
  })

  test('rapid repeat nudges to the same target collapse — first posts, rest digest', () => {
    let posted = 0
    let collapsed = 0
    const target = 'steve'
    const t0 = 1_000_000
    // 8 nudges within the same 60s window (now advances by 1s each — still < 60s).
    for (let i = 0; i < 8; i++) {
      const d = nudgeThrottleDecision(target, false, t0 + i * 1000)
      d.post ? posted++ : collapsed++
    }
    expect(posted).toBe(1)
    expect(collapsed).toBe(7)
  })

  test('after the window elapses, the next nudge posts again with the collapsed roll-up count', () => {
    const target = 'sadie'
    const t0 = 2_000_000
    nudgeThrottleDecision(target, false, t0) // first post, opens window
    nudgeThrottleDecision(target, false, t0 + 1000) // collapsed (1)
    nudgeThrottleDecision(target, false, t0 + 2000) // collapsed (2)
    // Jump past the 60s window — next nudge posts and reports the 2 it collapsed.
    const d = nudgeThrottleDecision(target, false, t0 + 61_000)
    expect(d.post).toBe(true)
    expect(d.collapsed).toBe(2)
  })

  test('urgent nudges bypass the throttle entirely (escalations always surface)', () => {
    const d = nudgeThrottleDecision('kiera', true, 3_000_000)
    expect(d.post).toBe(true)
  })
})
