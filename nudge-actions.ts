/**
 * Canonical nudge audit-log action strings.
 *
 * Sprint #256 (GOD_20260410_1052_7928) spec gate 6: all audit_log action
 * strings related to nudge delivery MUST be centralized in this one module.
 * Nothing in the codebase is allowed to write a nudge-related audit_log row
 * with a raw string literal — import from here.
 *
 * The SQL view `v_nudge_metrics_24h` in db.ts reads rows with these action
 * names; if you add a new constant, also update the view's IN clause (spec
 * gate 5).
 */

export const NUDGE_ACTIONS = {
  /** Caller invoked dispatchAgentNudge with intent to deliver. Always written first. */
  REQUESTED: 'nudge_requested',
  /** Debounce wrapper suppressed this nudge inside the active window. */
  SUPPRESSED: 'nudge_suppressed',
  /** Debounce wrapper fired this nudge. Written BEFORE the tmux send attempt. */
  FIRED: 'nudge_fired',
  /** Keystrokes successfully reached the tmux pane. Written AFTER send-keys succeeds. */
  SENT: 'nudge_sent',
  /** Keystrokes failed to reach the tmux pane (dead session, tmux error, etc). */
  DELIVERY_FAILED: 'nudge_delivery_failed',
  /** Legacy alias for SENT — kept for metrics continuity with pre-sprint-#256 audit rows. */
  AGENT_NUDGED_LEGACY: 'agent_nudged',
  /** Ctrl+C interrupt delivered to agent pane via dispatchAgentInterrupt. */
  INTERRUPTED: 'agent_interrupted',
  /**
   * Send-keys succeeded but post-submit delta-verify did not see the needle
   * advance past baseline (#929). Soft signal — nudge IS considered delivered
   * for audit purposes (nudge_sent + agent_nudged still emitted) because the
   * verify loop false-negatives on busy/streaming panes (lastIndexOf returns
   * -1 once the pane tail rolls past the needle). Use this row to spot panes
   * that may have actually missed delivery vs ones that just rolled fast.
   */
  VERIFY_WARN: 'nudge_verify_warn',
} as const

export type NudgeAction = typeof NUDGE_ACTIONS[keyof typeof NUDGE_ACTIONS]

/**
 * All nudge action strings as a flat array, for the SQL view and for
 * guardrail tests that need to enumerate every valid string.
 */
export const ALL_NUDGE_ACTIONS: readonly string[] = Object.values(NUDGE_ACTIONS)

/**
 * Action strings that `v_nudge_metrics_24h` must count.
 * Excludes REQUESTED (intent-only) because metrics track outcomes.
 */
export const METRICS_TRACKED_ACTIONS: readonly string[] = [
  NUDGE_ACTIONS.FIRED,
  NUDGE_ACTIONS.SUPPRESSED,
  NUDGE_ACTIONS.SENT,
  NUDGE_ACTIONS.DELIVERY_FAILED,
  NUDGE_ACTIONS.AGENT_NUDGED_LEGACY,
]
