// memory-handlers.ts — P4 anti-laundering, Stage 2b (#10376051, ATM-026).
//
// SIDE-EFFECT-FREE ON IMPORT: this module imports only types/classes from
// './memory'. It does NOT construct a TaskDB, does NOT touch DB_PATH, does
// NOT call connect()/assertAgentIdentity(), and does NOT import server.ts.
// This lets tests import handleSaveMemory directly without ever standing up
// the live MCP connection that server.ts triggers at module-load time
// (server.ts:41-42 `new TaskDB(DB_PATH)`, line 1890 `assertAgentIdentity()`,
// line 1892 top-level `await mcp.connect(...)`).
import type { MemoryDB, SaveMemoryInput, Memory, SourceType, Classification, BootBriefing } from './memory'
import type { TaskDB } from './db'
import { sanitizeBootBriefing, sanitizeMemoryContent } from './memory-integrity'

/**
 * Extracted body of server.ts `case 'save_memory':` (C2 crux). Parses the
 * same args the inline case body parsed, then persists via mem.saveMemory().
 *
 * REQ-020/ATM-026: when the P4 sanitization flag is ON, source_type is
 * derived from the AUTHENTICATED caller identity (deps.selfLabel) and any
 * caller-supplied args.source_type is ignored — self-asserted source_type is
 * exactly the laundering vector P4 closes. When the flag is OFF, args.source_type
 * passes through untouched (byte-parity with pre-P4 behavior).
 */
export function handleSaveMemory(
  args: Record<string, unknown>,
  deps: { mem: MemoryDB; selfLabel: string },
): Memory {
  const content = args.content as string
  const category = args.category as string
  const importance = (args.importance as number) ?? 3
  const pinned = (args.pinned as boolean) ?? false
  const classification = args.classification as Classification | undefined
  const quality = args.quality as number | undefined
  const evidence = args.evidence as string | undefined
  const supersedes_memory_id = args.supersedes_memory_id as number | undefined

  const sanitizeOn = deps.mem.isSanitizationEnabled()
  const source_type = sanitizeOn
    ? deps.mem.inferSourceType(deps.selfLabel)
    : (args.source_type as SourceType | undefined)

  const input: SaveMemoryInput = {
    agent: deps.selfLabel,
    content,
    category,
    importance,
    pinned,
    classification,
    quality,
    source_type,
    evidence,
    supersedes_memory_id,
  }

  return deps.mem.saveMemory(input)
}

/**
 * Extracted body of server.ts `case 'get_boot_briefing':` (ATM-032), mirroring
 * handleSaveMemory above. SIDE-EFFECT-FREE ON IMPORT — same rationale as the
 * module header: no connect()/assertAgentIdentity(), no new TaskDB constructed
 * here, so tests can import this directly without standing up the live MCP
 * connection server.ts triggers at module-load time.
 *
 * REQ-016 (ATM-030/ATM-016/ATM-017): when the P4 sanitization flag is ON, the
 * raw briefing is passed through sanitizeBootBriefing() before being returned
 * — every free-text field (memory content, task descriptions/results, the
 * relevance query) is neutralized. When the flag is OFF, the raw briefing is
 * returned untouched (byte-parity with pre-P4 behavior).
 */
export function handleGetBootBriefing(
  args: Record<string, unknown>,
  deps: { mem: MemoryDB; taskDb: TaskDB; selfLabel: string },
): BootBriefing {
  const query = args.query as string | undefined
  const raw = deps.mem.getBootBriefing(deps.selfLabel, deps.taskDb, query)
  return deps.mem.isSanitizationEnabled() ? sanitizeBootBriefing(raw) : raw
}

