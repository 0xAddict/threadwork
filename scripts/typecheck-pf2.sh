#!/usr/bin/env bash
# typecheck-pf2.sh — PF2 declarative-watchers typecheck gate (PK-PF2-0..6,
# ~/.claude/state/pf-build/PHASE1-PLAN.md section (b)/(d)).
#
# Runs `tsc -p tsconfig.pf2.json` (noEmit, strict) over the PF2 file set: the
# EPIC-PF2 module (watchers/declarative-watchers.ts) plus its live touchpoints
# named in PF-spec.md's EPIC-PF2 "Integration hooks" — db.ts (migrate(): +2
# tables/+1 flag, PK-PF2-1), server.ts (+3 additive tool `case` handlers,
# PK-PF2-5), watchdog.ts (WatchdogClass.run() main tick loop, additive
# fault-isolated evaluateWatchers() step, PK-PF2-5) — plus PF2 test files as
# they land. Included from PK-PF2-0 onward (not widened packet-by-packet),
# matching typecheck-pf1.sh's precedent, so this gate catches any regression
# PF2 introduces into its host files from the very first packet.
#
# BASELINE (inherited, not PF2's; freshly pinned at this packet since this is
# the first PF2-scoped joint typecheck of {server.ts, watchdog.ts, db.ts}):
# server.ts carries the SAME 3 pre-existing latent tsc errors typecheck-ko-t3.sh
# / typecheck-pf1.sh pin (two `TS2345 'string | null'` + one `TS2353
# 'addendum'`), now at lines 1020/1022/1583 (a further additive shift from
# PF1's pinned 983/985/1546, consistent with ordinary drift). watchdog.ts —
# never before covered by a PF-family gate — carries 8 of its OWN pre-existing
# latent errors (all `TS2345 'string | null' not assignable to 'string'`,
# same root pattern as server.ts's: an agent-id/task-field typed `string |
# null` passed where a bare `string` is expected), at lines 147/487/492/584/
# 680/707/761/801. All 11 are confirmed pre-existing at this packet's branch
# point (`git diff 253f25b -- server.ts watchdog.ts db.ts` is empty — PK-PF2-0
# makes zero edits to any of the three), so BASELINE_COMMIT below pins to the
# PF2 branch-point sha itself (253f25b) rather than reusing ko-t3's older
# 88bcbf5 pin — there is no earlier PF-family gate that already covered
# watchdog.ts to inherit a pin from. db.ts contributes zero errors (matches
# typecheck-ko-t4.sh's finding that db.ts is clean).
#
# Same BASELINE-SWAP GUARD (content-match protection of the pristine
# baseline-error lines, in-place edits elsewhere permitted) and
# SUPPRESSION-SWAP GUARD (no new @ts-ignore/@ts-expect-error/@ts-nocheck in
# the server.ts OR watchdog.ts diff vs 253f25b) as typecheck-ko-t3.sh /
# typecheck-pf1.sh, applied to BOTH files, since PK-PF2-5 will make a real,
# in-place, additive edit to both server.ts (3 new tool cases) and
# watchdog.ts (run() loop).
#
# Self-provisioning: node_modules here is a symlink to the live repo (set up
# once per worktree, matching every sibling PF1/P4-P8/T-sweep build worktree)
# and does NOT materialize bun-types/@types/node as real dirs, so tsc needs an
# explicit typeRoots (./.typeroots), regenerated from the local bun cache on
# every run.
#
# Usage: ./scripts/typecheck-pf2.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

provision_typeroots() {
  local cache="${BUN_INSTALL:-$HOME/.bun}/install/cache"
  mkdir -p .typeroots
  local bt node
  bt="$(ls -d "$cache"/bun-types@* 2>/dev/null | sort -V | tail -1 || true)"
  node="$(ls -d "$cache"/@types/node@* 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$bt" ]   && ln -sfn "$bt" .typeroots/bun-types
  [ -n "$node" ] && ln -sfn "$node" .typeroots/node
  if [ ! -e .typeroots/bun-types ] || [ ! -e .typeroots/node ]; then
    echo "[typecheck-pf2] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

