#!/usr/bin/env bun
// CLI tool: bun scripts/run-migration.ts <migration-number> [--db <path>] [--down]
//
// Applies a numbered migration SQL file against the target database.
// Defaults to tasks.db in the same directory as this script.
// Pass --down to apply the .down.sql instead of the up migration.
//
// Example:
//   bun scripts/run-migration.ts 0009
//   bun scripts/run-migration.ts 0009 --db /tmp/tasks-test.db
//   bun scripts/run-migration.ts 0009 --down --db /tmp/tasks-test.db

import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'

const ROOT = join(dirname(import.meta.path), '..')
const MIGRATIONS_DIR = join(ROOT, 'migrations')
const DEFAULT_DB = join(ROOT, 'tasks.db')

function usage() {
  console.error('Usage: bun scripts/run-migration.ts <NNNN> [--db <path>] [--down]')
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.length === 0) usage()

const migrationNum = args[0]
const isDown = args.includes('--down')
const dbIdx = args.indexOf('--db')
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : DEFAULT_DB

if (!migrationNum.match(/^\d{4}$/)) usage()
if (dbIdx !== -1 && !args[dbIdx + 1]) usage()

const suffix = isDown ? '.down.sql' : '.sql'
const candidates = [`${migrationNum}_state_contracts${suffix}`]

// Find the matching file by prefix
import { readdirSync } from 'fs'
const files = readdirSync(MIGRATIONS_DIR)
const match = files.find(f => f.startsWith(migrationNum) && f.endsWith(suffix))

if (!match) {
  console.error(`No migration file found for ${migrationNum}${suffix} in ${MIGRATIONS_DIR}`)
  process.exit(1)
}

const sqlPath = join(MIGRATIONS_DIR, match)
const sql = readFileSync(sqlPath, 'utf-8')

const statements = sql
  .split(';')
  .map(s => s.replace(/--[^\n]*/g, '').trim())
  .filter(s => s.length > 0)

console.log(`Applying ${isDown ? 'DOWN' : 'UP'} migration: ${match}`)
console.log(`Database: ${dbPath}`)

const db = new Database(dbPath)
for (const stmt of statements) {
  console.log(`  > ${stmt.substring(0, 80).replace(/\s+/g, ' ')}${stmt.length > 80 ? '...' : ''}`)
  db.exec(stmt)
}
db.close()

console.log('Done.')
