// THROWAWAY hard-negative mining (#10060821 GAP-4 precision stratum).
// For each candidate adversarial query: embed, score cosine over the production
// scope (agent==recall_agent OR shared, non-superseded), print dense top-15.
// Purpose: confirm gold is dense-near AND that candidate distractors appear among
// the near neighbors (objective "semantically near" criterion) before labeling.
// Read-only on the pristine COPY. No fusion, no recall side-effects.
import { TaskDB } from '/Users/coachstokes/.claude/mcp-servers/task-board/db.ts'
import { embedOne, getVectors, cosineNormalized } from '/Users/coachstokes/.claude/mcp-servers/task-board/dense.ts'

const COPY = process.argv[2]
const db = new TaskDB(COPY)

const QUERIES: { label: string; agent: string; q: string; gold: number[]; cand_distractors: number[] }[] = [
  { label: 'ADV-domains', agent: 'boss', gold: [284], cand_distractors: [14, 1295, 1058],
    q: 'which of our web addresses is the real storefront we push search rankings for, versus the one that only exists to send mail?' },
  { label: 'ADV-smartlead-cred', agent: 'shared', gold: [2528], cand_distractors: [2499, 2171, 2536],
    q: 'where is the API credential stored for our cold-outreach email sending platform, and does the lapsed subscription stop the API from working?' },
  { label: 'ADV-campaign-off', agent: 'shared', gold: [1382], cand_distractors: [1327, 2477, 1346],
    q: 'which ad campaign is permanently switched off for good and must never be suggested to turn back on?' },
  { label: 'ADV-gh-path', agent: 'kiera', gold: [730], cand_distractors: [2565, 1295],
    q: 'the genuine GitHub command-line tool keeps erroring with a type error — could a second conflicting install be shadowing it on the PATH?' },
  { label: 'ADV-launchd-locale', agent: 'shared', gold: [2211], cand_distractors: [2198, 290],
    q: 'my scheduled background job garbles text with odd spacing even though the exact same script parses fine when I run it by hand?' },
  { label: 'ADV-team-email', agent: 'shared', gold: [2171], cand_distractors: [2499, 2528, 18],
    q: 'what is the shared email inbox address the agent team sends and receives mail from?' },
  { label: 'ADV-no-llm-key', agent: 'shared', gold: [2536], cand_distractors: [14, 1295, 2528],
    q: 'can the booking website call an LLM model server-side to generate briefs, or is there simply no model API key available to it?' },
  { label: 'ADV-kairos-daemon', agent: 'shared', gold: [66], cand_distractors: [111, 290, 373],
    q: 'where does the always-running background monitor that watches my screen activity and productivity actually live on disk?' },
]

const metaStmt = db.run((d: any) => d.prepare('SELECT id, agent, category, substr(replace(content,char(10),\' \'),1,90) AS head FROM memories WHERE id=?'))
const meta = (id: number) => db.run((d: any) => d.prepare('SELECT id, agent, category, substr(replace(content,char(10),\' \'),1,90) AS head FROM memories WHERE id=?').get(id)) as any

for (const item of QUERIES) {
  const candIds: number[] = db.run((d: any) =>
    (d.prepare("SELECT id FROM memories WHERE (agent=? OR agent='shared') AND state!='superseded'").all(item.agent) as any[]).map(r => r.id))
  const vmap = db.run((d: any) => getVectors(d, candIds))
  const qvec = await embedOne(item.q)
  const scored = candIds.filter(id => vmap.has(id)).map(id => ({ id, score: cosineNormalized(vmap.get(id)!, qvec) }))
  scored.sort((a, b) => b.score - a.score || a.id - b.id)
  const goldRank = item.gold.map(g => { const i = scored.findIndex(s => s.id === g); return `#${g}@${i < 0 ? 'NA' : i + 1}` }).join(',')
  const distRanks = item.cand_distractors.map(dd => { const i = scored.findIndex(s => s.id === dd); return `#${dd}@${i < 0 ? 'NA' : i + 1}` }).join(',')
  console.log(`\n===== ${item.label} (scope ${item.agent}, n=${scored.length}) =====`)
  console.log(`Q: ${item.q}`)
  console.log(`gold dense-rank: ${goldRank}   cand-distractor dense-rank: ${distRanks}`)
  console.log('dense top-15:')
  for (let i = 0; i < Math.min(15, scored.length); i++) {
    const m = meta(scored[i].id)
    const tag = item.gold.includes(scored[i].id) ? ' <<<GOLD' : (item.cand_distractors.includes(scored[i].id) ? ' <<<cand-distractor' : '')
    console.log(`  ${String(i + 1).padStart(2)}. #${scored[i].id} (${m?.agent}/${m?.category}) s=${scored[i].score.toFixed(4)} ${m?.head}${tag}`)
  }
}
process.exit(0)
