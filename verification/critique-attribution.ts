// verification/critique-attribution.ts — T3 EPIC-03 (M-003) critic-side
// model-id adoption wrapper.
//
// resolveCallerModelId() reads the NEW `AGENT_MODEL_ID` environment variable —
// the calling session's own model id — mirroring the existing `AGENT_LABEL`
// pattern (config.ts:42). It is consumed at the `critique_position` call site as
// the SECOND-precedence source of `critic_model_id`:
//   explicit critic_model_id arg (highest, unchanged)
//     > resolveCallerModelId() (AGENT_MODEL_ID)          <- this module
//       > resolveAgentDefaultFamily(SELF_LABEL, registry) (EPIC-02 agent path)
//
// Producer-side auto-population is explicitly OUT OF SCOPE (P7-KO-5 adjacency):
// a critiquing session cannot know the PRODUCER's model without that agent
// self-reporting it, which submit_position does not capture at 900750f. So this
// module resolves ONLY the caller's (critic's) own model id.
//
// WRITING `AGENT_MODEL_ID` from launch/pool scripts (e.g. telegram-pool.sh) is
// an ops/deployment task, out of this spec's scope — this module only READS it.
//
// REQ-009 / ATM-008: pure, never-throws; returns `undefined` for an unset,
// empty, or whitespace-only value; returns the trimmed value otherwise. No I/O,
// no other imports.

/**
 * Resolve the calling agent-session's own model id from the `AGENT_MODEL_ID`
 * environment variable.
 *
 * @returns the trimmed `AGENT_MODEL_ID` when it is set to a non-empty
 *   (post-trim) string; `undefined` when the variable is unset, empty, or
 *   whitespace-only. Never throws.
 */
export function resolveCallerModelId(): string | undefined {
  const raw = process.env.AGENT_MODEL_ID
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
