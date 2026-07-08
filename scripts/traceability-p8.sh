#!/usr/bin/env bash
# traceability-p8.sh — P8 Stage 8 traceability / ATOM-coverage gate (G6).
#
# Two independent checks, both driven by grepping the actual spec/test text
# (not hardcoded ID lists), so this re-confirms the already-lock-verified spec
# rather than restating it. Mirrors scripts/traceability-p5.sh.
#
#   1. Manifest check: every M-001..M-018 in the spec's "## Traceability
#      manifest" table is (a) present in that table, and (b) referenced by >=1
#      REQ in the "## EPICS" section. Reports any orphan.
#   2. Atomic-coverage check: every ATM id listed in the Done-gate's P1/P2/P3
#      atomics enumeration (ATM-001..030) is referenced by >=1 file under
#      tests/ (proving the atomic has an implemented verifier). Exits non-zero
#      if any P1 or P2 atomic has NO test reference (P3 atomics may be
#      legitimately descoped per the spec's Done-gate item 3, so a missing P3
#      reference is reported but does not fail the gate).
#
# Usage: bash ./scripts/traceability-p8.sh   (run from the P6 worktree)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SPEC="/Users/coachstokes/.claude/state/p4-p8-fanout/specs/P8-spec.md"
TESTS_DIR="$REPO_DIR/tests"

overall_exit=0

if [ ! -f "$SPEC" ]; then
  echo "[traceability-p8] FATAL: spec not found at $SPEC" >&2
  exit 1
fi
if [ ! -d "$TESTS_DIR" ]; then
  echo "[traceability-p8] FATAL: tests/ dir not found at $TESTS_DIR" >&2
  exit 1
fi

echo "=================================================================="
echo "[traceability-p8] CHECK 1 — M-001..M-018 manifest + REQ-reference"
echo "=================================================================="

manifest_section="$(awk '/^## Traceability manifest/{p=1; next} /^## /{if (p) exit} p' "$SPEC")"
epics_section="$(awk '/^## EPICS/{p=1; next} /^## Done-gate/{if (p) exit} p' "$SPEC")"

if [ -z "$manifest_section" ]; then
  echo "[traceability-p8] FATAL: could not locate '## Traceability manifest' section" >&2
  exit 1
fi
if [ -z "$epics_section" ]; then
  echo "[traceability-p8] FATAL: could not locate '## EPICS' section" >&2
  exit 1
fi

manifest_orphans=0
printf "%-8s %-12s %-16s\n" "M-ID" "IN-MANIFEST" "REFD-BY-REQ"
printf "%-8s %-12s %-16s\n" "----" "-----------" "-----------"
for i in $(seq -w 1 18); do
  mid="M-0$i"
  in_manifest="NO"
  refd="NO"
  if grep -q "$mid" <<<"$manifest_section"; then in_manifest="yes"; fi
  if grep -q "$mid" <<<"$epics_section"; then refd="yes"; fi
  printf "%-8s %-12s %-16s\n" "$mid" "$in_manifest" "$refd"
  if [ "$in_manifest" != "yes" ] || [ "$refd" != "yes" ]; then
    manifest_orphans=$((manifest_orphans + 1))
  fi
done

echo ""
if [ "$manifest_orphans" -gt 0 ]; then
  echo "[traceability-p8] CHECK 1 FAILED — $manifest_orphans orphan M-### id(s)"
  overall_exit=1
else
  echo "[traceability-p8] CHECK 1 OK — all M-001..M-018 present in manifest and referenced by >=1 REQ, zero orphans"
fi

echo ""
echo "=================================================================="
echo "[traceability-p8] CHECK 2 — Done-gate P1/P2/P3 atomics -> test coverage"
echo "=================================================================="

donegate_section="$(awk '/^## Done-gate/{p=1; next} /^## /{if (p) exit} p' "$SPEC")"
if [ -z "$donegate_section" ]; then
  echo "[traceability-p8] FATAL: could not locate '## Done-gate' section" >&2
  exit 1
