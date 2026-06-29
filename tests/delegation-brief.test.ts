// P3 — Curated Delegation Briefs (#10060822). Spec: specs/P3-delegation-briefs-frontier-alignment.md (LOCKED @ c5d382f).
//
// Proves the §7 acceptance criteria that are checkable at the db/module layer:
//  - AC-2: assembleDelegationBrief() returns a FILTERED SUBSET (count + byte capped), never a full dump.
//  - AC-3: relevance selection routes through the shipped recall path (recallAugmented → recall); no new retrieval.
//  - AC-4: bookending — the most-critical fact appears at HEAD and TAIL.
//  - AC-5: backward-compat — delegateTask with no brief stores delegation_brief = NULL (additive nullable col, default-OFF flag).
//  - AC-6: delegatee surfacing query — getActiveDelegationBriefs() returns open delegated tasks' briefs.
//  - AC-7: persistence — a supplied brief is stored durably on the task row.
//  - AC-8: anti-dump guard — an oversized explicit brief (full-context dump) is rejected.
// plus the relevance-GATE (no brief for self-contained delegations) and the auto-path byte cap on huge memories.
//
// Dense recall is OFF in tests (no TASKBOARD_DENSE_RECALL env) ⇒ recallAugmented() returns the
// sync BM25/LIKE recall() base — still the shipped recall path (AC-3), with zero ML cost.

// Force dense recall OFF for this unit suite: an explicit process-env 'off' wins over
// mcp.json (see dense.ts resolveSetting). recallAugmented() then returns the sync BM25/LIKE
// recall() base — still the shipped recall path (AC-3 holds) — with no ONNX model load
// (the real model triggers a Bun native-teardown panic at process exit; dense's own
// production fidelity is proven separately in the Stage-2a study #10060825).
process.env.TASKBOARD_DENSE_RECALL = 'off'

import { test, expect, beforeEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'
import { MemoryDB } from '../memory'
import {
  assembleDelegationBrief,
  buildExplicitBrief,
  enforceAntiDumpBrief,
  DelegationBriefTooLargeError,
  DELEGATION_BRIEFS_FLAG,
  BRIEF_MAX_MEMORIES,
  BRIEF_MAX_BYTES,
  byteLen,
} from '../delegation-brief'

const TEST_DB = '/tmp/task-board-delegation-brief-test.db'
let db: TaskDB
let mem: MemoryDB

beforeEach(() => {
  for (const s of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + s) } catch {}
  }
  db = new TaskDB(TEST_DB)
  mem = new MemoryDB(db)
})

test('migration: tasks.delegation_brief column exists and the flag defaults OFF', () => {
  const cols = (db.getHandle().prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name)
  expect(cols).toContain('delegation_brief')
  expect(db.isFeatureEnabled(DELEGATION_BRIEFS_FLAG)).toBe(false)
})

test('AC-5: delegateTask with no brief stores delegation_brief = NULL (additive, backward-compatible row)', () => {
  const t = db.delegateTask({ from: 'boss', to: 'kiera', description: 'do x', priority: 'normal', supervisor_agent: 'boss' })
  expect(t.delegation_brief).toBeNull()
  const row = db.getTask(t.id)!
  expect(row.delegation_brief).toBeNull()
  // Pre-existing columns unchanged.
  expect(row.from_agent).toBe('boss')
  expect(row.to_agent).toBe('kiera')
  expect(row.description).toBe('do x')
  expect(row.status).toBe('pending')
  expect(row.supervisor_agent).toBe('boss')
})

test('AC-7: delegateTask persists a supplied brief durably on the task row', () => {
  const t = db.delegateTask({
    from: 'boss', to: 'kiera', description: 'do x', priority: 'normal',
    supervisor_agent: 'boss', delegation_brief: 'BRIEF-CONTENT-123',
  })
  expect(db.getTask(t.id)!.delegation_brief).toBe('BRIEF-CONTENT-123')
})

test('AC-6: getActiveDelegationBriefs surfaces briefs for the delegatee\'s open delegated tasks', () => {
  const withBrief = db.delegateTask({
    from: 'boss', to: 'kiera', description: 'task with brief', priority: 'normal',
    supervisor_agent: 'boss', delegation_brief: 'B-FOR-BOOT',
  })
  db.delegateTask({ from: 'boss', to: 'kiera', description: 'no brief', priority: 'normal', supervisor_agent: 'boss' })
  const briefs = db.getActiveDelegationBriefs('kiera')
  expect(briefs.length).toBe(1)
  expect(briefs[0].id).toBe(withBrief.id)
  expect(briefs[0].delegation_brief).toBe('B-FOR-BOOT')
  // A different agent sees none of kiera's briefs.
  expect(db.getActiveDelegationBriefs('steve').length).toBe(0)
})

