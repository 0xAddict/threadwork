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
 * ATM-024 (P3, REQ-020, Stage 7) — OPTIONAL post-commit hook. Dependency
 * injection keeps the ATM-018 pure seam intact: agent-messages.ts never
 * imports nudge.ts itself; server.ts (which already imports dispatchAgentNudge)
 * supplies `onSent` when the `directed_messaging_nudge_on_send` flag is on.
 */
export interface SendDirectedMessageOptions {
  onSent?: (row: AgentMessageRow) => void
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
  opts?: SendDirectedMessageOptions,
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
    // [CLOSES finding H3] A plain `JSON.stringify(args.payload)` only catches
    // thrown failures (circular refs, BigInt) and the TOP-LEVEL undefined
    // case (handled below). A NESTED function/symbol/undefined object-
    // property value does not throw — JSON.stringify silently DROPS that
    // key, producing a lossy, partial payload that would otherwise persist
    // unnoticed. This throwing replacer is invoked for every nested value
    // (not just the top-level one), so any such value anywhere in the
    // payload throws instead of being dropped.
    payloadStr = JSON.stringify(args.payload, (key, value) => {
      if (typeof value === 'function' || typeof value === 'symbol') {
        throw new Error(`sendDirectedMessage: payload contains a non-serializable ${typeof value} value at key "${key}"`)
      }
      if (key !== '' && value === undefined) {
        // Nested `undefined` object-property values are silently DROPPED by
        // JSON.stringify (not merely coerced), which is exactly the
        // "partial data persisted" hazard REQ-014 requires closed. `key !==
        // ''` excludes the TOP-LEVEL call (key `''`), which is already
        // handled below via the classic "serialized to undefined" check —
        // this branch is only for values nested inside an object/array.
        throw new Error(`sendDirectedMessage: payload contains a nested undefined value at key "${key}" (would be silently dropped)`)
      }
      return value
    }) as string
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

  const row = withMemoryWriteTxn(taskDb.getHandle(), (db) => {
    const seq = nextWriteSeq(db)
    const inserted = db.prepare(`
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

    return inserted
  })

  // ATM-024 (P3, REQ-020): fires ONLY after the transaction above has
  // committed — a nudge is best-effort notification about an already-durable
  // send, never a condition of the send's success. Any throw from onSent
  // (sync or the caller's own try/catch obligations) is swallowed here so a
  // notification failure can NEVER roll back or fail the already-committed
  // send.
  if (opts?.onSent) {
    try {
      opts.onSent(row)
    } catch {
      // Swallow — see doc comment above.
    }
  }

  return row
}

// ---------------------------------------------------------------------------
// Stage 7 — ordered receive/poll/ack (ATM-020/021/022, REQ-016/017/018,
// deliver+ack portions of REQ-025/ATM-028).
// ---------------------------------------------------------------------------

export interface PollDirectedMessagesOptions {
  /**
   * Cursor: only CLAIM (pending->delivered) NEW rows with seq strictly
   * greater than this value. Does NOT filter the includeDelivered
   * redelivery branch — REQ-018 requires sinceSeq to be un-suppressible
   * for already-delivered-not-yet-acked rows (ATM-022b).
   */
  sinceSeq?: number
  /**
   * When true, ALSO return delivered-but-not-acked rows for the caller,
   * regardless of sinceSeq — the only thing that stops redelivery of a row
   * is it transitioning to 'acked' (ATM-022a/REQ-018).
   */
  includeDelivered?: boolean
}

/**
 * Poll for directed messages addressed to the caller (ATM-020, REQ-016,
 * C3/C4/C7).
 *
 *   - C4: there is deliberately NO caller-suppliable `recipient` parameter —
 *     the effective recipient is ALWAYS `selfLabel`.
 *   - C3: the claim is a SINGLE `UPDATE ... WHERE id IN (SELECT ...) RETURNING *`
 *     statement (never a separate SELECT-then-UPDATE, which would race under
 *     concurrent pollers). SQLite's RETURNING clause does not preserve the
 *     subquery's ORDER BY, so this function re-sorts the claimed rows by
 *     `seq` in application code before returning them.
 *   - C7/REQ-025: the claim UPDATE and its `directed_message_delivered`
 *     audit_log INSERT execute inside ONE withMemoryWriteTxn() call — an
 *     audit failure rolls back the claim, and a claim failure never reaches
 *     the audit INSERT. Fires only when at least one row was actually
 *     claimed (a poll that claims nothing has nothing to audit).
 *   - Never deletes a row — only transitions pending -> delivered (and,
 *     separately, ackDirectedMessage() transitions delivered -> acked).
 */
export function pollDirectedMessages(
  taskDb: TaskDB,
  selfLabel: string,
  opts?: PollDirectedMessagesOptions,
): AgentMessageRow[] {
  const sinceSeq = opts?.sinceSeq
  const includeDelivered = opts?.includeDelivered === true

  const rows = withMemoryWriteTxn(taskDb.getHandle(), (db) => {
    const claimed = (
      typeof sinceSeq === 'number'
        ? db.prepare(`
            UPDATE agent_messages
            SET status = 'delivered', delivered_at = datetime('now')
            WHERE id IN (
              SELECT id FROM agent_messages
              WHERE recipient = ? AND status = 'pending' AND seq > ?
            )
            RETURNING *
          `).all(selfLabel, sinceSeq)
        : db.prepare(`
            UPDATE agent_messages
            SET status = 'delivered', delivered_at = datetime('now')
            WHERE id IN (
              SELECT id FROM agent_messages
              WHERE recipient = ? AND status = 'pending'
            )
            RETURNING *
          `).all(selfLabel)
    ) as AgentMessageRow[]

    // REQ-025/C7 (deliver portion of ATM-028): SAME transaction as the claim
    // UPDATE above. Only emitted when something was actually claimed — a
    // poll that claims zero rows has no delivery event to audit.
    if (claimed.length > 0) {
      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, memory_id)
        VALUES (?, 'directed_message_delivered', ?, NULL)
      `).run(selfLabel, `count=${claimed.length} ids=${claimed.map((r) => r.id).join(',')}`)
    }

    if (!includeDelivered) {
      return claimed
    }

    // ATM-022(a)/REQ-018: also surface delivered-but-not-acked rows so a
    // caller that crashed/lost its previous claimed batch can re-observe
    // them. This SELECT deliberately ignores sinceSeq (ATM-022b) — it
    // already includes the rows this call just claimed (now status=
    // 'delivered') plus any delivered by a prior poll and never acked.
    const delivered = db.prepare(`
      SELECT * FROM agent_messages WHERE recipient = ? AND status = 'delivered'
    `).all(selfLabel) as AgentMessageRow[]

    const byId = new Map<number, AgentMessageRow>()
    for (const r of claimed) byId.set(r.id, r)
    for (const r of delivered) byId.set(r.id, r)
    return Array.from(byId.values())
  })

  // C3: RETURNING does not preserve subquery ORDER BY — sort in application
  // code, not SQL, and do it on the FINAL (possibly merged) array.
  return rows.slice().sort((a, b) => a.seq - b.seq)
}

