// memory-ordering.ts — P5 EPIC-01/EPIC-05 core serialization primitive.
//
// withMemoryWriteTxn() is THE single write-transaction wrapper every P5
// production call site (REQ-002/004/006/010/015) is required to use via
// taskDb.getHandle() directly — never nested inside TaskDB.run()'s
// reconnect-on-"disk I/O error" wrapper (REQ-026). It provides:
//   - real BEGIN IMMEDIATE / COMMIT / ROLLBACK serialization around a
//     synchronous callback,
//   - typed, instanceof-checkable errors for the two failure modes a
//     multi-process SQLite writer can hit (nested txn on the same handle,
//     and lock-acquisition timeout under contention),
//   - a monotonic, cross-process-unique sequence primitive (nextWriteSeq)
//     backed by an append-only `write_sequence` table (REQ-009).
//
// Concurrency-model note: `db.ts`'s openDb() sets `PRAGMA busy_timeout=5000`
// on every TaskDB handle. Left alone, that SQLite-internal busy-handler would
// swallow BEGIN IMMEDIATE contention for up to 5s *before* SQLITE_BUSY is
// ever surfaced to JS — silently defeating the explicit 50/150/450ms
// JS-managed backoff this module is specified to implement (REQ-001/ATM-030).
// We therefore pin busy_timeout=0 on the handle for the duration of the
// acquisition loop only (restored to its prior value immediately after,
// success or failure) so OUR retry schedule — not SQLite's internal wait —
// governs how long a caller blocks under contention.

import type { Database } from 'bun:sqlite'

export class NestedWriteTxnError extends Error {
  constructor(message = 'withMemoryWriteTxn: a write transaction is already active on this Database handle') {
    super(message)
    this.name = 'NestedWriteTxnError'
  }
}

export class WriteLockTimeoutError extends Error {
  constructor(message = 'withMemoryWriteTxn: exhausted retry budget acquiring BEGIN IMMEDIATE (lock held by another writer)') {
    super(message)
    this.name = 'WriteLockTimeoutError'
  }
}

/** Per-handle "a write txn opened by withMemoryWriteTxn is in flight" marker. */
const activeWriteTxns = new WeakSet<Database>()

/** Backoff schedule (ms) for the 3 additional BEGIN IMMEDIATE acquisition retries. */
const BUSY_RETRY_DELAYS_MS = [50, 150, 450] as const

function errorMessage(err: unknown): string {
  return (err as { message?: string } | null)?.message ?? ''
}

function isNestedTxnError(err: unknown): boolean {
  return /cannot start a transaction within a transaction/i.test(errorMessage(err))
}

function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return true
  return /SQLITE_BUSY|database is locked/i.test(errorMessage(err))
}

/** Test-only observation hook (REQ-001d). */
export function isWriteTxnActive(db: Database): boolean {
  return activeWriteTxns.has(db)
}

/**
 * Acquire BEGIN IMMEDIATE with a bounded, JS-managed retry/backoff. Bypasses
 * the handle's own PRAGMA busy_timeout for the duration of the attempt loop
 * only (see module-level note above) so the 50/150/450ms schedule — not
 * SQLite's internal busy-handler — governs the wait, then restores whatever
 * busy_timeout was configured before we touched it.
 */
function acquireWriteLock(db: Database): void {
  let priorTimeout = 0
  try {
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number } | null
    priorTimeout = row?.timeout ?? 0
  } catch {
    // Non-fatal — fall back to restoring 0 if we can't read the prior value.
  }
  try {
    db.prepare('PRAGMA busy_timeout=0').run()
  } catch {
    // Non-fatal; proceed with whatever timeout is already configured.
  }

  try {
    let attempt = 0
    for (;;) {
      try {
        db.prepare('BEGIN IMMEDIATE').run()
        return
      } catch (err) {
        if (isNestedTxnError(err)) {
          throw new NestedWriteTxnError()
        }
        if (isBusyError(err) && attempt < BUSY_RETRY_DELAYS_MS.length) {
          Bun.sleepSync(BUSY_RETRY_DELAYS_MS[attempt])
          attempt++
          continue
        }
        if (isBusyError(err)) {
          throw new WriteLockTimeoutError()
        }
        throw err
      }
    }
  } finally {
    try {
      db.prepare(`PRAGMA busy_timeout=${priorTimeout}`).run()
    } catch {
      // Non-fatal.
    }
  }
}

/**
 * Wrap a synchronous callback in a real BEGIN IMMEDIATE / COMMIT / ROLLBACK
 * transaction on `db`. Never retries `fn` itself — only the lock acquisition.
 * Rethrows the caller's original error unmodified on failure (REQ-026b): no
 * reconnect, no replay.
 */
export function withMemoryWriteTxn<T>(db: Database, fn: (db: Database) => T): T {
  if (activeWriteTxns.has(db)) {
    throw new NestedWriteTxnError()
  }

  acquireWriteLock(db)
  activeWriteTxns.add(db)

  try {
    const result = fn(db)
    db.prepare('COMMIT').run()
    activeWriteTxns.delete(db)
    return result
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    } catch {
      // Swallow — surface the ORIGINAL error, not a rollback failure.
    }
    activeWriteTxns.delete(db)
    throw err
  }
}

/**
 * Monotonic, cross-process-unique sequence primitive backed by an
 * append-only table (REQ-009). Valid as a standalone call outside any
 * transaction; participates in (and rolls back with) an enclosing
 * withMemoryWriteTxn() transaction when called from inside one.
 */
export function nextWriteSeq(db: Database): number {
  return (db.prepare('INSERT INTO write_sequence DEFAULT VALUES RETURNING id').get() as { id: number }).id
}