BASELINE_COMMIT="253f25b"
EXPECT_BASELINE=11
# Pristine {server.ts, watchdog.ts} baseline error signatures, col-agnostic
# (line/col stripped). 3 from server.ts (identical multiset to
# typecheck-ko-t3.sh's / typecheck-pf1.sh's inherited pin) + 8 from
# watchdog.ts (freshly pinned by this gate — see header). Sorted for a
# deterministic multiset compare.
read -r -d '' BASELINE_SIGS <<'EOF'
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2353: Object literal may only specify known properties, and 'addendum' does not exist in type '{ taskId?: number | undefined; tool?: string | undefined; pid?: number | undefined; }'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
watchdog.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
EOF

# --- baseline-error-line protection guard (content-match vs pristine), both files ---
echo "[typecheck-pf2] server.ts + watchdog.ts baseline-swap guard: baseline-error-line content-match vs $BASELINE_COMMIT"
BASELINE_FAIL=0
check_baseline_file() {
  local FILE="$1"; shift
  local LINES="$*"
  local PRISTINE DELETED
  if ! PRISTINE="$(git -C "$REPO_DIR" show "$BASELINE_COMMIT":"$FILE" 2>/dev/null)"; then
    echo "[typecheck-pf2] WARN: git unavailable — cannot read pristine $FILE to protect the baseline; NOT counted as a pass." >&2
    return
  fi
  DELETED="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- "$FILE" 2>/dev/null | grep '^-' | grep -v '^---' | sed 's/^-//')"
  local LN BASE_LINE
  for LN in $LINES; do
    BASE_LINE="$(printf '%s\n' "$PRISTINE" | sed -n "${LN}p")"
    if [ -n "$BASE_LINE" ] && printf '%s\n' "$DELETED" | grep -Fxq -- "$BASE_LINE"; then
      echo "[typecheck-pf2] FAIL: pristine baseline-error line ($BASELINE_COMMIT $FILE:$LN) was deleted/modified —" >&2
      echo "[typecheck-pf2]   invalidates the pinned tsc baseline (swap risk: a pristine error line removed while a" >&2
      echo "[typecheck-pf2]   same-signature error is added elsewhere). Offending pristine content:" >&2
      echo "[typecheck-pf2]     $BASE_LINE" >&2
      BASELINE_FAIL=1
    fi
  done
}
check_baseline_file "server.ts" 1020 1022 1583
check_baseline_file "watchdog.ts" 147 487 492 584 680 707 761 801
[ "$BASELINE_FAIL" = "0" ] && echo "[typecheck-pf2] OK — no pristine baseline-error line deleted in server.ts or watchdog.ts; benign in-place edits permitted."

# --- no-new-ts-suppression guard, both files ---
echo "[typecheck-pf2] server.ts + watchdog.ts suppression-swap guard: no new ts-suppression directive vs $BASELINE_COMMIT"
SUPPRESSION_FAIL=0
check_suppression() {
  local FILE="$1"
  local DIFF_RAW ADDED HITS
  if ! DIFF_RAW="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- "$FILE" 2>/dev/null)"; then
    echo "[typecheck-pf2] WARN: git unavailable — cannot verify $FILE adds no ts-suppression directive; NOT counted as a pass." >&2
    return
  fi
  ADDED="$(printf '%s\n' "$DIFF_RAW" | grep '^+' | grep -v '^+++' || true)"
  HITS="$(printf '%s\n' "$ADDED" | grep -E '@ts-ignore|@ts-expect-error|@ts-nocheck' || true)"
  if [ -n "$HITS" ]; then
    echo "[typecheck-pf2] FAIL: $FILE diff vs $BASELINE_COMMIT adds a TypeScript suppression directive —" >&2
    echo "[typecheck-pf2]   could hide a new error under the pinned baseline while the count stays at $EXPECT_BASELINE." >&2
    printf '%s\n' "$HITS" >&2
    SUPPRESSION_FAIL=1
  else
    echo "[typecheck-pf2] OK — no added ts-suppression directive in $FILE diff vs $BASELINE_COMMIT"
  fi
}
check_suppression "server.ts"
check_suppression "watchdog.ts"

