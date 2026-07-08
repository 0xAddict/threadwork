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
// Codex round-3 fold (Finding 1 / P1): a purely construction-keyed scan
// (`new EscalationBridge(` / `new X.EscalationBridge(`) can never be
// exhaustive — a caller can obtain the constructor via a namespace import
// (`import * as EB from '...'; new EB.EscalationBridge({})`) or reflectively
// (`Reflect.construct(EscalationBridge, [{}])`), neither of which the prior
// literal-token scan could see. The fix is IMPORT-KEYED (the codex-MED
// intent, sharpened): to construct the class by ANY means whatsoever — direct,
// aliased, namespace-member, or reflective — a non-test file MUST first
// import the escalation-bridge module. Keying the primary scan on the IMPORT
// (rather than the construction syntax) therefore closes all of those
// bypasses at once, structurally, without needing to enumerate every possible
// JS construction idiom.
//
// This file does FOUR independent things:
//   1. [import-keyed, PRIMARY] Finds every non-test file that IMPORTS the
//      escalation-bridge module (named/default/namespace static import,
//      dynamic `import(...)`, `require(...)`, relative OR absolute path) and
//      asserts EITHER the file wires an `onFailureClassified` callback
//      somewhere OR its file is on the ESC_BRIDGE_CLASSIFY_EXCLUSIONS
//      allowlist. Also pins the enumerated importer set to exactly the
//      allowlist so the scan can't silently be matching zero files.
//   2. [construction-site, defense-in-depth] Finds every `new EscalationBridge(`
//      OR `new X.EscalationBridge(` (namespace-member) construction site and
//      asserts the SAME wiring/allowlist rule per call, using precise
//      balanced-paren argument extraction.
//   3. [reflective-construction, defense-in-depth] Flags any
//      `Reflect.construct(EscalationBridge, ...)` site under the same rule.
//   4. Independently asserts that outside its defining module
//      (src/escalation-bridge/index.ts) and tests/, no file re-exports or
//      aliases the EscalationBridge class — so a caller cannot dodge checks
//      (1)-(3) by obtaining the constructor under a re-exported name that
//      those scans would miss.
//
// Today the enumerated non-test importer/construction-site set is exactly
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

// Direct `new EscalationBridge(` OR namespace-member `new EB.EscalationBridge(`
// — both have an IDENTICAL argument-list shape immediately following the
// matched anchor text (the anchor itself always ends in a literal '('), so
// one balanced-paren extraction routine below handles both uniformly. A
// fresh RegExp instance is constructed per call site (rather than sharing a
// module-level `g`-flag regex) to avoid `lastIndex` state bugs across the
// two independent scans (`test()` in the pre-filter vs `exec()` in the
// extraction loop) that both use this pattern.
const CONSTRUCTION_ANCHOR_SRC = 'new\\s+(?:\\w+\\.)?EscalationBridge\\s*\\('

/**
 * Find every `new EscalationBridge(` / `new X.EscalationBridge(` construction
 * site in `src`, returning for each one the balanced argument text between
 * its parentheses (so callers can grep that slice for `onFailureClassified`
 * without false-positiving on unrelated occurrences elsewhere in the same
 * file). Handles multiple construction sites in the same file (paren-depth
 * tracking, no string-literal awareness needed for this repo's real,
 * non-adversarial source — matches the extraction style already used by
 * tests/guardrails/no-nudge-agent-signature-drift.test.ts).
 */
function findEscalationBridgeConstructions(src: string): string[] {
  const anchorRe = new RegExp(CONSTRUCTION_ANCHOR_SRC, 'g')
  const results: string[] = []
  let match: RegExpExecArray | null
  while ((match = anchorRe.exec(src)) !== null) {
    const openIdx = match.index + match[0].length - 1 // index of the anchor's own '('
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
      throw new Error(`findEscalationBridgeConstructions: unbalanced parens for construction at offset ${match.index}`)
    }

    results.push(src.slice(openIdx + 1, closeIdx))
    anchorRe.lastIndex = closeIdx + 1
  }
  return results
}