fi

# Item 1 = P1 list, item 2 = P2 list, item 3 = P3 list. Extract each item's
# text block, then pull every 3-digit run (ATM ids) out of it.
p1_block="$(awk '/^1\. /{p=1} /^2\. /{p=0} p' <<<"$donegate_section")"
p2_block="$(awk '/^2\. /{p=1} /^3\. /{p=0} p' <<<"$donegate_section")"
p3_block="$(awk '/^3\. /{p=1} /^4\. /{p=0} p' <<<"$donegate_section")"

p1_ids="$(grep -oE '[0-9]{3}' <<<"$p1_block" | sort -n -u)"
p2_ids="$(grep -oE '[0-9]{3}' <<<"$p2_block" | sort -n -u)"
p3_ids="$(grep -oE '[0-9]{3}' <<<"$p3_block" | sort -n -u)"

# Parser self-check against the Done-gate's own stated counts (P6 spec uses
# "23 P1 atomics", "8 P2 atomics", "1 P3 atomic" — note P3 is singular).
p1_stated="$(grep -oE '\*\*[0-9]+ P1 atomics\*\*' <<<"$donegate_section" | grep -oE '[0-9]+' | head -1)"
p2_stated="$(grep -oE '\*\*[0-9]+ P2 atomics\*\*' <<<"$donegate_section" | grep -oE '[0-9]+' | head -1)"
p3_stated="$(grep -oE '\*\*[0-9]+ P3 atomic' <<<"$donegate_section" | grep -oE '[0-9]+' | head -1)"
p1_count=$(wc -l <<<"$p1_ids" | tr -d ' ')
p2_count=$(wc -l <<<"$p2_ids" | tr -d ' ')
p3_count=$(wc -l <<<"$p3_ids" | tr -d ' ')
if [ -n "$p1_stated" ] && [ "$p1_count" != "$p1_stated" ]; then
  echo "[traceability-p8] FATAL: parser self-check failed — spec states $p1_stated P1 atomics but parsed $p1_count" >&2
  exit 1
fi
if [ -n "$p2_stated" ] && [ "$p2_count" != "$p2_stated" ]; then
  echo "[traceability-p8] FATAL: parser self-check failed — spec states $p2_stated P2 atomics but parsed $p2_count" >&2
  exit 1
fi
if [ -n "$p3_stated" ] && [ "$p3_count" != "$p3_stated" ]; then
  echo "[traceability-p8] FATAL: parser self-check failed — spec states $p3_stated P3 atomics but parsed $p3_count" >&2
  exit 1
fi
if [ -z "$p1_ids" ] || [ -z "$p2_ids" ] || [ -z "$p3_ids" ]; then
  echo "[traceability-p8] FATAL: failed to parse one or more of the P1/P2/P3 atomic lists" >&2
  exit 1
fi

missing_blocking=0
printf "%-9s %-4s %-9s\n" "ATM" "PRI" "STATUS"
printf "%-9s %-4s %-9s\n" "---" "---" "------"

# Scope the ATM->test coverage check to P8-OWNED test files only. P7 and P8
# share ATM-0NN numbering (both start at ATM-001), so a repo-wide grep over
# tests/ would let a P7 test file referencing e.g. "ATM-005" spuriously satisfy
# P8's ATM-005 coverage. Every P8 atomic's spec-declared verifier lives in a
# ternary-reward*.test.ts file, so restrict the grep to those.
P8_TEST_FILES="$(find "$TESTS_DIR" -type f -name 'ternary-reward*' 2>/dev/null)"
if [ -z "$P8_TEST_FILES" ]; then
  echo "[traceability-p8] NOTE: no P8-owned test files (ternary-reward*) found under $TESTS_DIR yet — every ATM will read MISSING until the P8 suites land." >&2
fi

