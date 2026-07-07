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
// Concurrency-model note (REQ-001b/c): `db.ts`'s openDb() sets
// `PRAGMA busy_timeout=5000` on every TaskDB handle, and this module SHALL
// rely on that EXISTING busy_timeout as the FIRST layer of cross-process
// lock-wait behavior — it never reads, lowers, or restores busy_timeout
// itself. A single `BEGIN IMMEDIATE` attempt therefore already absorbs up to
// ~5s of contention via SQLite's own internal busy-handler before ever
// surfacing SQLITE_BUSY to JS. The ONLY additional retry this module adds is
// a bounded, JS-managed 50/150/450ms backoff around the lock-ACQUISITION
// step itself (REQ-001c) — for the rare case where BEGIN IMMEDIATE still
// throws SQLITE_BUSY/SQLITE_BUSY_SNAPSHOT after that budget expires under
// SUSTAINED contention. That ladder governs additional acquisition retries
// only; it is layered on top of — never a substitute for — the handle's own
// busy_timeout, which applies fresh on every one of those retry attempts too.

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
 * Acquire BEGIN IMMEDIATE with a bounded, JS-managed acquisition retry/backoff
 * (REQ-001c) layered ON TOP OF the handle's own existing busy_timeout
 * (REQ-001b) — this function never reads, lowers, or restores busy_timeout;
 * each BEGIN IMMEDIATE attempt below (including retries) is subject to
 * whatever busy_timeout is already configured on `db`.
 */
function acquireWriteLock(db: Database): void {
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
