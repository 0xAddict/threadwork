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
 * The closed set of value shapes assertJsonPlain() accepts — the exact
 * subset of `unknown` for which `JSON.stringify` is lossless. Recursive: an
 * array of JsonPlainValue, or a plain object whose own string-keyed values
 * are all JsonPlainValue.
 */
type JsonPlainValue = null | string | boolean | number | JsonPlainValue[] | { [key: string]: JsonPlainValue }

/**
 * R4 (REQ-014/ATM-017, bounded R4 residual — codex round-3 GENUINE HIGH
 * finding, "R2-1 residual"): strict recursive structural deep-check PLUS a
 * serialize-then-revalidate integrity check (Layer B — see the comment at
 * this function's call site in sendDirectedMessage(), immediately below). A
 * `JSON.stringify` round-trip is LOSSLESS only for a closed set of value
 * shapes — this function ACCEPTS exactly that set and REJECTS everything
 * else, including several values a bare `JSON.stringify()` accepts without
 * throwing but mangles silently:
 *
 *   - `Map` / `Set` / a class instance -> serializes to `{}` or a partial
 *     plain object (own enumerable data properties only; methods and
 *     internal slots are dropped).
 *   - `RegExp` -> serializes to `{}` (the source/flags are dropped).
 *   - `Error` -> serializes to `{}` (message/stack are non-enumerable).
 *   - `NaN` / `Infinity` / `-Infinity` -> silently coerced to `null`.
 *   - `Date` -> silently TYPE-CHANGES to an ISO string.
 *   - a callable `toJSON` (own — enumerable OR non-enumerable — OR
 *     inherited) -> `JSON.stringify` silently SUBSTITUTES `toJSON()`'s
 *     return value for the object being validated, so structurally
 *     validating the object itself proves nothing about what actually gets
 *     persisted.
 *   - an own non-enumerable data property, or an array's own non-index
 *     property -> `JSON.stringify` silently OMITS it from its output, so a
 *     naive `Object.keys()`/index-only walk never even sees it, yet the
 *     walked/validated structure and the persisted bytes diverge.
 *
 * Accepted (recursively): `null`, `string`, `boolean`, a FINITE `number`, a
 * plain `Array` (every index element recursively accepted, AND the array has
 * NO own property beyond its numeric indices + `length`), and a plain
 * `Object` — prototype is `Object.prototype` or `null` (an
 * `Object.create(null)` object), no symbol-keyed own properties, no callable
 * `toJSON`, every own string-keyed property value — enumerable OR
 * non-enumerable, walked via `Reflect.ownKeys`, NOT `Object.keys` — recursively
 * accepted.
 *
 * Rejected: `function`, `symbol`, `undefined`, a non-finite `number`
 * (`NaN`/`±Infinity`), `BigInt`, any value whose prototype is not
 * `Object.prototype`/`null` (this catches `Map`/`Set`/`RegExp`/`Date`/
 * `Error`/any custom class instance uniformly), a symbol-keyed own property
 * (object OR array), a callable `toJSON` at any node, an array's own
 * non-index property, and a circular reference (an ancestor object/array
 * re-appearing as its own descendant — tracked via a per-call `WeakSet` of
 * currently-open ancestors, so this ALSO subsumes the classic circular-ref
 * case without a separate check).
 *
 * `Date` is INTENTIONALLY rejected — this is a deliberate strict
 * plain-only reading of REQ-014's "reject any non-plain value whose JSON
 * round-trip is lossy" (a `Date` -> string type-change IS a lossy,
 * unrequested transformation of the caller's data). Callers that want to
 * persist a timestamp MUST pass an ISO string themselves
 * (`someDate.toISOString()`) rather than a live `Date` instance. (In
 * practice `Date.prototype.toJSON` means a `Date` is now rejected by the
 * callable-`toJSON` check below before it ever reaches the prototype check —
 * same outcome, reject, just via an earlier, more specific check.)
 *
 * Returns a NEW plain deep-clone of `value`, built during this SAME
 * recursive walk — each own-property value is read from the source EXACTLY
 * ONCE (never via `toJSON`, since a callable `toJSON` is rejected outright
 * before any clone-building happens at that node). sendDirectedMessage()
 * compares `JSON.stringify()` of this returned clone against a SEPARATE,
 * independent `JSON.stringify()` of the ORIGINAL payload — that
 * serialize-then-revalidate comparison is Layer B, and it is what catches a
 * stateful getter/proxy that returns a DIFFERENT value on its second read
 * than the value this walk already validated and cloned; a purely
 * structural check cannot see that divergence, since both reads look
 * identically "plain" in isolation.
 *
 * Every rejection throws an `Error` naming the offending JSON-path (e.g.
 * `$.a.b[2]`) and the value's runtime type/tag, so callers can locate the
 * bad value without a debugger.
 */
