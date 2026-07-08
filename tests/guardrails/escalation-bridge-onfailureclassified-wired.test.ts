// tests/guardrails/escalation-bridge-onfailureclassified-wired.test.ts
// ATM-032 / REQ-020 [P1] — import-keyed EscalationBridge wiring guardrail.
//
// P6 Stage 5 (EPIC-03) added an additive `onFailureClassified` DI seam to
// EscalationBridge (src/escalation-bridge/index.ts). Stage 7 (OQ-4) adds a
// flag-ON-only runtime console.warn for the case where the flag is on but
// nobody wired the callback. Neither of those is a COMPILE-TIME guarantee
// that every current or future production construction site actually wires
// the callback (or makes a conscious, documented decision not to). This test
// is that guarantee, enforced structurally against the real filesystem.
//
// Per the codex MED fold, the scan is keyed on IMPORTS/CONSTRUCTIONS of the
// EscalationBridge class, not merely the literal `new EscalationBridge(`
// token in isolation — a caller could in principle obtain the constructor via
// a re-export or a local alias and construct it under a different name. This
// test therefore does two independent things:
//   1. Finds every `new EscalationBridge(` construction site in the repo
//      (outside tests/), and for each one, asserts EITHER the call wires an
//      `onFailureClassified` option key OR its file is on the
//      ESC_BRIDGE_CLASSIFY_EXCLUSIONS allowlist (with a written
//      justification for the exclusion).
//   2. Independently asserts that outside its defining module
//      (src/escalation-bridge/index.ts) and tests/, no file re-exports or
//      aliases the EscalationBridge class — so a caller cannot dodge check
//      (1) by obtaining the constructor under a different name that this
//      scan's `new EscalationBridge(` grep would miss.
//
// Today the enumerated non-test construction-site set is exactly
// { system/bin/sprint4-heartbeat-hook.sh } (an observation-only soak hook
// that imports EscalationBridge from an ABSOLUTE path — see its own comment:
// "Fire-and-forget callbacks: we log instead of taking real action here so
// the soak is observation-only until the team explicitly opts agents in.").
// That file is on the allowlist below, so this test passes today.

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')

// Directories to skip entirely while walking — mirrors the skip-list used by
// the sibling guardrail tests/guardrails/no-direct-nudge-paths.test.ts, plus
// 'tests' (this scan is production-code-only; tests/ is exempt by design and
// the ONE existing test-side allowlist site — the ATM-016/017 integration
// test — legitimately constructs EscalationBridge without the flag).
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'tests',
])

// ---------------------------------------------------------------------------
// ESC_BRIDGE_CLASSIFY_EXCLUSIONS — paths relative to repo root.
//
// Justification for each entry MUST be recorded here, not just in the source
// file, so this test's failure message is self-explanatory:
//
//   system/bin/sprint4-heartbeat-hook.sh — the Sprint 4 heartbeat-v2
//   observation-only soak hook. It constructs EscalationBridge with
//   onNudgeAgent/onInterruptAgent/onSendNote/onCriticalTelegram callbacks
//   that only LOG (they do not take real action) — "the soak is
//   observation-only until the team explicitly opts agents in" (its own
//   comment, verified verbatim in the source). Because it takes no real
//   escalation action yet, wiring onFailureClassified here would give a
//   false sense of coverage: there is nothing yet for it to classify a
//   failure ABOUT. Revisit this exclusion when the hook graduates out of
//   observation-only mode (KO-6).
// ---------------------------------------------------------------------------
const ESC_BRIDGE_CLASSIFY_EXCLUSIONS = ['system/bin/sprint4-heartbeat-hook.sh']

function walkAllFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue // dangling symlink etc — skip rather than crash the scan
    }
    if (stat.isDirectory()) {
      walkAllFiles(full, out)
    } else if (stat.isFile()) {
      out.push(full)
    }
  }
  return out
}

/**
 * Find every `new EscalationBridge(` construction site in `src`, returning
 * for each one the balanced argument text between its parentheses (so
 * callers can grep that slice for `onFailureClassified` without false-
 * positiving on unrelated occurrences elsewhere in the same file). Handles
 * multiple construction sites in the same file (paren-depth tracking, no
 * string-literal awareness needed for this repo's real, non-adversarial
 * source — matches the extraction style already used by
 * tests/guardrails/no-nudge-agent-signature-drift.test.ts).
 */
function findEscalationBridgeConstructions(src: string): string[] {
  const ANCHOR = 'new EscalationBridge('
  const results: string[] = []
  let searchFrom = 0
  while (true) {
    const anchorIdx = src.indexOf(ANCHOR, searchFrom)
    if (anchorIdx === -1) break

    const openIdx = anchorIdx + ANCHOR.length - 1 // index of the anchor's own '('
    let depth = 0
    let closeIdx = -1
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) {
          closeIdx = i
          break
        }
      }
    }
    if (closeIdx === -1) {
      throw new Error(`findEscalationBridgeConstructions: unbalanced parens for construction at offset ${anchorIdx}`)
    }

    results.push(src.slice(openIdx + 1, closeIdx))
    searchFrom = closeIdx + 1
  }
  return results
}