/**
 * Stage 7 KO-3 (#10376058): the AUTHORIZED system-tier session-handoff write
 * path. Fixes the rehydrate break caused by the C2/ATM-026 fix: the recycle
 * SOP used to write handoffs via save_memory, but with the sanitization flag
 * ON, save_memory now derives source_type from SELF_LABEL ('agent') — so the
 * forged-trust-marker pattern (agentTierOnly, memory-integrity-patterns.ts)
 * strips the `[session-handoff:` marker at write time, and session-boot.sh's
 * `content LIKE '[session-handoff:LABEL:%'` SELECT no longer matches.
 *
 * write_handoff is a NARROW, trusted server-internal callsite — NOT a general
 * laundering escape hatch. It enforces all three of:
 *
 *   1. The `[session-handoff:<agent>:<ts>]` marker is SERVER-CONSTRUCTED from
 *      the authenticated deps.selfLabel and a server-generated timestamp.
 *      Neither is taken from caller args — the agent cannot forge the agent
 *      id or the ts embedded in its own marker.
 *   2. The agent-authored body is sanitized at AGENT tier
 *      (sanitizeMemoryContent(body, { sourceType: 'agent' })) BEFORE it is
 *      wrapped in the marker. An embedded forged marker / SYSTEM: header /
 *      directive in the body is neutralized here — it is never laundered as
 *      system-tier content just because the outer write is source_type:
 *      'system'.
 *   3. saveMemory() is called with source_type: 'system' hardcoded in this
 *      function — never derived from caller args — and this handler writes
 *      ONLY handoff-category memories (fixed category: 'fact', fixed
 *      marker shape), not arbitrary agent-supplied content/category/
 *      source_type combinations. This is a trusted in-process construction of
 *      SaveMemoryInput (allowed to assert source_type: 'system' per REQ-020);
 *      it is NOT the save_memory MCP tool, so it is exempt from the ATM-026
 *      SELF_LABEL-derivation that handler applies to caller-facing saves.
 *
 * Because the assembled content is written at source_type: 'system', its own
 * saveMemory-internal sanitize pass (flag ON) treats forged-trust-marker as
 * agentTierOnly and skips it — the outer `[session-handoff:` marker survives.
 * Every OTHER pattern (fake-role-header, ignore-instructions, fenced-directive,
 * embedded-tool-call) is not agentTierOnly and still sweeps the assembled
 * content regardless of tier; the body was already agent-tier sanitized above,
 * so in practice nothing new should trip there.
 *
 * Flag OFF: this function still writes source_type: 'system' with the RAW
 * (unsanitized) body — byte-parity with what the pre-P4 recycle SOP's
 * save_memory call wrote for the same body (marker + raw body, source_type
 * 'system'; only the ts naturally differs run-to-run).
 *
 * Stage 7 KO-3 quarantine (#10376063, structural defense-in-depth): the body
 * above is sanitized best-effort (detector-based) at agent tier before being
 * wrapped — but a DETECTOR MISS in that body is the one path where a miss
 * would still reach source_type:'system' state:'active' importance:5 memory,
 * i.e. active/trusted recall. So independent of detection, when the flag is
 * ON we force the written row to state:'proposed' via markMemoryProposed().
 * 'proposed' rows are excluded from every active-filtered trusted section
 * (topMemories/sharedMemories/getBootBriefing all filter state='active'),
 * so a missed payload cannot ride along into trusted recall even if no
 * pattern trips. session-boot.sh — the sole legitimate handoff consumer —
 * is widened to match state IN ('active','proposed') so the quarantined
 * handoff is still found and rehydrated. Flag OFF -> state stays 'active',
 * byte-parity with the pre-P4 recycle SOP's save_memory write.
 */
export function handleWriteHandoff(
  args: { body: string },
  deps: { mem: MemoryDB; selfLabel: string },
): Memory {
  const ts = new Date().toISOString()
  const flagOn = deps.mem.isSanitizationEnabled()

  const rawBody = String(args.body ?? '')
  const safeBody = flagOn
    ? sanitizeMemoryContent(rawBody, { sourceType: 'agent' }).text
    : rawBody

  const content = `[session-handoff:${deps.selfLabel}:${ts}] ${safeBody}`

  const memory = deps.mem.saveMemory({
    agent: deps.selfLabel,
    content,
    category: 'fact',
    importance: 5,
    source_type: 'system',
  })

  return flagOn ? deps.mem.markMemoryProposed(memory.id) : memory
}
