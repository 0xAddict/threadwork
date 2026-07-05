// memory-handlers.ts — P4 anti-laundering, Stage 2b (#10376051, ATM-026).
//
// SIDE-EFFECT-FREE ON IMPORT: this module imports only types/classes from
// './memory'. It does NOT construct a TaskDB, does NOT touch DB_PATH, does
// NOT call connect()/assertAgentIdentity(), and does NOT import server.ts.
// This lets tests import handleSaveMemory directly without ever standing up
// the live MCP connection that server.ts triggers at module-load time
// (server.ts:41-42 `new TaskDB(DB_PATH)`, line 1890 `assertAgentIdentity()`,
// line 1892 top-level `await mcp.connect(...)`).
import type { MemoryDB, SaveMemoryInput, Memory, SourceType, Classification } from './memory'

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