describe('ATM-032 / REQ-020: EscalationBridge onFailureClassified wiring guardrail', () => {
  const allFiles = walkAllFiles(REPO)

  test('every non-test `new EscalationBridge(` construction site wires onFailureClassified OR is on the documented allowlist', () => {
    // Failure mode (a): a NEW production constructor is added that wires
    // NEITHER onFailureClassified NOR an allowlist entry.
    // Failure mode (b): a new `new EscalationBridge(` non-test site appears
    // without a conscious allowlist/callback decision (i.e. the enumerated
    // site set silently grows beyond what this test expects/allowlists).
    const offenders: Array<{ file: string; argsPreview: string }> = []
    const enumeratedSites: string[] = []

    for (const file of allFiles) {
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue // binary/unreadable file — cannot contain `new EscalationBridge(`
      }
      if (!content.includes('new EscalationBridge(')) continue

      const relPath = relative(REPO, file)
      const constructions = findEscalationBridgeConstructions(content)
      if (constructions.length === 0) continue

      enumeratedSites.push(relPath)

      const isAllowlisted = ESC_BRIDGE_CLASSIFY_EXCLUSIONS.includes(relPath)
      const anyWired = constructions.some(argsText => /onFailureClassified/.test(argsText))

      if (!anyWired && !isAllowlisted) {
        offenders.push({ file: relPath, argsPreview: constructions[0]!.slice(0, 200) })
      }
    }

    if (offenders.length > 0) {
      const details = offenders
        .map(o => `  ${o.file} — constructs EscalationBridge without onFailureClassified and is NOT on ESC_BRIDGE_CLASSIFY_EXCLUSIONS:\n    ${o.argsPreview}`)
        .join('\n')
      throw new Error(
        `ATM-032 violation: found ${offenders.length} unwired, non-allowlisted EscalationBridge construction site(s):\n${details}\n` +
        `Either wire an onFailureClassified callback, or add the file to ESC_BRIDGE_CLASSIFY_EXCLUSIONS in this test ` +
        `with a written justification.`
      )
    }
    expect(offenders).toEqual([])

    // Sanity: today's enumerated non-test site set is exactly the allowlist —
    // proves this test is actually finding the known site (not silently
    // matching zero files), and pins the current shape so a NEW unwired site
    // (failure mode b) shows up as a set-membership diff, not just an
    // aggregate count.
    expect(enumeratedSites.sort()).toEqual([...ESC_BRIDGE_CLASSIFY_EXCLUSIONS].sort())
  })

  test('no file — INCLUDING the defining module — re-exports or aliases the EscalationBridge class outside a real construction', () => {
    // Failure mode (c): the class gets re-exported/aliased (possibly even
    // from WITHIN its own defining module — Codex round-2 fold), which would
    // let a caller construct it under a different name that the
    // `new EscalationBridge(` scan above would miss entirely — silently
    // defeating check (1). The previous version of this guardrail SKIPPED
    // the defining module entirely, so `export const Bridge =
    // EscalationBridge` added there evaded both scans. It is now scanned
    // like every other file; the patterns below are shaped so the module's
    // own legitimate declarations (`export class EscalationBridge {` and
    // `export interface EscalationBridgeOptions`) do not false-positive:
    //  - `\bEscalationBridge\b` word-boundaries exclude EscalationBridgeOptions
    //    and fromEscalationBridgeAllPathsFailed (the substring is embedded
    //    mid-identifier with no boundary on at least one side).
    //  - `export class EscalationBridge {` has no `=`, `as`, `default`, or
    //    `{` directly after `export`, so none of the patterns below match it.
    const DEFINING_MODULE = 'src/escalation-bridge/index.ts'

    const reExportPatterns = [
      // export { EscalationBridge } from '...'  /  export { EscalationBridge as X } from '...'
      /export\s*\{[^}]*\bEscalationBridge\b[^}]*\}\s*from/,
      // export { EscalationBridge }  (local re-export of an imported binding, no 'from')
      /export\s*\{[^}]*\bEscalationBridge\b[^}]*\}/,
      // import { EscalationBridge as X } / export { EscalationBridge as X } — any aliasing
      /\bEscalationBridge\s+as\s+\w+/,
      // export const/let/var X = EscalationBridge  (assignment alias export)
      /export\s+(const|let|var)\s+\w+\s*=\s*EscalationBridge\b/,
      // const/let/var X = EscalationBridge  (local alias binding — `=\s*EscalationBridge`
      // requires the assigned value to be the bare class reference, so it
      // naturally does NOT match `= new EscalationBridge(...)`: "new" is not
      // whitespace, so \s* cannot skip over it)
      /(^|[^.\w])(const|let|var)\s+\w+\s*=\s*EscalationBridge\b/,
      // export default EscalationBridge
      /export\s+default\s+EscalationBridge\b/,
    ]

    const offenders: Array<{ file: string; line: number; text: string }> = []

    for (const file of allFiles) {
      const relPath = relative(REPO, file)

      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      if (!content.includes('EscalationBridge')) continue

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        if (reExportPatterns.some(re => re.test(line))) {
          offenders.push({ file: relPath, line: i + 1, text: trimmed })
        }
      }
    }

    if (offenders.length > 0) {
      const details = offenders.map(o => `  ${o.file}:${o.line} — ${o.text}`).join('\n')
      throw new Error(
        `ATM-032 violation: EscalationBridge appears to be re-exported or aliased (including possibly from ` +
        `within its own defining module, ${DEFINING_MODULE}):\n${details}\n` +
        `This would let a caller obtain the constructor under a different name that the ` +
        `\`new EscalationBridge(\` construction-site scan above cannot see, silently defeating the wiring guardrail.`
      )
    }
    expect(offenders).toEqual([])
  })
})
