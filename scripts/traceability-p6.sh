#!/usr/bin/env bash
# traceability-p6.sh — P6 Stage 8 traceability / ATOM-coverage gate (G6).
#
# Two independent checks, both driven by grepping the actual spec/test text
# (not hardcoded ID lists), so this re-confirms the already-lock-verified spec
# rather than restating it. Mirrors scripts/traceability-p5.sh.
#
#   1. Manifest check: every M-001..M-017 in the spec's "## Traceability
#      manifest" table is (a) present in that table, and (b) referenced by >=1
#      REQ in the "## EPICS" section. Reports any orphan.
#   2. Atomic-coverage check: every ATM id listed in the Done-gate's P1/P2/P3
#      atomics enumeration (ATM-001..032) is referenced by >=1 file under
#      tests/ (proving the atomic has an implemented verifier). Exits non-zero
#      if any P1 or P2 atomic has NO test reference (P3 atomics may be
#      legitimately descoped per the spec's Done-gate item 3, so a missing P3
#      reference is reported but does not fail the gate).
#
# Usage: bash ./scripts/traceability-p6.sh   (run from the P6 worktree)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SPEC="/Users/coachstokes/.claude/state/p4-p8-fanout/specs/P6-spec.md"
TESTS_DIR="$REPO_DIR/tests"

overall_exit=0

if [ ! -f "$SPEC" ]; then
  echo "[traceability-p6] FATAL: spec not found at $SPEC" >&2
  exit 1
fi
if [ ! -d "$TESTS_DIR" ]; then
  echo "[traceability-p6] FATAL: tests/ dir not found at $TESTS_DIR" >&2
  exit 1
fi

echo "=================================================================="
echo "[traceability-p6] CHECK 1 — M-001..M-017 manifest + REQ-reference"
echo "=================================================================="

manifest_section="$(awk '/^## Traceability manifest/{p=1; next} /^## /{if (p) exit} p' "$SPEC")"
epics_section="$(awk '/^## EPICS/{p=1; next} /^## Done-gate/{if (p) exit} p' "$SPEC")"

if [ -z "$manifest_section" ]; then
  echo "[traceability-p6] FATAL: could not locate '## Traceability manifest' section" >&2
  exit 1
fi
if [ -z "$epics_section" ]; then
  echo "[traceability-p6] FATAL: could not locate '## EPICS' section" >&2
  exit 1
fi

manifest_orphans=0
printf "%-8s %-12s %-16s\n" "M-ID" "IN-MANIFEST" "REFD-BY-REQ"
printf "%-8s %-12s %-16s\n" "----" "-----------" "-----------"
for i in $(seq -w 1 17); do
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
  echo "[traceability-p6] CHECK 1 FAILED — $manifest_orphans orphan M-### id(s)"
  overall_exit=1
else
  echo "[traceability-p6] CHECK 1 OK — all M-001..M-017 present in manifest and referenced by >=1 REQ, zero orphans"
fi

echo ""
echo "=================================================================="
echo "[traceability-p6] CHECK 2 — Done-gate P1/P2/P3 atomics -> test coverage"
echo "=================================================================="

donegate_section="$(awk '/^## Done-gate/{p=1; next} /^## /{if (p) exit} p' "$SPEC")"
if [ -z "$donegate_section" ]; then
  echo "[traceability-p6] FATAL: could not locate '## Done-gate' section" >&2
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
  echo "[traceability-p6] FATAL: parser self-check failed — spec states $p1_stated P1 atomics but parsed $p1_count" >&2
  exit 1
fi
if [ -n "$p2_stated" ] && [ "$p2_count" != "$p2_stated" ]; then
  echo "[traceability-p6] FATAL: parser self-check failed — spec states $p2_stated P2 atomics but parsed $p2_count" >&2
  exit 1
fi
if [ -n "$p3_stated" ] && [ "$p3_count" != "$p3_stated" ]; then
  echo "[traceability-p6] FATAL: parser self-check failed — spec states $p3_stated P3 atomics but parsed $p3_count" >&2
  exit 1
fi
if [ -z "$p1_ids" ] || [ -z "$p2_ids" ] || [ -z "$p3_ids" ]; then
  echo "[traceability-p6] FATAL: failed to parse one or more of the P1/P2/P3 atomic lists" >&2
  exit 1
fi

missing_blocking=0
printf "%-9s %-4s %-9s\n" "ATM" "PRI" "STATUS"
printf "%-9s %-4s %-9s\n" "---" "---" "------"

check_group() {
  local ids="$1"; local pri="$2"; local blocking="$3"
  local n atm found
  for n in $ids; do
    atm="ATM-$n"
    found="MISSING"
    if grep -rlq -- "$atm" "$TESTS_DIR" 2>/dev/null; then found="found"; fi
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
  echo "[traceability-p6] CHECK 2 FAILED — $missing_blocking P1/P2 atomic(s) have NO test reference under tests/"
  overall_exit=1
else
  echo "[traceability-p6] CHECK 2 OK — every P1/P2 atomic is referenced by >=1 file under tests/ (P3 misses non-blocking)"
fi

echo ""
echo "=================================================================="
if [ "$overall_exit" -eq 0 ]; then
  echo "[traceability-p6] ALL CHECKS PASSED — exit 0"
else
  echo "[traceability-p6] ONE OR MORE CHECKS FAILED — exit 1"
fi
echo "=================================================================="
exit "$overall_exit"