test('AC-2/AC-3: brief is a recall-selected, count+byte-capped FILTERED SUBSET (not a full dump)', async () => {
  const relTok = 'orbitaltelemetry'
  for (let i = 0; i < 20; i++) {
    mem.saveMemory({ agent: 'boss', category: 'fact', content: `${relTok} pipeline note ${i} handles satellite ${relTok} batching` })
  }
  for (let i = 0; i < 20; i++) {
    mem.saveMemory({ agent: 'boss', category: 'fact', content: `unrelated kitchen recipe number ${i} about soup` })
  }
  const poolSize = 40

  const brief = await assembleDelegationBrief(mem, db, { from: 'boss', taskDescription: `fix the ${relTok} pipeline` })
  expect(brief).not.toBeNull()
  // Count cap (AC-2): at most N memories AND strictly fewer than the pool ⇒ a subset, never the full dump.
  expect(brief!.memoryIds.length).toBeLessThanOrEqual(BRIEF_MAX_MEMORIES)
  expect(brief!.memoryIds.length).toBeLessThan(poolSize)
  expect(brief!.memoryIds.length).toBeGreaterThan(0)
  // Byte cap (AC-2 anti-dump).
  expect(brief!.bytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
  // AC-3: routed through recall ⇒ selected the RELEVANT memories, not the irrelevant soup ones.
  expect(brief!.text).toContain(relTok)
  expect(brief!.text).not.toContain('soup')
})

test('AC-4: bookended — the most-critical memory appears at HEAD and TAIL of the rendered brief', async () => {
  const uniq = 'ZZTOPCRITICAL'
  // A clearly top-ranked memory (matches both query terms, term repeated) + weaker ones.
  mem.saveMemory({ agent: 'boss', category: 'fact', content: `${uniq} deploy deploy deploy primary runbook step` })
  for (let i = 0; i < 5; i++) mem.saveMemory({ agent: 'boss', category: 'fact', content: `deploy secondary detail ${i}` })

  const brief = await assembleDelegationBrief(mem, db, { from: 'boss', taskDescription: 'deploy runbook' })
  expect(brief).not.toBeNull()
  const text = brief!.text
  const mid = Math.floor(text.length / 2)
  expect(text.slice(0, mid)).toContain(uniq) // head
  expect(text.slice(mid)).toContain(uniq) // tail recap
})

test('AC-8: an oversized explicit brief (full-context dump) is rejected; a small one passes and is bookended', () => {
  const huge = 'x'.repeat(BRIEF_MAX_BYTES + 1000)
  expect(() => buildExplicitBrief(huge)).toThrow(DelegationBriefTooLargeError)
  expect(() => enforceAntiDumpBrief(huge)).toThrow(DelegationBriefTooLargeError)

  const ok = buildExplicitBrief('Key constraint: do not touch prod DB.\nUse the staging clone.')
  expect(ok.bytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
  expect(ok.mode).toBe('explicit')
  expect(ok.text).toContain('do not touch prod DB')
})

test('relevance GATE: no relevant memories + no parent ⇒ no brief (self-contained delegation)', async () => {
  mem.saveMemory({ agent: 'boss', category: 'fact', content: 'completely unrelated content about gardening tomatoes' })
  const brief = await assembleDelegationBrief(mem, db, { from: 'boss', taskDescription: 'qwxzplk vvbbnnmm zzxxccvv nonexistenttoken' })
  expect(brief).toBeNull()
})

test('anti-dump: the AUTO brief stays under the byte cap even when memories are individually huge', async () => {
  const tok = 'megapayload'
  for (let i = 0; i < 10; i++) {
    mem.saveMemory({ agent: 'boss', category: 'fact', content: `${tok} ` + 'A'.repeat(5000) + ` chunk ${i}` })
  }
  const brief = await assembleDelegationBrief(mem, db, { from: 'boss', taskDescription: `process the ${tok}` })
  expect(brief).not.toBeNull()
  expect(brief!.bytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
  expect(byteLen(brief!.text)).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
  expect(brief!.memoryIds.length).toBeLessThanOrEqual(BRIEF_MAX_MEMORIES)
})

test('parent context: brief includes parent-task context when parent_task_id is set (even if recall is thin)', async () => {
  const parent = db.createTask({ from: 'boss', to: 'kiera', description: 'PARENTUMBRELLA build the widget', priority: 'normal' })
  const brief = await assembleDelegationBrief(mem, db, {
    from: 'boss', taskDescription: 'subtask qwxzplk nomatchtoken', parentTaskId: parent.id,
  })
  expect(brief).not.toBeNull()
  expect(brief!.text).toContain('PARENTUMBRELLA')
})

// --- Codex round-1 adversarial fixes (verify-to-break) ---

test('AC-2 HARD count cap: a caller-supplied maxMemories above the ceiling is clamped (cannot widen the cap)', async () => {
  const tok = 'cappedtoken'
  for (let i = 0; i < 25; i++) mem.saveMemory({ agent: 'boss', category: 'fact', content: `${tok} relevant note ${i}` })
  // Try to bypass both caps via caller args — both must be clamped to the hard ceilings.
  const brief = await assembleDelegationBrief(mem, db, {
    from: 'boss', taskDescription: `work on ${tok}`, maxMemories: 25, maxBytes: 10_000_000,
  })
  expect(brief).not.toBeNull()
  expect(brief!.memoryIds.length).toBeLessThanOrEqual(BRIEF_MAX_MEMORIES)
  expect(brief!.bytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
})

test('relevance GATE (stopword defense): a recall hit on a stopword-only overlap does NOT produce a junk brief', async () => {
  // FTS sanitizeFtsQuery ORs every token incl. "the", so recall WILL return this row;
  // the distinctive-overlap filter must drop it ⇒ no brief.
  mem.saveMemory({ agent: 'boss', category: 'fact', content: 'the soup recipe uses carrots and the onions' })
  const brief = await assembleDelegationBrief(mem, db, { from: 'boss', taskDescription: 'write the final report' })
  expect(brief).toBeNull()
})

test('AC-4 (explicit near-cap): a near-cap explicit brief still recaps the headline at HEAD and TAIL', () => {
  const headline = 'DONOTDEPLOYTOPROD'
  const big = headline + '\n' + 'x'.repeat(BRIEF_MAX_BYTES - 400)
  const b = buildExplicitBrief(big)
  expect(b.bytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
  expect(b.text.slice(0, Math.floor(b.text.length * 0.4))).toContain(headline) // head
  expect(b.text.slice(Math.floor(b.text.length * 0.6))).toContain(headline) // tail recap (not dropped)
})

test('PC-1: parent finding summaries are included in the brief context when present', async () => {
  const parent = db.createTask({ from: 'boss', to: 'kiera', description: 'PARENTUMB build', priority: 'normal' })
  db.writeFinding({ task_id: parent.id, finding_type: 'insight', summary: 'CRITICALFINDINGXYZ use the v2 endpoint', agent_id: 'boss' })
  const brief = await assembleDelegationBrief(mem, db, {
    from: 'boss', taskDescription: 'child qwzxnomatchtoken', parentTaskId: parent.id,
  })
  expect(brief).not.toBeNull()
  expect(brief!.text).toContain('CRITICALFINDINGXYZ')
})

// --- Codex round-2 adversarial fixes ---

test('AC-8 defense-in-depth: db.delegateTask rejects an over-cap brief (direct DB bypass); at-cap is accepted', () => {
  const huge = 'x'.repeat(BRIEF_MAX_BYTES + 1)
  expect(() => db.delegateTask({
    from: 'boss', to: 'kiera', description: 'd', priority: 'normal', supervisor_agent: 'boss', delegation_brief: huge,
  })).toThrow()
  const atCap = 'y'.repeat(BRIEF_MAX_BYTES)
  const t = db.delegateTask({
    from: 'boss', to: 'kiera', description: 'd', priority: 'normal', supervisor_agent: 'boss', delegation_brief: atCap,
  })
  expect(db.getTask(t.id)!.delegation_brief!.length).toBe(BRIEF_MAX_BYTES)
})

test('PC-1: a SIBLING task\'s finding (same parent) is included in a new child\'s brief', async () => {
  const parent = db.createTask({ from: 'boss', to: 'kiera', description: 'umbrella parent', priority: 'normal' })
  db.claimTask(parent.id, 'kiera') // parent → in_progress so delegateTask accepts it as a parent
  const sibling = db.delegateTask({
    from: 'boss', to: 'kiera', description: 'sibling child', priority: 'normal', supervisor_agent: 'boss', parent_task_id: parent.id,
  })
  db.writeFinding({ task_id: sibling.id, finding_type: 'insight', summary: 'SIBLINGFINDINGABC ship it', agent_id: 'kiera' })
  const brief = await assembleDelegationBrief(mem, db, {
    from: 'boss', taskDescription: 'another child qwzxnomatchtoken', parentTaskId: parent.id,
  })
  expect(brief).not.toBeNull()
  expect(brief!.text).toContain('SIBLINGFINDINGABC')
})

test('AC-6 boot: getActiveDelegationBriefs surfaces MORE than 5 open briefed tasks', () => {
  for (let i = 0; i < 6; i++) {
    db.delegateTask({ from: 'boss', to: 'kiera', description: `t${i}`, priority: 'normal', supervisor_agent: 'boss', delegation_brief: `brief ${i}` })
  }
  expect(db.getActiveDelegationBriefs('kiera').length).toBe(6)
})