# --- run tsc, normalize error lines (strip (line,col)), compare to baseline multiset ---
echo "[typecheck-pf2] bunx tsc -p tsconfig.pf2.json"
TSC_OUT="$(bunx tsc -p tsconfig.pf2.json 2>&1)"; TSC_EXIT=$?

# Primary error lines only (continuation lines lack 'error TS').
ERRLINES="$(printf '%s\n' "$TSC_OUT" | grep -E 'error TS[0-9]' || true)"
TOTAL_ERR="$(printf '%s\n' "$ERRLINES" | grep -cE 'error TS' || true)"
# Normalize: strip the (line,col) coordinate so an additive line-shift does not
# move a baseline signature out of the allow-list.
NORM_CUR="$(printf '%s\n' "$ERRLINES" | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sed '/^$/d' | sort)"
NORM_BASE="$(printf '%s\n' "$BASELINE_SIGS" | sed '/^$/d' | sort)"

echo "[typecheck-pf2] total error-lines=$TOTAL_ERR  expected-baseline=$EXPECT_BASELINE"

FAIL=0
[ "$BASELINE_FAIL" -ne 0 ] && FAIL=1
[ "$SUPPRESSION_FAIL" -ne 0 ] && FAIL=1

# tsc-execution proof (WHITELIST, fail-closed), same discipline as
# typecheck-ko-t3.sh / typecheck-pf1.sh: a HEALTHY run emits diagnostics and
# exits 1 (DiagnosticsPresent/--noEmit) or 2 (OutputsGenerated). Anything else
# means tsc did NOT run as a typechecker: exit 0 = clean (the 11 pinned
# baseline errors vanished), 3-125 = no legitimate meaning here, >=126 =
# launch/not-found/crash. Fail closed.
echo "[typecheck-pf2] tsc exit=$TSC_EXIT (execution-proof whitelist: {1,2})"
case "$TSC_EXIT" in
  1|2) : ;;  # ran with diagnostics — the signature checks below validate them
  *)
    echo "[typecheck-pf2] FAIL: tsc exit $TSC_EXIT outside the {1,2} ran-with-diagnostics whitelist —" >&2
    echo "[typecheck-pf2]   0=clean(baseline vanished) / 3-125=undefined(fail-closed) / >=126=launch-or-crash." >&2
    FAIL=1
    ;;
esac

# New = normalized current signatures not accounted for by the baseline multiset.
NEW_SIGS="$(comm -13 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"
MISSING_SIGS="$(comm -23 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"

if [ -n "$NEW_SIGS" ]; then
  echo "[typecheck-pf2] FAIL: tsc error(s) beyond the documented pristine baseline (PF2 must not add typecheck regressions):" >&2
  printf '%s\n' "$NEW_SIGS" >&2
  FAIL=1
fi
if [ -n "$MISSING_SIGS" ]; then
  # Nothing in PF2 may legitimately remove a pinned baseline error without
  # touching server.ts/watchdog.ts — ANY vanished baseline signature at this
  # packet (PK-PF2-0, zero server.ts/watchdog.ts edits) means tsc did not run
  # over the expected surface (the silent-tsc false-pass this guard closes).
  echo "[typecheck-pf2] FAIL: a pristine baseline error signature is no longer present —" >&2
  echo "[typecheck-pf2]   tsc did not run as a typechecker over the expected surface (silent-false-pass guard). Missing:" >&2
  printf '%s\n' "$MISSING_SIGS" >&2
  FAIL=1
fi
if [ "$TOTAL_ERR" -ne "$EXPECT_BASELINE" ] && [ -z "$NEW_SIGS" ]; then
  echo "[typecheck-pf2] NOTE: total error count $TOTAL_ERR != baseline $EXPECT_BASELINE but no NEW signatures — see MISSING above." >&2
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[typecheck-pf2] GATE FAIL (exit 1)"
  exit 1
fi
echo "[typecheck-pf2] OK — 0 errors beyond the $EXPECT_BASELINE pristine (inherited, freshly pinned at $BASELINE_COMMIT) baseline; watchers/declarative-watchers.ts stub typechecks clean (G-PF2 PASS, exit 0)"
exit 0
