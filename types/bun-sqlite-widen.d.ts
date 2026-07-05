/**
 * P4 typecheck wiring (#10376048) — tsconfig-only widening, NOT a consumer-file edit.
 *
 * bun-types' `Database.prepare<ReturnType, ParamsType extends SQLQueryBindings |
 * SQLQueryBindings[]>(sql, params?)` has no default for `ParamsType`. When callers
 * (pre-existing code in db.ts/audit.ts/decision.ts/memory.ts) call `db.prepare(sql)`
 * with only the SQL string — no params, no explicit type args — TypeScript can't
 * infer ParamsType from any argument, so it falls back to the full constraint
 * (`SQLQueryBindings | SQLQueryBindings[]`) rather than `any[]`. That constraint is
 * then too narrow for the dynamically-built `unknown[]` param arrays those call
 * sites spread into `.all(...params)`, producing a pre-existing (unrelated to this
 * feature) TS2345 in 4 files.
 *
 * This module augmentation adds an earlier-resolved single-argument overload for
 * `prepare`/`query` that defaults ParamsType to `any[]` (matching `Statement`'s own
 * class default), so `db.prepare(sql)` — called with exactly one argument, as every
 * offending call site does — resolves through this overload instead. It does NOT
 * touch db.ts/audit.ts/decision.ts/memory.ts; it only widens the ambient bun:sqlite
 * type declarations already merged in via bun-types.
 */
import type { Statement } from 'bun:sqlite'

declare module 'bun:sqlite' {
  interface Database {
    prepare<ReturnType = unknown>(sql: string): Statement<ReturnType, any[]>
    query<ReturnType = unknown>(sql: string): Statement<ReturnType, any[]>
  }
}
