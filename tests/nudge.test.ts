import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TMUX_PATH } from '../config'
import { buildNudgeCommand, buildNudgeSequence, resolveSession, configureNudgeDebounce } from '../nudge'
import { NUDGE_ACTIONS } from '../nudge-actions'
import { TaskDB } from '../db'
import { AuditLog } from '../audit'

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

/**
 * #921 regression — server.ts and watchdog.ts MUST call configureNudgeDebounce
 * at boot with the live audit instance. If they don't, _debounceAudit stays
 * null and logDelivered() silently no-ops, killing the nudge_sent /
 * agent_nudged audit trail (this happened from 2026-04-15 onward after
 * 93f6511 made the audit param optional).
 */
describe('nudge debounce boot wiring (#921)', () => {
  const REPO = resolve(__dirname, '..')

  test('server.ts calls configureNudgeDebounce with audit at boot', () => {
    const src = readFileSync(resolve(REPO, 'server.ts'), 'utf-8')
    expect(src).toMatch(/configureNudgeDebounce\s*\(\s*db\s*,\s*audit\s*\)/)
  })

  test('watchdog.ts calls configureNudgeDebounce with audit at boot', () => {
    const src = readFileSync(resolve(REPO, 'watchdog.ts'), 'utf-8')
    expect(src).toMatch(/configureNudgeDebounce\s*\(\s*taskDb\s*,\s*audit\s*\)/)
  })

  test('configureNudgeDebounce accepts (db, audit) without throwing', () => {
    const db = new TaskDB(':memory:')
    const audit = new AuditLog(db)
    expect(() => configureNudgeDebounce(db, audit)).not.toThrow()
  })

  test('configureNudgeDebounce accepts (db) alone — fail-safe preserved', () => {
    const db = new TaskDB(':memory:')
    expect(() => configureNudgeDebounce(db)).not.toThrow()
  })
})

/**
 * #929 regression — sendTmuxNudgeV2's verify loop false-negatives 100% on
 * busy/streaming panes (lastIndexOf over last-50-lines pane tail returns -1
 * once the streaming response rolls the needle off-tail). Pre-Fix-C, this
 * gated logDelivered() — so nudge_sent + agent_nudged audit rows went to
 * zero from 2026-04-15 onward. Fix-C decouples observability (verify) from
 * delivery (send-keys success): audit on send-keys-no-throw, verify-fail
 * surfaces as nudge_verify_warn.
 *
 * These are source-shape guardrails (matches the #921 regression style)
 * because the live tmux send path is gated behind NUDGE_DISABLED in test
 * mode, so we cannot exercise sendTmuxNudgeV2 directly from a unit test
 * without standing up a fake tmux binary. The shape assertions here ensure
 * the structural fix stays in place across refactors.
 */
describe('nudge verify decoupling (#929 Fix-C)', () => {
  const REPO = resolve(__dirname, '..')
  const NUDGE_SRC = readFileSync(resolve(REPO, 'nudge.ts'), 'utf-8')

  test('NUDGE_ACTIONS.VERIFY_WARN constant exists with canonical name', () => {
    expect(NUDGE_ACTIONS.VERIFY_WARN).toBe('nudge_verify_warn')
  })

  test('SendTmuxNudgeResult interface declares sentOk + verifyOk fields', () => {
    expect(NUDGE_SRC).toMatch(/interface\s+SendTmuxNudgeResult/)
    expect(NUDGE_SRC).toMatch(/sentOk\s*:\s*boolean/)
    expect(NUDGE_SRC).toMatch(/verifyOk\s*:\s*boolean/)
  })

  test('verify-pass path returns sentOk:true + verifyOk:true', () => {
    expect(NUDGE_SRC).toMatch(/return\s*\{\s*ok:\s*true,\s*sentOk:\s*true,\s*verifyOk:\s*true\s*\}/)
  })

  test('verify-fail path returns sentOk:true + verifyOk:false (nudge still considered delivered)', () => {
    // The terminal verify-fail return must have sentOk:true (send succeeded)
    // and verifyOk:false (verify is best-effort), with reason verify_failed.
    expect(NUDGE_SRC).toMatch(
      /ok:\s*true,\s*sentOk:\s*true,\s*verifyOk:\s*false,[\s\S]*?reason:\s*'verify_failed'/,
    )
  })

  test('send-keys/load-buffer error paths return sentOk:false + verifyOk:false', () => {
    // Every early-return for tmux/load-buffer/paste/C-m failures must report
    // sentOk:false. Count the explicit sentOk:false sites — there should be
    // at least 5 (empty, load_buffer_spawn, load_buffer_stdin, load_buffer_exit,
    // paste, C-m).
    const sentOkFalseMatches = NUDGE_SRC.match(/sentOk:\s*false/g) ?? []
    expect(sentOkFalseMatches.length).toBeGreaterThanOrEqual(5)
  })

  test('dispatchAgentNudge gates logDelivered on sendResult.sentOk (NOT sendResult.ok)', () => {
    // Pre-Fix-C the gate was `if (sendResult.ok)`; Fix-C must check sentOk so
    // verify-fail still emits nudge_sent + agent_nudged.
    const sentOkGates = NUDGE_SRC.match(/if\s*\(\s*sendResult\.sentOk\s*\)/g) ?? []
    expect(sentOkGates.length).toBeGreaterThanOrEqual(2) // both dispatch paths
  })

  test('dispatchAgentNudge emits VERIFY_WARN when sentOk=true but verifyOk=false', () => {
    expect(NUDGE_SRC).toMatch(/NUDGE_ACTIONS\.VERIFY_WARN/)
    // Specifically: the warn emission must be guarded by !sendResult.verifyOk
    expect(NUDGE_SRC).toMatch(/!sendResult\.verifyOk/)
  })

  test('VERIFY_WARN appears exactly twice in nudge.ts (one per dispatch path)', () => {
    const matches = NUDGE_SRC.match(/NUDGE_ACTIONS\.VERIFY_WARN/g) ?? []
    expect(matches.length).toBe(2)
  })
})