check_group() {
  local ids="$1"; local pri="$2"; local blocking="$3"
  local n atm found
  for n in $ids; do
    atm="ATM-$n"
    found="MISSING"
    if [ -n "$P8_TEST_FILES" ] && printf '%s\n' "$P8_TEST_FILES" | xargs grep -lq -- "$atm" 2>/dev/null; then found="found"; fi
    printf "%-9s %-4s %-9s\n" "$atm" "$pri" "$found"
    if [ "$found" = "MISSING" ] && [ "$blocking" = "1" ]; then
      missing_blocking=$((missing_blocking + 1))
    fi
  done
}

check_group "$p1_ids" "P1" 1
check_group "$p2_ids" "P2" 1
check_group "$p3_ids" "P3" 0

echo ""
if [ "$missing_blocking" -gt 0 ]; then
  echo "[traceability-p8] CHECK 2 FAILED — $missing_blocking P1/P2 atomic(s) have NO test reference under tests/"
  overall_exit=1
else
  echo "[traceability-p8] CHECK 2 OK — every P1/P2 atomic is referenced by >=1 file under tests/ (P3 misses non-blocking)"
fi

echo ""
echo "=================================================================="
echo "[traceability-p8] CHECK 3 — REQ-001..020 rolls up to exactly ONE EPIC-01..07"
echo "=================================================================="

# Pre-split the EPICS section into per-EPIC bodies (EPIC-01..EPIC-07), each
# running from its own '### EPIC-0N' heading up to (but not including) the
# next '### EPIC-0' heading — epics_section (captured for CHECK 1 above)
# already stops at '## Done-gate', so EPIC-07's body naturally ends there.
epic_body_1="$(awk '/^### EPIC-01/{p=1; next} /^### EPIC-0/{if(p) exit} p' <<<"$epics_section")"
epic_body_2="$(awk '/^### EPIC-02/{p=1; next} /^### EPIC-0/{if(p) exit} p' <<<"$epics_section")"
epic_body_3="$(awk '/^### EPIC-03/{p=1; next} /^### EPIC-0/{if(p) exit} p' <<<"$epics_section")"
epic_body_4="$(awk '/^### EPIC-04/{p=1; next} /^### EPIC-0/{if(p) exit} p' <<<"$epics_section")"
epic_body_5="$(awk '/^### EPIC-05/{p=1; next} /^### EPIC-0/{if(p) exit} p' <<<"$epics_section")"
epic_body_6="$(awk '/^### EPIC-06/{p=1; next} /^### EPIC-0/{if(p) exit} p' <<<"$epics_section")"
epic_body_7="$(awk '/^### EPIC-07/{p=1; next} /^### EPIC-0/{if(p) exit} p' <<<"$epics_section")"

for e in 1 2 3 4 5 6 7; do
  var="epic_body_$e"
  if [ -z "${!var}" ]; then
    echo "[traceability-p8] FATAL: could not locate body for EPIC-0$e" >&2
    exit 1
  fi
done

# A REQ is considered to "belong" to an EPIC only where it is DEFINED — its
# own `- REQ-0XX [P#]` bullet under that EPIC's "Requirements (EARS):"
# section — NOT wherever its id is merely mentioned in prose. This matters
# because EPIC-03's Goal paragraph cross-references REQ-010 and REQ-016 by id
# ("the flag gate lives in the persist layer (REQ-010) and the flag-OFF
# parity requirement (REQ-016)") as forward-looking prose, while those
# requirements are actually DEFINED in EPIC-04 and EPIC-06 respectively. A
# naive substring-count over the whole EPIC body would double-count those
# ids and wrongly flag them as ">1 EPIC", even though the spec is correct.
# Anchoring on the defining bullet's exact format avoids that false positive.
req_orphans=0
printf "%-9s %-6s %s\n" "REQ-ID" "COUNT" "MATCHED-EPICS"
printf "%-9s %-6s %s\n" "------" "-----" "-------------"
for i in $(seq -w 1 20); do
  rid="REQ-0$i"
  count=0
  matched=""
  for e in 1 2 3 4 5 6 7; do
    var="epic_body_$e"
    if grep -qE -- "^- ${rid} \[P" <<<"${!var}"; then
      count=$((count + 1))
      matched="$matched EPIC-0$e"
    fi
  done
  printf "%-9s %-6s %s\n" "$rid" "$count" "${matched:- (none)}"
  if [ "$count" -ne 1 ]; then
    req_orphans=$((req_orphans + 1))
  fi
