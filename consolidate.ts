#!/usr/bin/env bun
// consolidate.ts — Nightly memory consolidation script
import { TaskDB } from './db'
import { MemoryDB } from './memory'
import type { Memory } from './memory'
import { DB_PATH } from './config'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const BRIEFING_DIR = join(
  process.env.HOME ?? '/tmp',
  '.claude',
  'mcp-servers',
  'task-board',
  'briefings',
)

export function getDecayWindowDays(memory: Pick<Memory, 'classification' | 'state' | 'quality' | 'challenge_count' | 'support_count'>): number {
  const BASE_WINDOWS: Record<string, number> = {
    foundational: Infinity,
    strategic: 14,
    operational: 7,
    observational: 3,
    ephemeral: 1,
  }
  let window = BASE_WINDOWS[memory.classification] ?? 7
  if (window === Infinity) return Infinity
  if (memory.state === 'disputed') window = Math.ceil(window / 2)
  if (memory.quality < 0.3) window = Math.ceil(window / 2)
  if (memory.challenge_count > memory.support_count) window = Math.ceil(window / 2)
  return Math.max(window, 1)
}

export function runDecay(mem: MemoryDB): number {
  const candidates = mem.getDecayCandidate()
  let count = 0

  for (const m of candidates) {
    const decayWindow = getDecayWindowDays(m)
    if (decayWindow === Infinity) continue

    const lastAccessed = new Date(m.last_accessed + 'Z')
    const now = new Date()
    const daysSinceAccess = Math.floor((now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24))

    if (daysSinceAccess <= decayWindow) continue

    const decayPeriods = Math.floor(daysSinceAccess / decayWindow)
    const newImportance = Math.max(m.importance - decayPeriods, 0)

    if (newImportance !== m.importance) {
      mem.decayMemory(m.id, newImportance)
      count++
    }
  }

  return count
}

export function runArchive(mem: MemoryDB): number {
  const zeroIds = mem.getZeroImportanceIds()
  for (const id of zeroIds) {
    mem.archiveMemory(id)
  }

  // Also sweep superseded memories older than 7 days
  const superseded = mem.getSupersededOlderThan(7)
  for (const id of superseded) {
    mem.archiveMemory(id)
  }

  return zeroIds.length + superseded.length
}

export function runPrune(mem: MemoryDB, daysOld: number = 90): number {
  return mem.pruneArchive(daysOld)
}

export function generateBriefing(
  agent: string,
  mem: MemoryDB,
  taskDb: TaskDB,
  briefingDir: string = BRIEFING_DIR,
): void {
  const briefing = mem.getBootBriefing(agent, taskDb)
  mkdirSync(briefingDir, { recursive: true })
  writeFileSync(join(briefingDir, `${agent}.json`), JSON.stringify(briefing, null, 2))
}

export function runStatusTtl(taskDb: TaskDB, maxAgeHours: number = 24): number {
  return taskDb.run(db => {
    const result = db.prepare(
      "DELETE FROM task_status_events WHERE created_at < datetime('now', '-' || ? || ' hours')"
    ).run(maxAgeHours)
    return result.changes
  })
}

// Run as standalone script when executed directly
const isMainScript = process.argv[1]?.endsWith('consolidate.ts')
if (isMainScript) {
  console.log('Starting nightly consolidation...')

  const taskDb = new TaskDB(DB_PATH)
  const mem = new MemoryDB(taskDb)

  const statusCleaned = runStatusTtl(taskDb)
  console.log(`Status TTL cleanup: ${statusCleaned} old entries removed`)

  const decayed = runDecay(mem)
  console.log(`Decayed: ${decayed} memories`)

  const archived = runArchive(mem)
  console.log(`Archived: ${archived} memories`)

  const pruned = runPrune(mem)
  console.log(`Pruned: ${pruned} archived memories`)

  const agents = mem.listAgents()
  for (const agent of agents) {
    generateBriefing(agent, mem, taskDb)
    console.log(`Generated briefing for ${agent}`)
  }

  taskDb.close()
  console.log('Consolidation complete.')
}
