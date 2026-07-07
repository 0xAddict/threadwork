// agent-message-types.ts — P5 EPIC-06 msg_type registry (REQ-013 / ATM-016).
//
// PURE module — no imports with side effects, no runtime dependency on db.ts,
// config.ts, or server.ts. This is the SINGLE source of truth for valid
// `agent_messages.msg_type` values: the `send_directed_message` MCP tool's
// `inputSchema` declares `msg_type` as a JSON-Schema `enum` built from
// MSG_TYPES (server.ts), AND agent-messages.ts's sendDirectedMessage()
// independently re-validates every call against isValidMsgType() below — so
// a client bypassing the JSON-Schema layer entirely (e.g. a raw MCP call
// with an arbitrary string) is still rejected server-side.

export const MSG_TYPES = [
  'handoff',
  'data_request',
  'data_response',
  'status_update',
  'decision_ping',
  'custom',
] as const

export type MsgType = typeof MSG_TYPES[number]

/** Server-side re-validation, independent of (and never trusting) the JSON-Schema enum layer. */
export function isValidMsgType(x: unknown): x is MsgType {
  return typeof x === 'string' && (MSG_TYPES as readonly string[]).includes(x)
}
