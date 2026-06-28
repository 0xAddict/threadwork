/**
 * GAP-4 recall+PRECISION sweep harness (#10060821). DETERMINISTIC.
 *
 * Reuses the REAL recall path (MemoryDB.recallAugmented — the recall_memories
 * entrypoint), NOT a reimplementation. Arms selected purely via env knobs read by
 * dense.ts (isDenseEnabled/denseMode/denseRrfK), exactly as production resolves them.
 *
 * Determinism: each (config,query) runs against its OWN fresh COW clone of the
 * pristine VACUUM snapshot — so recall()'s touchRecalled side-effect (importance+1,
 * a BM25 ranking input) can NEVER contaminate another query/config. ONNX int8
 * embedding is deterministic; all recall sorts use (-score,id) tiebreaks.
 *
 * Arms (8 configs):
 *   LIKE        : real recall() LIKE fallback — FTS index DROPPED on the clone AFTER
 *                 construction (migrate() recreates it IF NOT EXISTS, so the drop must
 *                 come after). dense OFF. This is the shipped pre-FTS degrade path.
 *   BM25        : dense OFF, FTS present -> recall()=recallBm25 (shipped default base).
 *   dense-only  : dense ON, mode=dense -> pure dense ranking.
 *   rrf@{5,10,20,30,60} : dense ON, mode=rrf, TASKBOARD_DENSE_RRF_K swept.
 *
 * Per run we LOG denseRrfK()/denseMode()/isDenseEnabled()/ftsPresent to PROVE the
 * config under test. Usage: bun run sweep_gap4.ts <pristine> <evalset.json> <out.json> <cloneDir>
 */
import { TaskDB } from '/Users/coachstokes/.claude/mcp-servers/task-board/db.ts'
import { MemoryDB } from '/Users/coachstokes/.claude/mcp-servers/task-board/memory.ts'
import { isDenseEnabled, denseMode, denseRrfK, denseBm25K, denseDenseK, vectorTableExists } from '/Users/coachstokes/.claude/mcp-servers/task-board/dense.ts'
import { readFileSync, writeFileSync, rmSync } from 'fs'
import { execSync } from 'child_process'

const PRISTINE = process.argv[2]
const EVALSET = process.argv[3]
const OUT = process.argv[4]
const CLONEDIR = process.argv[5]

type Cfg = { name: string; dense: 'on' | 'off'; mode: 'rrf' | 'dense' | null; k: number | null; dropFts: boolean }
const CONFIGS: Cfg[] = [
  { name: 'LIKE', dense: 'off', mode: null, k: null, dropFts: true },
  { name: 'BM25', dense: 'off', mode: null, k: null, dropFts: false },
  { name: 'dense-only', dense: 'on', mode: 'dense', k: null, dropFts: false },
  { name: 'rrf@5', dense: 'on', mode: 'rrf', k: 5, dropFts: false },
  { name: 'rrf@10', dense: 'on', mode: 'rrf', k: 10, dropFts: false },
  { name: 'rrf@20', dense: 'on', mode: 'rrf', k: 20, dropFts: false },
  { name: 'rrf@30', dense: 'on', mode: 'rrf', k: 30, dropFts: false },
  { name: 'rrf@60', dense: 'on', mode: 'rrf', k: 60, dropFts: false },
]

function setEnv(cfg: Cfg) {
  process.env.TASKBOARD_DENSE_RECALL = cfg.dense === 'on' ? 'on' : 'off'
  if (cfg.mode) process.env.TASKBOARD_DENSE_MODE = cfg.mode
  else delete process.env.TASKBOARD_DENSE_MODE
  if (cfg.k != null) process.env.TASKBOARD_DENSE_RRF_K = String(cfg.k)
  else delete process.env.TASKBOARD_DENSE_RRF_K
  delete process.env.TASKBOARD_DENSE_BM25_K // default 50
  delete process.env.TASKBOARD_DENSE_DENSE_K // default 50
}

const evalset: any[] = JSON.parse(readFileSync(EVALSET, 'utf-8'))
const clone = `${CLONEDIR}/run.db`
function rmClone() { for (const s of ['', '-shm', '-wal']) rmSync(clone + s, { force: true }) }

const results: any[] = []
const proofs: any[] = []

for (const cfg of CONFIGS) {
  setEnv(cfg)
  const proof = {
    config: cfg.name, isDenseEnabled: isDenseEnabled(), denseMode: denseMode(),
    denseRrfK: denseRrfK(), denseBm25K: denseBm25K(), denseDenseK: denseDenseK(),
  }
  proofs.push(proof)
  console.error('CONFIG-PROOF ' + JSON.stringify(proof))

  for (const q of evalset) {
    rmClone()
    execSync(`cp -c "${PRISTINE}" "${clone}"`)
    const taskDb = new TaskDB(clone)
    let ftsPresent = true
    if (cfg.dropFts) {
      // migrate() (constructor) recreated FTS IF NOT EXISTS -> drop AFTER construction to
      // exercise the genuine recallLike fallback; drop triggers too so touchRecalled's
      // UPDATE on memories does not fire FTS-sync triggers into a missing table.
      const h = taskDb.getHandle()
      h.exec(`DROP TRIGGER IF EXISTS trg_memories_fts_ai;
              DROP TRIGGER IF EXISTS trg_memories_fts_ad;
              DROP TRIGGER IF EXISTS trg_memories_fts_au;
              DROP TABLE IF EXISTS memories_fts;`)
      ftsPresent = false
    }
    const mem = new MemoryDB(taskDb)
    let top10: number[] = []
    let err: string | null = null
    try {
      const res = await mem.recallAugmented(q.recall_agent, { query: q.query, limit: 10 })
      top10 = res.map((m: any) => m.id)
    } catch (e) {
      err = (e as Error)?.message ?? String(e)
    }
    results.push({
      qid: q.qid, stratum: q.stratum, config: cfg.name, recall_agent: q.recall_agent,
      gold_ids: q.gold_ids, distractor_ids: q.distractor_ids, weight: q.weight,
      top10,
      // PER-RUN config proof (proves the k actually in force for THIS run)
      denseRrfK: denseRrfK(), denseMode: denseMode(), isDenseEnabled: isDenseEnabled(),
      ftsPresent, vectorsPresent: vectorTableExists(taskDb.getHandle()), err,
    })
    taskDb.close()
    rmClone()
  }
}

writeFileSync(OUT, JSON.stringify({ proofs, results }, null, 2))
console.error(`\nWROTE ${OUT} — ${results.length} runs (${CONFIGS.length} configs x ${evalset.length} queries)`)
process.exit(0)