export function assertJsonPlain(
  value: unknown,
  path = '$',
  seen: WeakSet<object> = new WeakSet(),
): JsonPlainValue {
  if (value === null) return null

  const t = typeof value
  if (t === 'string' || t === 'boolean') return value as string | boolean

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(
        `sendDirectedMessage: payload contains a non-finite number (${String(value)}) at path ${path} — ` +
        `JSON has no representation for NaN/Infinity/-Infinity (JSON.stringify would silently emit "null")`
      )
    }
    return value as number
  }

  if (t === 'undefined') {
    throw new Error(`sendDirectedMessage: payload contains undefined at path ${path}`)
  }
  if (t === 'function') {
    throw new Error(`sendDirectedMessage: payload contains a function at path ${path}`)
  }
  if (t === 'symbol') {
    throw new Error(`sendDirectedMessage: payload contains a symbol at path ${path}`)
  }
  if (t === 'bigint') {
    throw new Error(
      `sendDirectedMessage: payload contains a BigInt (${String(value)}) at path ${path} — ` +
      `JSON.stringify cannot serialize BigInt; convert to a Number or String first`
    )
  }

  // t === 'object' from here on ('null' was already handled above).
  const obj = value as object

  if (seen.has(obj)) {
    throw new Error(`sendDirectedMessage: payload contains a circular reference at path ${path}`)
  }

  // [R4, Layer A] A callable `toJSON` — own, enumerable OR non-enumerable
  // (ordinary property lookup finds both), OR inherited via the prototype
  // chain — is exactly what `JSON.stringify` consults to SUBSTITUTE a
  // different value for this node. Reject unconditionally, before any
  // structural check or clone-building below: there is no sound way to
  // "validate" a node whose actual serialization is determined by a method
  // this walk never inspects.
  if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
    throw new Error(
      `sendDirectedMessage: payload contains a callable toJSON at path ${path} — ` +
      `JSON.stringify would substitute its return value for the structure being validated here`
    )
  }

  if (Array.isArray(obj)) {
    seen.add(obj)
    const arr = obj as unknown[]

    // [R4, Layer A] An array's numeric-index elements are all that
    // `JSON.stringify` actually emits for an array — any OTHER own property
    // (string or symbol) is silently dropped from the output. A prior
    // version of this validator only ever walked the index range, so an
    // extra own property was entirely invisible to it. Reject it explicitly
    // — a caller relying on that extra property deserves a clear error, not
    // silent loss.
    const ownArrayKeys = Reflect.ownKeys(arr)
    const expectedArrayKeys = new Set<string>(['length'])
    for (let i = 0; i < arr.length; i++) expectedArrayKeys.add(String(i))
    for (const key of ownArrayKeys) {
      if (typeof key === 'symbol') {
        throw new Error(`sendDirectedMessage: payload array contains a symbol-keyed own property at path ${path}`)
      }
      if (!expectedArrayKeys.has(key)) {
        throw new Error(
          `sendDirectedMessage: payload array contains a non-index own property "${key}" at path ${path} — ` +
          `arrays only serialize their numeric-index elements through JSON.stringify; extra own properties are silently dropped`
        )
      }
    }

    const clone: JsonPlainValue[] = new Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
      clone[i] = assertJsonPlain(arr[i], `${path}[${i}]`, seen)
    }
    seen.delete(obj)
    return clone
  }

  const proto = Object.getPrototypeOf(obj)
  if (proto !== Object.prototype && proto !== null) {
    // Uniformly catches Map/Set/RegExp/Date/Error/any custom class instance
    // — anything whose prototype chain isn't the plain-object baseline.
    const tag = Object.prototype.toString.call(obj)
    const ctorName = (obj as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'
    throw new Error(
      `sendDirectedMessage: payload contains a non-plain value (${tag}, constructor=${ctorName}) at path ${path} — ` +
      `only plain objects/arrays/strings/booleans/finite numbers/null round-trip losslessly through JSON. ` +
      `If this is a Date, pass its .toISOString() value instead.`
    )
  }

  // [R4, Layer A] `Reflect.ownKeys`, NOT `Object.keys` — walk EVERY own
  // string-keyed property, enumerable or not. A non-enumerable own data
  // property is invisible to `Object.keys()` yet `JSON.stringify` silently
  // OMITS it from its output too — walking (and cloning) it here is what
  // lets the Layer-B serialized-output comparison in sendDirectedMessage
  // catch the resulting divergence: the clone built below WILL contain that
  // property, while the real `JSON.stringify(payload)` never will.
  const ownKeys = Reflect.ownKeys(obj)
  const stringKeys: string[] = []
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      throw new Error(`sendDirectedMessage: payload contains a symbol-keyed property at path ${path}`)
    }
    stringKeys.push(key)
  }

  seen.add(obj)
  const clone: { [key: string]: JsonPlainValue } = {}
  for (const key of stringKeys) {
    // Single read: this is the ONLY time this property value is read during
    // this Layer-A walk. It is used to BOTH validate the value AND populate
    // the clone — never read twice here, so a stateful getter cannot
    // diverge from itself within this function. It CAN still diverge from
    // the SEPARATE read `JSON.stringify(args.payload)` performs in
    // sendDirectedMessage — that is exactly what Layer B is for.
    const propValue = (obj as Record<string, unknown>)[key]
    clone[key] = assertJsonPlain(propValue, `${path}.${key}`, seen)
  }
  seen.delete(obj)
  return clone
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
 *   4. payload must pass assertJsonPlain() — a strict, lossless-JSON-only
 *      structural check (REQ-014/ATM-017) — else throws, and no row is
 *      inserted.
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

  // [CLOSES R2-1, round-2 codex finding; STRENGTHENED for the bounded R4
  // residual, round-3 codex GENUINE HIGH] A throwing JSON.stringify replacer
  // only intercepts values JSON.stringify itself would either throw on
  // (circular refs, BigInt) or silently DROP (nested function/symbol/
  // undefined). It still ACCEPTS plenty of non-plain values that
  // JSON.stringify serializes WITHOUT throwing but LOSSILY — a Map/Set/
  // RegExp/Error/class-instance collapses to `{}` (or a partial plain
  // object), NaN/Infinity/-Infinity collapse to `null`, and a Date silently
  // TYPE-CHANGES to an ISO string. REQ-014 requires rejecting any
  // "non-plain value" whose JSON round-trip is lossy — not merely the
  // subset JSON.stringify refuses outright.
  //
  // Layer A (assertJsonPlain — strict recursive structural check): now also
  // (a) walks Reflect.ownKeys, not Object.keys, so a non-enumerable own
  // property is inspected rather than silently skipped; (b) rejects a
  // callable toJSON — own or inherited, enumerable or not — at any node,
  // since JSON.stringify would substitute its return value for whatever we
  // validated; (c) rejects an array's own non-index property. It returns a
  // plain deep-clone built DURING this same walk, each property value read
  // from the source exactly once.
  //
  // Layer B (serialize-then-revalidate, R4 fix): a structural check ALONE
  // cannot catch a STATEFUL getter/proxy that answers a DIFFERENT value on a
  // second read than the one Layer A already validated and cloned —
  // structurally, both reads look identically "plain" in isolation. So,
  // after Layer A passes, we independently JSON.stringify the ORIGINAL
  // payload (a second, separate read of every property) and compare it
  // byte-for-byte against JSON.stringify() of the Layer-A clone. ANY
  // divergence — a toJSON substitution, a non-enumerable property
  // JSON.stringify silently omits that our clone included, or a
  // getter/proxy that answered differently the second time — means the
  // bytes about to be persisted are NOT provably the JSON of what we just
  // validated, so we refuse to persist them rather than risk a lossy or
  // substituted payload reaching the database.
  const validatedClone = assertJsonPlain(args.payload)
  const payloadStr = JSON.stringify(args.payload) as string
  const clonedSerialization = JSON.stringify(validatedClone)
  if (clonedSerialization !== payloadStr) {
    throw new Error(
      `sendDirectedMessage: payload's JSON serialization diverges from its validated structure at $ — ` +
      `a toJSON/getter/proxy likely substituted or returned different content than what was validated; refusing to persist`
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

/** Shared MCP tool-content shape returned by the three handlers below. */
export type DirectedMessagingToolResult = { content: Array<{ type: 'text'; text: string; isError?: true }> }

/**
 * [R2-4 FIX, REQ-023/ATM-029, codex round-2 GENUINE HIGH] TESTABLE SEAM: the
 * ATM-029 disabled-tool contract was previously verified by grepping
 * server.ts's SOURCE TEXT for the string
 * `isFeatureEnabled('directed_messaging_enabled')` near each `case` block —
 * that proves the string appears in the file, never that the flag actually
 * gates anything at runtime (a handler could ignore the parsed boolean, or
 * the string could sit in an unreachable branch, and the source-grep test
 * would still pass). These three pure wrappers make the disabled-gate
 * directly INVOKABLE and observable:
 *   1. Each gates on `taskDb.isFeatureEnabled('directed_messaging_enabled')`
 *      and returns `directedMessagingDisabledError()` — calling NEITHER the
 *      wrapped core function NOR touching the database — when OFF.
 *   2. When ON, each calls its corresponding core function
 *      (sendDirectedMessage / pollDirectedMessages / ackDirectedMessage)
 *      and formats the result into the same MCP `{content:[...]}` shape
 *      server.ts's case handlers previously built inline.
 * agent-messages.ts stays PURE (no server.ts import): server.ts's three
 * case handlers now do nothing but
 * `return handle*Tool(db, SELF_LABEL, args[, opts])` — same signature
 * shape `(taskDb, selfLabel, args)` as the core functions they wrap, plus an
 * optional trailing `opts` on the send wrapper to carry the existing
 * ATM-024 nudge-on-send DI hook (constructed by server.ts, which is the
 * only place allowed to know about dispatchAgentNudge/nudge.ts).
 */
export function handleSendDirectedMessageTool(
  taskDb: TaskDB,
  selfLabel: string,
  args: Record<string, unknown>,
  opts?: SendDirectedMessageOptions,
): DirectedMessagingToolResult {
  if (!taskDb.isFeatureEnabled('directed_messaging_enabled')) {
    return directedMessagingDisabledError()
  }

  const row = sendDirectedMessage(
    taskDb,
    selfLabel,
    {
      recipient: args.recipient as string,
      msg_type: args.msg_type as string,
      payload: args.payload,
    },
    opts,
  )

  return {
    content: [{ type: 'text', text: `Message #${row.id} sent to ${row.recipient} (type: ${row.msg_type}, seq: ${row.seq}).` }],
  }
}

export function handlePollDirectedMessagesTool(
  taskDb: TaskDB,
  selfLabel: string,
  args: Record<string, unknown>,
): DirectedMessagingToolResult {
  if (!taskDb.isFeatureEnabled('directed_messaging_enabled')) {
    return directedMessagingDisabledError()
  }

  const rows = pollDirectedMessages(taskDb, selfLabel, {
    sinceSeq: typeof args.sinceSeq === 'number' ? (args.sinceSeq as number) : undefined,
    includeDelivered: args.includeDelivered === true,
  })

  return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
}

export function handleAckDirectedMessageTool(
  taskDb: TaskDB,
  selfLabel: string,
  args: Record<string, unknown>,
): DirectedMessagingToolResult {
  if (!taskDb.isFeatureEnabled('directed_messaging_enabled')) {
    return directedMessagingDisabledError()
  }

  const result = ackDirectedMessage(taskDb, selfLabel, args.message_id as number)
  return { content: [{ type: 'text', text: `Message #${args.message_id} ack result: ${result.status}` }] }
}