// Reflective construction: `Reflect.construct(EscalationBridge, [args])`. The
// real constructor arguments live in a SECOND positional argument (an array
// literal), not immediately inside `Reflect.construct(`'s own parens, so the
// balanced-paren single-call extraction above does not apply cleanly here.
// This is a defense-in-depth, whole-file-scoped check (coarser than the
// precise per-call extraction above, which is acceptable because the
// import-keyed scan below is the PRIMARY guarantee — this is a secondary,
// explicit flag for a rare and already-unusual construction idiom).
const REFLECT_CONSTRUCT_RE = /Reflect\s*\.\s*construct\s*\(\s*EscalationBridge\b/

/**
 * Detects whether `content` IMPORTS the escalation-bridge module by any
 * means: a static `import ... from '<path>'` (named, default, OR namespace
 * `import * as X from '<path>'` — `[^'"]*` between `import` and `from`
 * happily matches `* as X `, `{ EscalationBridge }`, a bare default name, or
 * any combination), a dynamic `import('<path>')`, or a `require('<path>')`.
 * `<path>` just needs to CONTAIN the substring `escalation-bridge` — this
 * covers both the relative `../escalation-bridge/index` form used by real TS
 * source and the ABSOLUTE `/Users/.../src/escalation-bridge/index.ts` form
 * used by system/bin/sprint4-heartbeat-hook.sh's embedded heredoc script (a
 * plain-text scan, since that file is a .sh, not parsed TS — matching the
 * house pattern already used by the construction-site scan above, which
 * finds `new EscalationBridge(` inside that same heredoc as plain text).
 *
 * Because ANY means of constructing the class — direct, aliased,
 * namespace-member, or `Reflect.construct` — requires the class reference to
 * enter the file's scope via one of these import forms first, keying on the
 * import (rather than enumerating construction syntaxes) closes all of those
 * bypasses at once.
 */
function importsEscalationBridgeModule(content: string): boolean {
  const IMPORT_PATTERNS: RegExp[] = [
    // import ... from '<...escalation-bridge...>'  (named/default/namespace)
    /import\s+[^'";]*\sfrom\s+['"][^'"]*escalation-bridge[^'"]*['"]/,
    // import('<...escalation-bridge...>')  (dynamic)
    /import\s*\(\s*['"][^'"]*escalation-bridge[^'"]*['"]\s*\)/,
    // require('<...escalation-bridge...>')
    /require\s*\(\s*['"][^'"]*escalation-bridge[^'"]*['"]\s*\)/,
  ]
  return IMPORT_PATTERNS.some(re => re.test(content))
}

// ---------------------------------------------------------------------------
// Codex round-4 fold (Finding 1 / P1): a bare TEXTUAL mention of
// `onFailureClassified` — inside a `//` line comment, a `/* ... */` block
// comment, or a string literal (e.g. `// TODO: onFailureClassified` with no
// real callback, or the word embedded in an unrelated string) previously
// counted as "wired" by both the construction-site `anyWired` check and the
// import-keyed `content.includes('onFailureClassified')` check below — a
// silent, undetected drop at runtime (`opts.onFailureClassified` stays
// `undefined`). The fix has two parts:
//   (a) STRIP comments and string-literal bodies from the text BEFORE
//       scanning for wiring, so neither can produce a false "wired" result.
//   (b) Detect wiring as an actual OBJECT KEY — `onFailureClassified`
//       followed by optional whitespace then `:` — not any textual
//       occurrence. (This repo's real wiring sites always use the
//       `onFailureClassified: <expr>` key/value form — see
//       src/escalation-bridge/index.ts and
//       tests/failure-classification-escalation-integration.test.ts — never
//       ES2015 shorthand `{ onFailureClassified }`, so anchoring on `:` does
//       not false-negative against any real site in this codebase.)
// ---------------------------------------------------------------------------

// A single combined alternation regex — rather than three sequential
// `.replace()` passes for block comments, then line comments, then strings —
// is required for correctness: sequential passes would mis-strip a `//` that
// appears INSIDE a string literal (e.g. `"http://example.com"`) as if it
// started a line comment, corrupting the string and everything after it on
// that line. A single regex lets whichever alternative's opening token
// (`/*`, `//`, a quote char) appears EARLIEST at each scan position win,
// which is the correct precedence — a string's opening quote is consumed as
// a string in its entirety (including any `//` inside it) before the scanner
// ever considers a comment starting mid-string.
const STRIP_COMMENTS_AND_STRINGS_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g

/**
 * Removes line comments (`// ...` to end of line), block comments
 * (`/* ... *​/`, non-greedy, spans newlines), and the BODIES of
 * single/double/backtick-quoted string literals (replaced with an empty
 * literal of the same quote type, so surrounding token structure is
 * preserved) from `text`. A lightweight, non-tokenizing strip — adequate for
 * this repo's real, non-adversarial source (same tradeoff already accepted
 * by `findEscalationBridgeConstructions`'s non-string-aware paren balancing
 * above).
 */
function stripCommentsAndStrings(text: string): string {
  return text.replace(STRIP_COMMENTS_AND_STRINGS_RE, (match) => {
    if (match.startsWith('/*') || match.startsWith('//')) return ''
    const quote = match[0]!
    return quote + quote // collapse to an empty same-quote literal, dropping the body
  })
}

// A REAL wiring reference is an object-KEY occurrence — `onFailureClassified`
// immediately followed by optional whitespace then `:` — never a bare
// textual mention. Word-boundary-anchored on the left so it cannot match as
// a substring of some other identifier.
const ONFAILURECLASSIFIED_KEY_RE = /\bonFailureClassified\s*:/

describe('ATM-032 / REQ-020: EscalationBridge onFailureClassified wiring guardrail', () => {
  const allFiles = walkAllFiles(REPO)

  test('every non-test `new EscalationBridge(` / `new X.EscalationBridge(` construction site wires onFailureClassified OR is on the documented allowlist', () => {
    // Failure mode (a): a NEW production constructor is added that wires
    // NEITHER onFailureClassified NOR an allowlist entry.
    // Failure mode (b): a new construction non-test site appears without a
    // conscious allowlist/callback decision (i.e. the enumerated site set
    // silently grows beyond what this test expects/allowlists).
    // Codex round-3 fold (Finding 1): the anchor now also matches the
    // namespace-member form `new EB.EscalationBridge(` (not just the bare
    // `new EscalationBridge(`), so an alias obtained via a namespace import
    // is caught here too, in addition to the import-keyed test below.
    const offenders: Array<{ file: string; argsPreview: string }> = []
    const enumeratedSites: string[] = []
    const constructionPreFilterRe = new RegExp(CONSTRUCTION_ANCHOR_SRC)

    for (const file of allFiles) {
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue // binary/unreadable file — cannot contain a construction site
      }
      if (!constructionPreFilterRe.test(content)) continue

      const relPath = relative(REPO, file)
      const constructions = findEscalationBridgeConstructions(content)
      if (constructions.length === 0) continue

      enumeratedSites.push(relPath)

      const isAllowlisted = ESC_BRIDGE_CLASSIFY_EXCLUSIONS.includes(relPath)
      const anyWired = constructions.some(argsText => ONFAILURECLASSIFIED_KEY_RE.test(stripCommentsAndStrings(argsText)))

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

  test('[PRIMARY, import-keyed] every non-test file that imports the escalation-bridge module wires onFailureClassified OR is on the documented allowlist', () => {
    // Codex round-3 fold (Finding 1 / P1): this is the primary, structural
    // guarantee. A caller can construct EscalationBridge by ANY means —
    // direct (`new EscalationBridge(`), namespace-member
    // (`new EB.EscalationBridge(`), reflective (`Reflect.construct
    // (EscalationBridge, [...])`) — but every one of those forms requires
    // the class reference to enter the file's scope via an import first
    // (static named/default/namespace import, dynamic `import()`, or
    // `require()`). Keying the scan on the IMPORT rather than any one
    // construction syntax therefore closes namespace-member and reflective
    // bypasses (and any future construction idiom) in one structural check,
    // rather than needing to keep enumerating JS construction forms forever.
    //
    // The check is deliberately coarse per file (does `onFailureClassified`
    // appear ANYWHERE in the importing file, not scoped to a specific call's
    // argument list) — a file that imports the module for ANY reason without
    // ever mentioning `onFailureClassified` cannot possibly be wiring it, so
    // this cannot false-negative; it also cannot meaningfully false-positive
    // in this repo's non-adversarial source (a file that imports the module
    // AND happens to mention `onFailureClassified` in an unrelated context
    // would be an extraordinarily contrived false-clean, not a realistic
    // production pattern).
    const offenders: Array<{ file: string; reason: string }> = []
    const importerSites: string[] = []

    for (const file of allFiles) {
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue // binary/unreadable file — cannot contain an import statement
      }
      if (!importsEscalationBridgeModule(content)) continue

      const relPath = relative(REPO, file)
      importerSites.push(relPath)

      const isAllowlisted = ESC_BRIDGE_CLASSIFY_EXCLUSIONS.includes(relPath)
      const wiresCallback = ONFAILURECLASSIFIED_KEY_RE.test(stripCommentsAndStrings(content))

      if (!wiresCallback && !isAllowlisted) {
        offenders.push({
          file: relPath,
          reason: 'imports the escalation-bridge module but the file contains no `onFailureClassified` reference anywhere',
        })
      }
    }

    if (offenders.length > 0) {
      const details = offenders.map(o => `  ${o.file} — ${o.reason}`).join('\n')
      throw new Error(
        `ATM-032 violation (import-keyed): found ${offenders.length} importer(s) of the escalation-bridge module that ` +
        `neither wire onFailureClassified nor appear on ESC_BRIDGE_CLASSIFY_EXCLUSIONS:\n${details}\n` +
        `This closes namespace-member (\`new X.EscalationBridge(\`) and reflective (\`Reflect.construct(EscalationBridge, ...)\`) ` +
        `construction bypasses that a literal \`new EscalationBridge(\` scan alone cannot see — any construction technique ` +
        `requires importing the module first. Either wire an onFailureClassified callback somewhere in the file, or add it ` +
        `to ESC_BRIDGE_CLASSIFY_EXCLUSIONS in this test with a written justification.`
      )
    }
    expect(offenders).toEqual([])

    // Sanity: today's enumerated non-test IMPORTER set is exactly the
    // allowlist — proves the import-keyed scan is actually finding the known
    // site (not silently matching zero files), pinned so a NEW unwired
    // importer shows up as a set-membership diff, not just an aggregate
    // count. (On the clean tree, the only non-test file that imports the
    // module at all is system/bin/sprint4-heartbeat-hook.sh — no other P6
    // source file imports EscalationBridge, they only reference its adapter
    // function or its path in comments/tsconfig.)
    expect(importerSites.sort()).toEqual([...ESC_BRIDGE_CLASSIFY_EXCLUSIONS].sort())
  })

  test('[defense-in-depth] every non-test Reflect.construct(EscalationBridge, ...) reflective-construction site wires onFailureClassified OR is on the documented allowlist', () => {
    // Codex round-3 fold (Finding 1 / P1): explicit, named coverage for the
    // reflective-construction bypass (`Reflect.construct(EscalationBridge,
    // [args])`) called out by the fold instructions, kept as an independent,
    // narrowly-scoped assertion in addition to the import-keyed primary
    // guarantee above (which already covers this case generically, since
    // Reflect.construct also requires importing the class reference first).
    // Whole-file-scoped (not per-call argument extraction) because the real
    // constructor arguments live in Reflect.construct's SECOND positional
    // argument (an array literal), not immediately inside its own parens.
    const offenders: string[] = []

    for (const file of allFiles) {
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      if (!REFLECT_CONSTRUCT_RE.test(content)) continue

      const relPath = relative(REPO, file)
      const isAllowlisted = ESC_BRIDGE_CLASSIFY_EXCLUSIONS.includes(relPath)
      const wiresCallback = ONFAILURECLASSIFIED_KEY_RE.test(stripCommentsAndStrings(content))

      if (!wiresCallback && !isAllowlisted) {
        offenders.push(relPath)
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `ATM-032 violation (reflective construction): found Reflect.construct(EscalationBridge, ...) in ` +
        `${offenders.length} file(s) with no onFailureClassified reference and no allowlist entry: ${offenders.join(', ')}`
      )
    }
    expect(offenders).toEqual([])

    // On the clean tree, zero files use Reflect.construct(EscalationBridge —
    // it is not a realistic idiom for this repo today. This test exists to
    // fail loudly the moment one appears without a conscious wiring/allowlist
    // decision, not to assert a nonzero enumerated set.
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

    // Codex round-4 fold (Finding 2 / P1): the identifier-keyed patterns
    // below all require the literal text "EscalationBridge" to appear on the
    // offending line. That misses a TRANSITIVE re-export via a wildcard —
    // `export * from './escalation-bridge'` — because that line only
    // contains the lowercase, hyphenated MODULE PATH, never the capitalized
    // class identifier. A consumer can then obtain the class via a
    // namespace import of the re-exporting module and a MEMBER-ACCESS alias
    // (`const Bridge = leaked.EscalationBridge`), which the identifier-keyed
    // patterns also miss (they match assignment-of-the-BARE-identifier —
    // `= EscalationBridge` — not property access — `= leaked.EscalationBridge`).
    // The two new patterns below close this structurally:
    //   (a) forbid re-exporting the escalation-bridge MODULE at all (keyed on
    //       the module PATH substring, not the class identifier) — this kills
    //       the transitive-re-export enabler outright: no module can
    //       re-export the class (wildcard OR named) for a consumer to later
    //       alias.
    //   (b) forbid a member-access alias of the class off ANY namespace
    //       object (`= X.EscalationBridge`).
    // A genuinely dynamic/computed/multi-hop-reflective construction (e.g. a
    // path built at runtime from string concatenation, or aliasing through
    // more than one additional re-export hop) remains an EXOTIC residual
    // explicitly covered by REQ-020's KO-6 + the OQ-4 flag-ON-only runtime
    // constructor guard (the spec-sanctioned belt-and-suspenders in
    // src/escalation-bridge/index.ts's own console.warn) — this static guard
    // closes the realistic + one-hop-re-export surface; the runtime guard
    // backstops the rest.
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
      // Codex round-4 (Finding 2a): export * from '<...escalation-bridge...>'
      // — wildcard re-export of the whole module, keyed on the module PATH
      // substring (not the class identifier, which never appears on this
      // line).
      /export\s*\*\s*from\s*['"][^'"]*escalation-bridge[^'"]*['"]/,
      // Codex round-4 (Finding 2a): export { ... } from '<...escalation-bridge...>'
      // — ANY named re-export FROM the module, keyed on the module PATH
      // substring rather than requiring "EscalationBridge" literally inside
      // the braces (closes e.g. `export { default as Foo } from
      // './escalation-bridge'`, which the identifier-keyed pattern above
      // would miss).
      /export\s*\{[^}]*\}\s*from\s*['"][^'"]*escalation-bridge[^'"]*['"]/,
      // Codex round-4 (Finding 2b): const/let/var X = Y.EscalationBridge
      // — member-access alias off a namespace/object reference (e.g.
      // `const Bridge = leaked.EscalationBridge`), distinct from the
      // bare-identifier alias pattern above (`= EscalationBridge` has no
      // `.` before it; this one requires exactly one).
      /=\s*\w+\.EscalationBridge\b/,
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
      // Codex round-4 fold (Finding 2): scan any file mentioning EITHER the
      // class identifier OR the module's lowercase path substring — a
      // wildcard re-export line (`export * from './escalation-bridge'`)
      // contains only the latter, so gating on the identifier alone (the
      // pre-round-4 behavior) silently skipped such files entirely.
      if (!content.includes('EscalationBridge') && !content.includes('escalation-bridge')) continue

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
