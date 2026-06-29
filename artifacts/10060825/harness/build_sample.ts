/**
 * P3 measure-first STAGE-2a — sample builder (#10060825).
 *
 * Builds the real threadwork delegation sample + the 3-condition raw material,
 * using the SHIPPED recall() path AS-IS (dense+rrf, k from env — production = 5)
 * as the relevance primitive for the CURATED condition. No source/retrieval edits.
 *
 * Determinism / read-only discipline (mirrors GAP-4 #10060821):
 *  - Operates ONLY on a fresh APFS copy-on-write clone of the pristine VACUUM
 *    snapshot. The live tasks.db is NEVER opened here.
 *  - POINT-IN-TIME per instance: on each instance's own clone we DELETE memories
 *    created AFTER the delegation timestamp (the delete triggers keep memories_fts
 *    and memory_vectors consistent), so recall() sees only the delegator's context
 *    that existed AT DELEGATION TIME — and the task's own post-completion debrief
 *    memory (created at completion) can never leak into its brief.
 *  - One clone per instance; recall()'s touchRecalled mutation cannot contaminate
 *    another instance.
 *
 * Output (consumed by score_p3.py, which does ALL metric computation):
 *  - sample.json  : per-instance {task_id,to_agent,created_at,description,result,
 *                   pit_pool_ids (point-in-time delegator pool), recall_order (top-N ids)}
 *  - memdump.json : {id -> {agent,category,len,created_at,source_task_id,content}}
 *                   for every memory id referenced (delegator pool union). Scorer
 *                   reads content by id; this file is the ONLY place content lives.
 *  - config_proof.json : the resolved recall config actually in force.
 *
 * Usage: bun run build_sample.ts <pristine.db> <cloneDir> <outDir>
 */
import { TaskDB } from '/Users/coachstokes/.claude/mcp-servers/task-board/db.ts'
import { MemoryDB } from '/Users/coachstokes/.claude/mcp-servers/task-board/memory.ts'
import { isDenseEnabled, denseMode, denseRrfK, denseBm25K, denseDenseK, vectorTableExists } from '/Users/coachstokes/.claude/mcp-servers/task-board/dense.ts'
import { writeFileSync, rmSync } from 'fs'
import { execSync } from 'child_process'

const PRISTINE = process.argv[2]
const CLONEDIR = process.argv[3]
const OUTDIR = process.argv[4]
const RECALL_LIMIT = 12 // request the max curated-N; arms {3,5,8,12} derived by slicing in the scorer

// Shipped production recall config (mcp.json server env). Set explicitly so the
// run is deterministic + the proof is unambiguous, regardless of ambient env.
process.env.TASKBOARD_DENSE_RECALL = 'on'
process.env.TASKBOARD_DENSE_MODE = 'rrf'
process.env.TASKBOARD_DENSE_RRF_K = '5'
delete process.env.TASKBOARD_DENSE_BM25_K
delete process.env.TASKBOARD_DENSE_DENSE_K

const clone = `${CLONEDIR}/run.db`
function rmClone() { for (const s of ['', '-shm', '-wal']) rmSync(clone + s, { force: true }) }

// ---- 1. select the delegation instances (boss = canonical orchestrator-delegator) ----
// Read the instance list from a read-only clone (no mutation of pristine).
rmClone(); execSync(`cp -c "${PRISTINE}" "${clone}"`)
const sel = new TaskDB(clone)
const instances = sel.run(db => db.prepare(`
  SELECT id, to_agent, created_at, description, result
  FROM tasks
  WHERE from_agent='boss' AND to_agent IN ('sadie','kiera','steve')
    AND from_agent != to_agent AND supervisor_agent IS NOT NULL
    AND status='completed' AND result IS NOT NULL AND length(result) > 150
  ORDER BY id ASC
`).all() as Array<{ id: number; to_agent: string; created_at: string; description: string; result: string }>)
sel.close(); rmClone()
console.error(`Selected ${instances.length} boss->worker completed delegations`)

const memNeeded = new Map<number, any>() // id -> dump row
const sample: any[] = []

// ---- 2. per instance: point-in-time clone, run shipped recall, record ids ----
let proof: any = null
for (const inst of instances) {
  rmClone(); execSync(`cp -c "${PRISTINE}" "${clone}"`)
  const taskDb = new TaskDB(clone)
  // POINT-IN-TIME: drop every memory created after this delegation. datetime()
  // normalizes both default 'YYYY-MM-DD HH:MM:SS' and ISO 'T..Z' forms. Triggers
  // (trg_memories_fts_ad / trg_memory_vectors_ad) keep fts + vectors consistent.
  taskDb.run(db => {
    db.prepare(`DELETE FROM memories WHERE datetime(created_at) > datetime(?)`).run(inst.created_at)
  })
  // point-in-time delegator pool (exactly recall()'s candidate scope for agent=boss)
  const pitPool = taskDb.run(db => db.prepare(`
    SELECT id, agent, category, content, created_at, source_task_id, length(content) AS len
    FROM memories WHERE (agent='boss' OR agent='shared') AND state!='superseded'
  `).all() as Array<any>)
  for (const m of pitPool) {
    if (!memNeeded.has(m.id)) memNeeded.set(m.id, {
      agent: m.agent, category: m.category, len: m.len,
      created_at: m.created_at, source_task_id: m.source_task_id, content: m.content,
    })
  }
  // SHIPPED recall path AS-IS — the relevance primitive for CURATED
  const mem = new MemoryDB(taskDb)
  const recalled = await mem.recallAugmented('boss', { query: inst.description, limit: RECALL_LIMIT })
  const recallOrder = recalled.map((r: any) => r.id)
  if (!proof) proof = {
    isDenseEnabled: isDenseEnabled(), denseMode: denseMode(), denseRrfK: denseRrfK(),
    denseBm25K: denseBm25K(), denseDenseK: denseDenseK(),
    vectorsPresent: vectorTableExists(taskDb.getHandle()), recall_limit: RECALL_LIMIT,
  }
  sample.push({
    task_id: inst.id, to_agent: inst.to_agent, created_at: inst.created_at,
    description: inst.description, result: inst.result,
    pit_pool_ids: pitPool.map(m => m.id), recall_order: recallOrder,
  })
  taskDb.close(); rmClone()
  console.error(`  task ${inst.id} -> ${inst.to_agent}: pit_pool=${pitPool.length} recall=${recallOrder.length}`)
}

const memdump: Record<number, any> = {}
for (const [id, row] of memNeeded) memdump[id] = row

writeFileSync(`${OUTDIR}/sample.json`, JSON.stringify(sample, null, 2))
writeFileSync(`${OUTDIR}/memdump.json`, JSON.stringify(memdump))
writeFileSync(`${OUTDIR}/config_proof.json`, JSON.stringify(proof, null, 2))
console.error(`\nWROTE sample.json (${sample.length} instances), memdump.json (${Object.keys(memdump).length} memories)`)
console.error('CONFIG-PROOF ' + JSON.stringify(proof))
process.exit(0)
