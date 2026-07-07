// tests/agent-messages.test.ts — P5 Stage 6 (EPIC-06): ATM-015, ATM-016,
// ATM-017, ATM-018, and the SEND portion of ATM-028 (REQ-025/C7 audit
// atomicity for send only — poll/ack land in Stage 7).
//
// Imports `../agent-messages`, `../agent-message-types`, `../db` — NEVER
// `../server` (server.ts connects to a live MCP transport + asserts agent
// identity at import time; agent-messages.ts is deliberately pure, per the
// ATM-018 testability seam).
//
// Every test opens its own explicit /tmp/p5-*-<uuid>.db TaskDB — NEVER
// `new TaskDB()` with no argument (that would hit the live DB_PATH default).

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { unlinkSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { TaskDB } from '../db'
import {
  sendDirectedMessage,
  pollDirectedMessages,
  ackDirectedMessage,
  directedMessagingDisabledError,
  handleSendDirectedMessageTool,
  handlePollDirectedMessagesTool,
  handleAckDirectedMessageTool,
  type AgentMessageRow,
} from '../agent-messages'
import { MSG_TYPES, isValidMsgType } from '../agent-message-types'

function tempDbPath(name: string): string {
  return `/tmp/p5-${name}-${crypto.randomUUID()}.db`
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

describe('ATM-015 — agent_messages schema', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm015')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('fresh migrate() creates agent_messages with the exact columns', () => {
    const cols = db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    const names = cols.map(c => c.name)
    expect(names).toEqual([
      'id', 'sender', 'recipient', 'msg_type', 'payload', 'seq',
      'status', 'created_at', 'delivered_at', 'acked_at',
    ])
  })

  test('the recipient/status/seq index exists', () => {
    const indexes = db.prepare("PRAGMA index_list(agent_messages)").all() as Array<{ name: string }>
    expect(indexes.some(i => i.name === 'idx_agent_messages_recipient_status')).toBe(true)
  })

  test('inserting status=\'bogus\' throws (CHECK constraint enforced)', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO agent_messages (sender, recipient, msg_type, payload, seq, status)
        VALUES ('boss', 'steve', 'status_update', '{}', 1, 'bogus')
      `).run()
    }).toThrow()

    const row = db.prepare("SELECT * FROM agent_messages WHERE sender = 'boss' AND recipient = 'steve'").get()
    expect(row).toBeNull()
  })

  test('a valid insert with status omitted defaults to \'pending\'', () => {
    const row = db.prepare(`
      INSERT INTO agent_messages (sender, recipient, msg_type, payload, seq)
      VALUES ('boss', 'steve', 'status_update', '{}', 1)
      RETURNING *
    `).get() as AgentMessageRow
    expect(row.status).toBe('pending')
    expect(row.delivered_at).toBeNull()
    expect(row.acked_at).toBeNull()
    expect(typeof row.created_at).toBe('string')
  })
})

describe('ATM-016 — msg_type registry validation', () => {
  let dbPath: string
  let taskDb: TaskDB

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm016')
    taskDb = new TaskDB(dbPath)
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('sendDirectedMessage rejects an msg_type outside the registry, bypassing the JSON-Schema layer entirely', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'not_a_real_type', payload: {} })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('every MSG_TYPES registry value succeeds', () => {
    for (const msgType of MSG_TYPES) {
      const row = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: msgType, payload: { msgType } })
      expect(row.msg_type).toBe(msgType)
    }
    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(MSG_TYPES.length)
  })

  test('isValidMsgType is a pure predicate independent of any JSON-Schema enum', () => {
    expect(isValidMsgType('handoff')).toBe(true)
    expect(isValidMsgType('custom')).toBe(true)
    expect(isValidMsgType('not_a_real_type')).toBe(false)
    expect(isValidMsgType(123)).toBe(false)
    expect(isValidMsgType(undefined)).toBe(false)
  })
})

describe('ATM-017 — payload JSON validation', () => {
  let dbPath: string
  let taskDb: TaskDB

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm017')
    taskDb = new TaskDB(dbPath)
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('a circular-reference payload is rejected and no row is inserted', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular

    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: circular })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a non-serializable top-level payload (undefined) is rejected and no row is inserted', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: undefined })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  // [CLOSES finding H3] JSON.stringify does NOT throw for a nested
  // function/symbol/undefined object-property value — it silently DROPS the
  // key, producing a lossy, partial payload that would otherwise persist.
  // These three assert rejection (no row inserted) for exactly that class of
  // nested non-serializable value, distinct from the top-level-undefined and
  // circular-reference cases above (which already throw natively).

  test('a nested function value is rejected and no row is inserted (would otherwise be silently dropped)', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { ok: true, cb: () => 'lost' } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a nested symbol value is rejected and no row is inserted (would otherwise be silently dropped)', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { ok: true, s: Symbol('x') } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a nested undefined object-property value is rejected and no row is inserted (would otherwise be silently dropped = partial data)', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { ok: true, u: undefined } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a plain-object payload succeeds and round-trips through JSON.parse', () => {
    const row = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { a: 1, b: 'x' } })
    expect(JSON.parse(row.payload)).toEqual({ a: 1, b: 'x' })
  })

  // -------------------------------------------------------------------------
  // R2-1 (codex round 2, GENUINE HIGH): the throwing-replacer approach only
  // rejects nested function/symbol/undefined. It still ACCEPTS non-plain
  // LOSSY values whose JSON round-trip silently mangles the data — REQ-014
  // requires rejecting ANY "non-plain value" whose JSON round-trip is lossy,
  // not merely the three JSON.stringify already refuses to serialize.
  // -------------------------------------------------------------------------

  test('a nested Map value is rejected and no row is inserted (JSON.stringify would lossily emit {})', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { m: new Map([['a', 1]]) } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a nested Set value is rejected and no row is inserted (JSON.stringify would lossily emit {})', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { s: new Set([1]) } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a nested RegExp value is rejected and no row is inserted (JSON.stringify would lossily emit {})', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { r: /re/ } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a nested Error value is rejected and no row is inserted (JSON.stringify would lossily emit {})', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { e: new Error('x') } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a NaN number value is rejected and no row is inserted (JSON.stringify would silently emit null)', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { n: NaN } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('an Infinity number value is rejected and no row is inserted (JSON.stringify would silently emit null)', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { n: Infinity } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a -Infinity number value is rejected and no row is inserted (JSON.stringify would silently emit null)', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { n: -Infinity } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a nested Date value is rejected and no row is inserted (JSON.stringify would silently type-change it to an ISO string)', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { d: new Date() } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a nested BigInt value is rejected and no row is inserted', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { b: 10n } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a class instance (non-plain prototype) is rejected and no row is inserted (JSON.stringify would emit a partial plain object)', () => {
    class Foo { constructor(public x: number) {} }
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload: { f: new Foo(1) } })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a deep plain payload is accepted and round-trips exactly through JSON.parse', () => {
    const payload = { a: 1, b: 'x', c: true, d: null, e: [1, 2, { f: 3.5 }], g: { h: false } }
    const row = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'custom', payload })
    expect(JSON.parse(row.payload)).toEqual(payload)

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(1)
  })
})

describe('ATM-018 — sendDirectedMessage identity/recipient discipline + testability seam', () => {
  let dbPath: string
  let taskDb: TaskDB

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm018')
    taskDb = new TaskDB(dbPath)
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('importing agent-messages.ts (already done at module load, above) did not throw/hang/attempt a connection', () => {
    // The mere fact this test file loaded and reached this line, having
    // imported sendDirectedMessage directly from '../agent-messages' (never
    // '../server') at the top of the file, IS the assertion: no connect-on-
    // import side effect fired. This test exists to make that fact explicit
    // and documented, not to perform additional runtime work.
    expect(typeof sendDirectedMessage).toBe('function')
  })

  test('sender is resolved from selfLabel — a caller-supplied `sender` field in args is ignored', () => {
    const row = sendDirectedMessage(
      taskDb,
      'steve',
      // Cast through `any` to smuggle in an extra `sender` field the
      // SendDirectedMessageArgs type doesn't declare — proving
      // sendDirectedMessage() never reads it even if a raw MCP call supplied one.
      { recipient: 'boss', msg_type: 'status_update', payload: {}, sender: 'boss' } as any,
    )
    expect(row.sender).toBe('steve')
  })

  test('an unknown recipient is rejected with a clear error and no row inserted', () => {
    expect(() => {
      sendDirectedMessage(taskDb, 'boss', { recipient: 'not-a-real-agent', msg_type: 'status_update', payload: {} })
    }).toThrow()

    const count = (taskDb.getHandle().prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('a successful send is stamped with a distinct write_sequence-derived seq and returns the full row', () => {
    const row = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'handoff', payload: { note: 'hi' } })
    expect(row.id).toBeGreaterThan(0)
    expect(row.sender).toBe('boss')
    expect(row.recipient).toBe('steve')
    expect(row.msg_type).toBe('handoff')
    expect(row.status).toBe('pending')
    expect(typeof row.seq).toBe('number')
    expect(row.seq).toBeGreaterThan(0)
  })
})

describe('ATM-028 (send portion) — audit_log atomicity for directed_message_sent', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm028')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('a send produces exactly one audit_log row action=\'directed_message_sent\'', () => {
    const row = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: { ok: true } })

    const auditRows = db.prepare(
      "SELECT agent, action, detail FROM audit_log WHERE action = 'directed_message_sent'"
    ).all() as Array<{ agent: string; action: string; detail: string }>

    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].agent).toBe('boss')
    expect(auditRows[0].detail).toContain('to=steve')
    expect(auditRows[0].detail).toContain('type=status_update')
    expect(auditRows[0].detail).toContain(`seq=${row.seq}`)
  })

  test('FAULT-INJECTION: the message INSERT throwing leaves NO orphaned directed_message_sent audit row', () => {
    const original = db.prepare.bind(db)
    const prepareSpy = spyOn(db, 'prepare').mockImplementation((sql: any, ...rest: any[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO agent_messages')) {
        return {
          get: () => { throw new Error('atm028 simulated agent_messages INSERT fault') },
          run: () => { throw new Error('atm028 simulated agent_messages INSERT fault') },
        } as any
      }
      return original(sql, ...rest)
    })

    try {
      expect(() => {
        sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: { ok: true } })
      }).toThrow('atm028 simulated agent_messages INSERT fault')
    } finally {
      prepareSpy.mockRestore()
    }

    const auditCount = (db.prepare(
      "SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_sent'"
    ).get() as { c: number }).c
    expect(auditCount).toBe(0)

    const msgCount = (db.prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(msgCount).toBe(0)
  })

  test('FAULT-INJECTION: the audit_log INSERT throwing rolls back the message INSERT too (no orphaned mutation)', () => {
    const original = db.prepare.bind(db)
    const prepareSpy = spyOn(db, 'prepare').mockImplementation((sql: any, ...rest: any[]) => {
      if (typeof sql === 'string' && sql.includes("INSERT INTO audit_log") && sql.includes('directed_message_sent')) {
        return {
          get: () => { throw new Error('atm028 simulated audit_log INSERT fault') },
          run: () => { throw new Error('atm028 simulated audit_log INSERT fault') },
        } as any
      }
      return original(sql, ...rest)
    })

    try {
      expect(() => {
        sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: { ok: true } })
      }).toThrow('atm028 simulated audit_log INSERT fault')
    } finally {
      prepareSpy.mockRestore()
    }

    const msgCount = (db.prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(msgCount).toBe(0)

    const auditCount = (db.prepare(
      "SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_sent'"
    ).get() as { c: number }).c
    expect(auditCount).toBe(0)
  })
})

// =============================================================================
// Stage 7 (EPIC-07): ordered receive/poll/ack — ATM-020/021/022, deliver+ack
// portions of ATM-028 (REQ-025/C7), ATM-024 (P3), ATM-029 (REQ-023).
// =============================================================================

describe('ATM-020 — pollDirectedMessages ordering + cross-agent isolation', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm020')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('ATM-020(a): 3 messages from distinct senders arrive strictly seq-ascending; a second pending-only poll is empty; rows are not deleted', () => {
    sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: { n: 1 } })
    sendDirectedMessage(taskDb, 'sadie', { recipient: 'steve', msg_type: 'status_update', payload: { n: 2 } })
    sendDirectedMessage(taskDb, 'kiera', { recipient: 'steve', msg_type: 'status_update', payload: { n: 3 } })

    const first = pollDirectedMessages(taskDb, 'steve')
    expect(first).toHaveLength(3)
    for (let i = 0; i < first.length - 1; i++) {
      expect(first[i].seq).toBeLessThan(first[i + 1].seq)
    }
    expect(first.every((r) => r.status === 'delivered')).toBe(true)

    const second = pollDirectedMessages(taskDb, 'steve')
    expect(second).toEqual([])

    // Rows are transitioned, never deleted.
    const count = (db.prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
    expect(count).toBe(3)
  })

  test('ATM-020(c) cross-agent negative: messages addressed to boss only; polling as steve returns [] and boss\'s pending rows are untouched', () => {
    sendDirectedMessage(taskDb, 'sadie', { recipient: 'boss', msg_type: 'status_update', payload: {} })
    sendDirectedMessage(taskDb, 'kiera', { recipient: 'boss', msg_type: 'status_update', payload: {} })

    const result = pollDirectedMessages(taskDb, 'steve')
    expect(result).toEqual([])

    const bossRows = db.prepare("SELECT status FROM agent_messages WHERE recipient = 'boss'").all() as Array<{ status: string }>
    expect(bossRows).toHaveLength(2)
    expect(bossRows.every((r) => r.status === 'pending')).toBe(true)
  })
})

describe('ATM-021 — ackDirectedMessage idempotency + cross-agent negative', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm021')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('ATM-021(a): ack idempotency — acking twice is a no-op success the second time, acked_at unchanged, no second audit row', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })
    pollDirectedMessages(taskDb, 'steve')

    const first = ackDirectedMessage(taskDb, 'steve', sent.id)
    expect(first.status).toBe('acked')
    expect(first.row?.acked_at).toBeTruthy()
    const firstAckedAt = first.row!.acked_at

    const second = ackDirectedMessage(taskDb, 'steve', sent.id)
    expect(second.status).toBe('noop_already_acked')
    expect(second.row?.acked_at).toBe(firstAckedAt)

    // Only ONE ack event was ever audited — the no-op second call did not
    // re-mutate or re-audit (this holds regardless of datetime('now')'s
    // second-level granularity, unlike a bare acked_at-equality check alone).
    const auditCount = (
      db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_acked'").get() as { c: number }
    ).c
    expect(auditCount).toBe(1)
  })

  test('ATM-021(b) cross-agent negative: acking as a non-recipient yields a distinct not_recipient outcome and mutates nothing', () => {
    const sent = sendDirectedMessage(taskDb, 'sadie', { recipient: 'boss', msg_type: 'status_update', payload: {} })
    pollDirectedMessages(taskDb, 'boss')

    const result = ackDirectedMessage(taskDb, 'steve', sent.id)
    expect(result.status).toBe('not_recipient')
    expect(result.status).not.toBe('noop_already_acked')
    expect(result.row).toBeUndefined()

    const row = db.prepare('SELECT status, acked_at FROM agent_messages WHERE id = ?').get(sent.id) as {
      status: string
      acked_at: string | null
    }
    expect(row.status).toBe('delivered')
    expect(row.acked_at).toBeNull()
  })

  test('ackDirectedMessage on a nonexistent id returns a distinct not_found outcome', () => {
    const result = ackDirectedMessage(taskDb, 'steve', 999999)
    expect(result.status).toBe('not_found')
    expect(result.row).toBeUndefined()
  })
})

describe('ATM-022 — includeDelivered redelivery + sinceSeq cannot suppress it', () => {
  let dbPath: string
  let taskDb: TaskDB

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm022')
    taskDb = new TaskDB(dbPath)
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('ATM-022(a): a delivered-not-acked row is redelivered via includeDelivered; stops being redelivered once acked', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })

    const firstPoll = pollDirectedMessages(taskDb, 'steve')
    expect(firstPoll.map((r) => r.id)).toEqual([sent.id])

    // Without acking, poll again with includeDelivered — same row comes back.
    const secondPoll = pollDirectedMessages(taskDb, 'steve', { includeDelivered: true })
    expect(secondPoll.map((r) => r.id)).toEqual([sent.id])
    expect(secondPoll[0].status).toBe('delivered')

    ackDirectedMessage(taskDb, 'steve', sent.id)

    // Now that it's acked, includeDelivered no longer surfaces it.
    const thirdPoll = pollDirectedMessages(taskDb, 'steve', { includeDelivered: true })
    expect(thirdPoll).toEqual([])
  })

  test('ATM-022(b): sinceSeq cannot suppress includeDelivered redelivery of an already-delivered row', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })
    const [delivered] = pollDirectedMessages(taskDb, 'steve')
    expect(delivered.seq).toBe(sent.seq)

    // sinceSeq === the row's own seq would normally exclude it from a NEW
    // pending claim, but includeDelivered's redelivery branch ignores
    // sinceSeq entirely — the row must still come back.
    const poll = pollDirectedMessages(taskDb, 'steve', { includeDelivered: true, sinceSeq: delivered.seq })
    expect(poll.map((r) => r.id)).toEqual([sent.id])
  })
})

describe('ATM-028 (deliver/ack portion) — audit_log atomicity for directed_message_delivered/_acked', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm028de')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('a send -> poll -> ack cycle on one message produces exactly one audit row of each action, in that order', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })
    const polled = pollDirectedMessages(taskDb, 'steve')
    expect(polled).toHaveLength(1)
    const ackResult = ackDirectedMessage(taskDb, 'steve', sent.id)
    expect(ackResult.status).toBe('acked')

    const auditRows = db.prepare(
      `SELECT action FROM audit_log
       WHERE action IN ('directed_message_sent', 'directed_message_delivered', 'directed_message_acked')
       ORDER BY id ASC`
    ).all() as Array<{ action: string }>

    expect(auditRows.map((r) => r.action)).toEqual([
      'directed_message_sent',
      'directed_message_delivered',
      'directed_message_acked',
    ])
  })

  test('FAULT-INJECTION: the poll claim UPDATE throwing leaves no directed_message_delivered audit row (message stays pending)', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })

    const original = db.prepare.bind(db)
    const prepareSpy = spyOn(db, 'prepare').mockImplementation((sql: any, ...rest: any[]) => {
      if (typeof sql === 'string' && sql.includes("SET status = 'delivered'")) {
        return {
          get: () => { throw new Error('atm028-deliver simulated claim UPDATE fault') },
          all: () => { throw new Error('atm028-deliver simulated claim UPDATE fault') },
          run: () => { throw new Error('atm028-deliver simulated claim UPDATE fault') },
        } as any
      }
      return original(sql, ...rest)
    })

    try {
      expect(() => pollDirectedMessages(taskDb, 'steve')).toThrow('atm028-deliver simulated claim UPDATE fault')
    } finally {
      prepareSpy.mockRestore()
    }

    const row = db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(sent.id) as { status: string }
    expect(row.status).toBe('pending')

    const auditCount = (
      db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_delivered'").get() as { c: number }
    ).c
    expect(auditCount).toBe(0)
  })

  test('FAULT-INJECTION: the poll directed_message_delivered audit INSERT throwing rolls back the claim too (message stays pending)', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })

    const original = db.prepare.bind(db)
    const prepareSpy = spyOn(db, 'prepare').mockImplementation((sql: any, ...rest: any[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO audit_log') && sql.includes('directed_message_delivered')) {
        return {
          get: () => { throw new Error('atm028-deliver simulated audit INSERT fault') },
          all: () => { throw new Error('atm028-deliver simulated audit INSERT fault') },
          run: () => { throw new Error('atm028-deliver simulated audit INSERT fault') },
        } as any
      }
      return original(sql, ...rest)
    })

    try {
      expect(() => pollDirectedMessages(taskDb, 'steve')).toThrow('atm028-deliver simulated audit INSERT fault')
    } finally {
      prepareSpy.mockRestore()
    }

    const row = db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(sent.id) as { status: string }
    expect(row.status).toBe('pending')

    const auditCount = (
      db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_delivered'").get() as { c: number }
    ).c
    expect(auditCount).toBe(0)
  })

  test('FAULT-INJECTION: the ack claim UPDATE throwing leaves no directed_message_acked audit row (message stays delivered)', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })
    pollDirectedMessages(taskDb, 'steve')

    const original = db.prepare.bind(db)
    const prepareSpy = spyOn(db, 'prepare').mockImplementation((sql: any, ...rest: any[]) => {
      if (typeof sql === 'string' && sql.includes("SET status = 'acked'")) {
        return {
          get: () => { throw new Error('atm028-ack simulated claim UPDATE fault') },
          all: () => { throw new Error('atm028-ack simulated claim UPDATE fault') },
          run: () => { throw new Error('atm028-ack simulated claim UPDATE fault') },
        } as any
      }
      return original(sql, ...rest)
    })

    try {
      expect(() => ackDirectedMessage(taskDb, 'steve', sent.id)).toThrow('atm028-ack simulated claim UPDATE fault')
    } finally {
      prepareSpy.mockRestore()
    }

    const row = db.prepare('SELECT status, acked_at FROM agent_messages WHERE id = ?').get(sent.id) as {
      status: string
      acked_at: string | null
    }
    expect(row.status).toBe('delivered')
    expect(row.acked_at).toBeNull()

    const auditCount = (
      db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_acked'").get() as { c: number }
    ).c
    expect(auditCount).toBe(0)
  })

  test('FAULT-INJECTION: the ack directed_message_acked audit INSERT throwing rolls back the claim too (message stays delivered)', () => {
    const sent = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })
    pollDirectedMessages(taskDb, 'steve')

    const original = db.prepare.bind(db)
    const prepareSpy = spyOn(db, 'prepare').mockImplementation((sql: any, ...rest: any[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO audit_log') && sql.includes('directed_message_acked')) {
        return {
          get: () => { throw new Error('atm028-ack simulated audit INSERT fault') },
          all: () => { throw new Error('atm028-ack simulated audit INSERT fault') },
          run: () => { throw new Error('atm028-ack simulated audit INSERT fault') },
        } as any
      }
      return original(sql, ...rest)
    })

    try {
      expect(() => ackDirectedMessage(taskDb, 'steve', sent.id)).toThrow('atm028-ack simulated audit INSERT fault')
    } finally {
      prepareSpy.mockRestore()
    }

    const row = db.prepare('SELECT status, acked_at FROM agent_messages WHERE id = ?').get(sent.id) as {
      status: string
      acked_at: string | null
    }
    expect(row.status).toBe('delivered')
    expect(row.acked_at).toBeNull()

    const auditCount = (
      db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'directed_message_acked'").get() as { c: number }
    ).c
    expect(auditCount).toBe(0)
  })
})

describe('ATM-024 — optional post-commit onSent hook (P3, nudge-on-send)', () => {
  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm024')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  test('onSent is invoked with the already-committed row', () => {
    let receivedRow: AgentMessageRow | undefined
    const row = sendDirectedMessage(
      taskDb,
      'boss',
      { recipient: 'steve', msg_type: 'status_update', payload: {} },
      { onSent: (r) => { receivedRow = r } },
    )

    expect(receivedRow).toBeDefined()
    expect(receivedRow!.id).toBe(row.id)

    // The row is already durably committed and queryable by the time onSent fires.
    const persisted = db.prepare('SELECT id FROM agent_messages WHERE id = ?').get(row.id)
    expect(persisted).not.toBeNull()
  })

  test('an onSent that throws does not affect the returned row or roll back the already-committed send', () => {
    const row = sendDirectedMessage(
      taskDb,
      'boss',
      { recipient: 'steve', msg_type: 'status_update', payload: {} },
      { onSent: () => { throw new Error('simulated nudge failure') } },
    )

    expect(row.id).toBeGreaterThan(0)

    const persisted = db.prepare('SELECT id, status FROM agent_messages WHERE id = ?').get(row.id) as {
      id: number
      status: string
    }
    expect(persisted.status).toBe('pending')
  })

  test('omitting opts entirely (no onSent) behaves exactly as the Stage 6 3-arg call', () => {
    const row = sendDirectedMessage(taskDb, 'boss', { recipient: 'steve', msg_type: 'status_update', payload: {} })
    expect(row.status).toBe('pending')
  })
})

describe('ATM-029 — directed-messaging tool handlers actually enforce the disabled gate (INVOCATION, not source-grep)', () => {
  // [R2-4 FIX, codex round-2 GENUINE HIGH] The PREVIOUS version of this
  // block only grepped server.ts's source text for the literal string
  // `isFeatureEnabled('directed_messaging_enabled')` near each `case`
  // block — that proves the string is PRESENT, never that the flag
  // actually gates behavior at runtime (a handler could parse the flag and
  // then ignore it, or the check could sit in dead code, and the grep
  // would still pass). This rewrite INVOKES the extracted pure wrappers
  // (handleSendDirectedMessageTool / handlePollDirectedMessagesTool /
  // handleAckDirectedMessageTool, imported from '../agent-messages' —
  // NEVER '../server') directly, with a real TaskDB, and asserts both the
  // returned shape AND zero database mutation.

  let dbPath: string
  let taskDb: TaskDB
  let db: Database

  beforeEach(() => {
    dbPath = tempDbPath('agentmsg-atm029')
    taskDb = new TaskDB(dbPath)
    db = taskDb.getHandle()
  })

  afterEach(() => {
    cleanupDbFile(dbPath)
  })

  function agentMessagesCount(): number {
    return (db.prepare('SELECT COUNT(*) as c FROM agent_messages').get() as { c: number }).c
  }

  test('directedMessagingDisabledError() returns the exact structured disabled-error shape', () => {
    expect(directedMessagingDisabledError()).toEqual({
      content: [{ type: 'text', text: 'directed messaging is disabled', isError: true }],
    })
  })

  test('flag OFF (default): handleSendDirectedMessageTool returns the structured disabled-error and inserts zero rows', () => {
    // directed_messaging_enabled is never set on this fresh TaskDB, so
    // isFeatureEnabled() returns false (db.ts default-OFF semantics).
    const before = agentMessagesCount()

    const result = handleSendDirectedMessageTool(taskDb, 'boss', {
      recipient: 'steve',
      msg_type: 'status_update',
      payload: { ok: true },
    })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].isError).toBe(true)
    expect(result.content[0].text.toLowerCase()).toContain('disabled')
    expect(agentMessagesCount()).toBe(before)
  })

  test('flag OFF (default): handlePollDirectedMessagesTool returns the structured disabled-error and mutates zero rows', () => {
    // Seed one pending row directly (bypassing the flag) so a real mutation
    // would be observable if the gate failed to hold.
    db.prepare(`
      INSERT INTO agent_messages (sender, recipient, msg_type, payload, seq)
      VALUES ('sadie', 'boss', 'status_update', '{}', 1)
    `).run()
    const before = db.prepare("SELECT status FROM agent_messages").all() as Array<{ status: string }>

    const result = handlePollDirectedMessagesTool(taskDb, 'boss', {})

    expect(result.content).toHaveLength(1)
    expect(result.content[0].isError).toBe(true)
    expect(result.content[0].text.toLowerCase()).toContain('disabled')

    const after = db.prepare("SELECT status FROM agent_messages").all() as Array<{ status: string }>
    expect(after).toEqual(before)
    expect(after.every((r) => r.status === 'pending')).toBe(true)
  })

  test('flag OFF (default): handleAckDirectedMessageTool returns the structured disabled-error and mutates zero rows', () => {
    const seeded = db.prepare(`
      INSERT INTO agent_messages (sender, recipient, msg_type, payload, seq, status)
      VALUES ('sadie', 'boss', 'status_update', '{}', 1, 'delivered')
      RETURNING *
    `).get() as AgentMessageRow

    const result = handleAckDirectedMessageTool(taskDb, 'boss', { message_id: seeded.id })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].isError).toBe(true)
    expect(result.content[0].text.toLowerCase()).toContain('disabled')

    const row = db.prepare('SELECT status, acked_at FROM agent_messages WHERE id = ?').get(seeded.id) as {
      status: string
      acked_at: string | null
    }
    expect(row.status).toBe('delivered')
    expect(row.acked_at).toBeNull()
  })

  test('flag ON: handleSendDirectedMessageTool returns a success content block (smoke)', () => {
    taskDb.setFeatureFlag('directed_messaging_enabled', true)

    const result = handleSendDirectedMessageTool(taskDb, 'boss', {
      recipient: 'steve',
      msg_type: 'status_update',
      payload: { ok: true },
    })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].isError).toBeUndefined()
    expect(result.content[0].text).toContain('sent to steve')
    expect(agentMessagesCount()).toBe(1)
  })

  test('flag ON: handlePollDirectedMessagesTool and handleAckDirectedMessageTool return success content blocks (smoke)', () => {
    taskDb.setFeatureFlag('directed_messaging_enabled', true)

    const sent = handleSendDirectedMessageTool(taskDb, 'boss', {
      recipient: 'steve',
      msg_type: 'status_update',
      payload: {},
    })
    expect(sent.content[0].isError).toBeUndefined()

    const polled = handlePollDirectedMessagesTool(taskDb, 'steve', {})
    expect(polled.content).toHaveLength(1)
    expect(polled.content[0].isError).toBeUndefined()
    const rows = JSON.parse(polled.content[0].text) as AgentMessageRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('delivered')

    const acked = handleAckDirectedMessageTool(taskDb, 'steve', { message_id: rows[0].id })
    expect(acked.content).toHaveLength(1)
    expect(acked.content[0].isError).toBeUndefined()
    expect(acked.content[0].text).toContain('acked')
  })
})

describe('ATM-032 — poll_directed_messages tool description documents at-least-once delivery + id-based dedup/idempotency', () => {
  test('the registered description contains both "at-least-once" and idempotency/dedup language referencing message id', () => {
    const serverSrc = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf-8')

    const toolIdx = serverSrc.indexOf("name: 'poll_directed_messages'")
    expect(toolIdx).toBeGreaterThan(-1)

    const descMatch = serverSrc.slice(toolIdx, toolIdx + 1000).match(/description:\s*'([^']*)'/)
    expect(descMatch).not.toBeNull()

    const description = descMatch![1]
    expect(description.toLowerCase()).toContain('at-least-once')
    expect(description.toLowerCase()).toContain('idempotent')
    expect(description).toMatch(/\bid\b/)
  })
})
