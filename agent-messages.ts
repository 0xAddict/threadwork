// agent-messages.ts — P5 EPIC-06/EPIC-07 durable directed-message store.
//
// Stage 6 authors sendDirectedMessage() (ATM-018, REQ-015) + its REQ-025/C7
// audit-atomicity (send portion of ATM-028). pollDirectedMessages /
// ackDirectedMessage land in Stage 7.
//
// ATM-018 TESTABILITY SEAM (load-bearing): server.ts's top-level
// `await mcp.connect(...)` + `assertAgentIdentity()` run on import
// (server.ts:1906/1908, UNGUARDED) — importing server.ts anywhere triggers a
// live MCP connect. This module is therefore PURE and importable in complete
// isolation: its only imports are `bun:sqlite` (type-only), `./memory-ordering`,
// `./agent-message-types`, and `./config` (config.ts has no connect
// side-effect — verified). `TaskDB` is imported `type`-only from `./db`, which
// TypeScript erases entirely at compile time, so importing this module never
// touches db.ts's module graph, never opens a database handle, and never
// imports server.ts. Tests import this file directly and MUST NEVER import
// `../server`.

import type { TaskDB } from './db'
import { withMemoryWriteTxn, nextWriteSeq } from './memory-ordering'
import { isValidMsgType, MSG_TYPES } from './agent-message-types'
import { AGENT_SESSIONS } from './config'

export interface AgentMessageRow {
  id: number
  sender: string
  recipient: string
  msg_type: string
  payload: string
  seq: number
  status: 'pending' | 'delivered' | 'acked'
  created_at: string
  delivered_at: string | null
  acked_at: string | null
}

export interface SendDirectedMessageArgs {
  /**
   * NOTE: intentionally NO `sender` field on this interface. REQ-015(a):
   * sender is resolved EXCLUSIVELY from the caller's authenticated session
   * identity (the `selfLabel` parameter below), never from caller-suppliable
   * args. sendDirectedMessage() never reads `(args as any).sender`, so a
   * caller stuffing one in is silently ignored, not merely undocumented.
   */
  recipient: string
  msg_type: string
  payload: unknown
}

/**
 * Send a durable, typed directed message. ALWAYS wrapped in
 * withMemoryWriteTxn() — independent of `memory_write_ordering_enabled`
 * (REQ-015c is unconditional; that flag only gates memory.ts's write paths).
 *
 * Behavior (REQ-013/014/015, ATM-016/017/018, and the send portion of
 * REQ-025/ATM-028):
 *   1. sender = selfLabel (caller-identity-only, REQ-015a) — args.sender, if
 *      a caller supplies one, is never read.
 *   2. recipient must be a key of AGENT_SESSIONS (REQ-015b) — else throws.
 *   3. msg_type must pass isValidMsgType() (REQ-013/ATM-016), independent of
 *      whatever JSON-Schema `enum` the MCP layer already applied — else
 *      throws.
 *   4. payload must be JSON.stringify-serializable (REQ-014/ATM-017) — else
 *      throws, and no row is inserted.
 *   5. The INSERT (with a nextWriteSeq()-drawn `seq`) and its corresponding
 *      audit_log INSERT (`action='directed_message_sent'`) execute inside
 *      ONE withMemoryWriteTxn() call, so send + audit are all-or-nothing
 *      (REQ-025/C7, ATM-028 send portion).
 */
export function sendDirectedMessage(
  taskDb: TaskDB,
  selfLabel: string,
  args: SendDirectedMessageArgs,
): AgentMessageRow {
  const sender = selfLabel

  const recipient = args.recipient
  if (typeof recipient !== 'string' || !Object.prototype.hasOwnProperty.call(AGENT_SESSIONS, recipient)) {
    throw new Error(
      `sendDirectedMessage: unknown recipient "${String(recipient)}" — must be one of: ${Object.keys(AGENT_SESSIONS).join(', ')}`
    )
  }

  const msgType = args.msg_type
  if (!isValidMsgType(msgType)) {
    throw new Error(
      `sendDirectedMessage: invalid msg_type "${String(msgType)}" — must be one of: ${MSG_TYPES.join(', ')}`
    )
  }

  let payloadStr: string
  try {
    payloadStr = JSON.stringify(args.payload) as string
  } catch (err) {
    throw new Error(
      `sendDirectedMessage: payload is not JSON-serializable (${(err as Error)?.message ?? 'unknown error'})`
    )
  }
  if (typeof payloadStr !== 'string') {
    // JSON.stringify returns the VALUE `undefined` (not a thrown error) for
    // top-level values it cannot represent (undefined/function/symbol) —
    // REQ-014 requires this rejected just as loudly as a thrown circular ref.
    throw new Error(
      'sendDirectedMessage: payload serialized to undefined — value is not representable as JSON (e.g. undefined/function/symbol)'
    )
  }

  return withMemoryWriteTxn(taskDb.getHandle(), (db) => {
    const seq = nextWriteSeq(db)
    const row = db.prepare(`
      INSERT INTO agent_messages (sender, recipient, msg_type, payload, seq)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `).get(sender, recipient, msgType, payloadStr, seq) as AgentMessageRow

    // REQ-025/C7 (ATM-028 send portion): SAME transaction as the INSERT above
    // — an audit-INSERT failure rolls back the message row, and a message
    // INSERT failure never reaches this statement at all. All-or-nothing.
    db.prepare(`
      INSERT INTO audit_log (agent, action, detail, memory_id)
      VALUES (?, 'directed_message_sent', ?, NULL)
    `).run(sender, `to=${recipient} type=${msgType} seq=${seq}`)

    return row
  })
}
