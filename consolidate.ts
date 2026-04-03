#!/usr/bin/env bun
// consolidate.ts — Nightly memory consolidation script
import { TaskDB } from './db'
import { MemoryDB } from './memory'
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

export function runDecay(mem: MemoryDB): number {
  const candidates = mem.getDecayCandidate()
  let count = 0

  for (const m of candidates) {
    const lastAccessed = new Date(m.last_accessed + 'Z')
    const now = new Date()
    const daysSinceAccess = Math.floor((now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24))
    const decayPeriods = Math.floor(daysSinceAccess / 7)
    const newImportance = Math.max(m.importance - decayPeriods, 0)

    if (newImportance !== m.importance) {
      mem.decayMemory(m.id, newImportance)
      count++
    }
  }

  return count
}

export function runArchive(mem: MemoryDB): number {
  const candidates = mem.getZeroImportanceIds()

  for (const id of candidates) {
    mem.archiveMemory(id)
  }

  return candidates.length
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

// Run as standalone script when executed directly
const isMainScript = process.argv[1]?.endsWith('consolidate.ts')
if (isMainScript) {
  console.log('Starting nightly consolidation...')

  const taskDb = new TaskDB(DB_PATH)
  const mem = new MemoryDB(taskDb)

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