done

echo ""
if [ "$req_orphans" -gt 0 ]; then
  echo "[traceability-p8] CHECK 3 FAILED — $req_orphans REQ id(s) roll up to zero or more-than-one EPIC"
  overall_exit=1
else
  echo "[traceability-p8] CHECK 3 OK — all REQ-001..020 roll up to exactly one EPIC-01..07, zero orphans"
fi

echo ""
echo "=================================================================="
echo "[traceability-p8] CHECK 4 — ATM-001..030 each carry a valid trailing M-### cell"
echo "=================================================================="

# Every ATM table row is a pipe-delimited markdown row whose LAST populated
# column (before the trailing empty field created by the row's closing '|')
# is the M-### traceability cell (verified structurally: every ATM row in
# this spec splits into exactly 8 '|'-delimited fields). A row may carry
# MULTIPLE M ids in that cell (e.g. "M-002, M-003, M-004") — any one valid
# id satisfies "carries a trailing M-### cell", per the fold instructions.
atm_bad=0
printf "%-9s %-30s %-9s\n" "ATM" "M-CELL" "STATUS"
printf "%-9s %-30s %-9s\n" "---" "------" "------"
for i in $(seq 1 30); do
  n="$(printf '%03d' "$i")"
  atm="ATM-$n"
  row="$(grep -E -- "^\| ${atm} \|" "$SPEC" || true)"
  if [ -z "$row" ]; then
    printf "%-9s %-30s %-9s\n" "$atm" "(no row)" "MISSING"
    atm_bad=$((atm_bad + 1))
    continue
  fi
  m_cell="$(awk -F'|' '{ gsub(/^[ \t]+|[ \t]+$/, "", $(NF-1)); print $(NF-1) }' <<<"$row")"
  m_ids="$(grep -oE 'M-0[0-9]{2}' <<<"$m_cell" || true)"
  if [ -z "$m_ids" ]; then
    printf "%-9s %-30s %-9s\n" "$atm" "$m_cell" "NO-M-ID"
    atm_bad=$((atm_bad + 1))
    continue
  fi
  row_bad=0
  for mid in $m_ids; do
    num="${mid#M-}"
    num=$((10#$num))
    if [ "$num" -lt 1 ] || [ "$num" -gt 18 ]; then
      row_bad=1
    fi
  done
  if [ "$row_bad" -eq 1 ]; then
    printf "%-9s %-30s %-9s\n" "$atm" "$m_cell" "INVALID"
    atm_bad=$((atm_bad + 1))
  else
    printf "%-9s %-30s %-9s\n" "$atm" "$m_cell" "OK"
  fi
done

echo ""
if [ "$atm_bad" -gt 0 ]; then
  echo "[traceability-p8] CHECK 4 FAILED — $atm_bad ATM row(s) missing a valid trailing M-### cell"
  overall_exit=1
else
  echo "[traceability-p8] CHECK 4 OK — every ATM-001..030 carries a valid trailing M-### cell (M-001..M-018)"
fi

echo ""
echo "=================================================================="
if [ "$overall_exit" -eq 0 ]; then
  echo "[traceability-p8] ALL CHECKS PASSED — exit 0"
else
  echo "[traceability-p8] ONE OR MORE CHECKS FAILED — exit 1"
fi
echo "=================================================================="
exit "$overall_exit"