export type AckDirectedMessageOutcome = 'acked' | 'noop_already_acked' | 'not_recipient' | 'not_found'

export interface AckDirectedMessageResult {
  status: AckDirectedMessageOutcome
  row?: AgentMessageRow
}

/**
 * A message with the given id exists but is addressed to a DIFFERENT
 * recipient than the caller. Exported for callers that prefer a thrown-error
 * style over inspecting `result.status` — ackDirectedMessage() itself never
 * throws this; it returns `{status: 'not_recipient'}` instead so the three
 * zero-mutation outcomes (not_recipient / not_found / noop_already_acked)
 * stay uniformly inspectable without a mixed throw/return API.
 */
export class NotRecipientError extends Error {
  constructor(message = 'ackDirectedMessage: message exists but is not addressed to this recipient') {
    super(message)
    this.name = 'NotRecipientError'
  }
}

/**
 * Acknowledge a directed message addressed to the caller (ATM-021, REQ-017,
 * C7).
 *
 * The claim UPDATE (`status != 'acked'` guard, so any row not yet acked —
 * pending OR delivered — can be acked directly) and its
 * `directed_message_acked` audit_log INSERT execute inside ONE
 * withMemoryWriteTxn() call (REQ-025/C7): an audit failure rolls back the
 * ack, and a claim failure never reaches the audit INSERT.
 *
 * On zero rows affected by the claim UPDATE, a second (read-only) SELECT by
 * id ALONE disambiguates why, producing three DISTINCT, never-conflated
 * outcomes:
 *   (a) row exists, recipient matches, status already 'acked' -> idempotent
 *       SUCCESS: `{status:'noop_already_acked', row}` — row/acked_at
 *       returned UNCHANGED, nothing is mutated or re-audited.
 *   (b) row exists but recipient !== selfLabel -> `{status:'not_recipient'}`
 *       — nothing is mutated.
 *   (c) no row with that id exists at all -> `{status:'not_found'}`.
 */
export function ackDirectedMessage(
  taskDb: TaskDB,
  selfLabel: string,
  messageId: number,
): AckDirectedMessageResult {
  return withMemoryWriteTxn(taskDb.getHandle(), (db) => {
    const claimed = db.prepare(`
      UPDATE agent_messages
      SET status = 'acked', acked_at = datetime('now')
      WHERE id = ? AND recipient = ? AND status != 'acked'
      RETURNING *
    `).get(messageId, selfLabel) as AgentMessageRow | null

    if (claimed) {
      // REQ-025/C7 (ack portion of ATM-028): SAME transaction as the claim
      // UPDATE above.
      db.prepare(`
        INSERT INTO audit_log (agent, action, detail, memory_id)
        VALUES (?, 'directed_message_acked', ?, NULL)
      `).run(selfLabel, `id=${messageId} seq=${claimed.seq}`)

      return { status: 'acked' as const, row: claimed }
    }

    // Zero rows affected by the claim UPDATE — disambiguate via a read-only
    // SELECT by id ALONE (never filtered by recipient, so we can tell a
    // wrong-recipient apart from a nonexistent id).
    const existing = db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(messageId) as AgentMessageRow | null

    if (!existing) {
      return { status: 'not_found' as const }
    }
    if (existing.recipient !== selfLabel) {
      return { status: 'not_recipient' as const }
    }
    // Only remaining possibility given the claim UPDATE's `status != 'acked'`
    // guard didn't match: recipient matches AND status is already 'acked'.
    return { status: 'noop_already_acked' as const, row: existing }
  })
}

/**
 * ATM-029 (REQ-023) structured disabled-error shape, shared by the
 * send/poll/ack MCP tool handlers in server.ts when
 * `directed_messaging_enabled` is OFF. Pure and importable without touching
 * server.ts, so its exact shape is unit-testable in isolation.
 */
export function directedMessagingDisabledError(): { content: Array<{ type: 'text'; text: string; isError: true }> } {
  return { content: [{ type: 'text', text: 'directed messaging is disabled', isError: true }] }
}
