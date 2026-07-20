#!/usr/bin/env bash
# typecheck-pf1.sh — PF1 outcome-feedback-loop typecheck gate (PK-PF1-0..5,
# ~/.claude/state/pf-build/PHASE1-PLAN.md section (b)/(d)).
#
# Runs `tsc -p tsconfig.pf1.json` (noEmit, strict) over the PF1 file set: the
# EPIC-PF1 module (reflection/outcome-feedback.ts) plus its three live
# touchpoints named in PF-spec.md's EPIC-PF1 "Integration hooks" — db.ts
# (migrate(): +2 tables/+1 flag, PK-PF1-1), server.ts (claim_task/delegate_task
# pre-act hook, PK-PF1-4), debrief.ts (post-summarise reflect() call,
# PK-PF1-4) — plus PF1 test files as they land. Included from PK-PF1-0 onward
# (not widened packet-by-packet, unlike typecheck-ko-t4.sh's precedent) so this
# gate catches any regression PF1 introduces into its host files from the very
# first packet, matching the plan's gate-matrix requirement that ko-t3/ko-t4
# "stay green" across PK-PF1-4's live wiring. Mirrors typecheck-ko-t3.sh's
# structure (including its baseline-pin discipline below) and
# typecheck-ko-t4.sh's clean-file inclusion (db.ts, debrief.ts: 0 pre-existing
# errors, verified at the PF1 branch-point sha 039e017).
#
# BASELINE (inherited, not PF1's): server.ts carries 3 PRE-EXISTING latent tsc
# errors, identical in signature to the ones typecheck-ko-t3.sh pins against
# commit 88bcbf5 (verified at the PF1 branch-point sha 039e017: two
# `TS2345 'string | null'` + one `TS2353 'addendum'`, at current line numbers
# 983/985/1546 — a +3 shift from ko-t3's pinned 980/982/1543, consistent with
# additive-only drift in server.ts since 88bcbf5). PF1-0 does not touch
# server.ts at all, so this gate's job in this packet is solely to prove tsc
# ran and produced exactly the inherited baseline, no more, no less. The same
# BASELINE-SWAP GUARD as typecheck-ko-t3.sh (content-match protection of the
# pristine baseline-error lines, in-place edits elsewhere permitted) and
# SUPPRESSION-SWAP GUARD (no new @ts-ignore/@ts-expect-error/@ts-nocheck in the
# server.ts diff vs 88bcbf5) apply here too, since PK-PF1-4 will make a real,
# in-place, additive edit to server.ts's claim_task/delegate_task handlers.
#
# Self-provisioning: node_modules here is a symlink to the live repo (set up
# once per worktree, matching the sibling P4-P8/T-sweep build worktrees) and
# does NOT materialize bun-types/@types/node as real dirs, so tsc needs an
# explicit typeRoots (./.typeroots), regenerated from the local bun cache on
# every run.
#
# Usage: ./scripts/typecheck-pf1.sh
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
    echo "[typecheck-pf1] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

BASELINE_COMMIT="88bcbf5"
EXPECT_BASELINE=3
# The pristine server.ts baseline error signatures, col-agnostic (line/col
# stripped). Identical multiset to typecheck-ko-t3.sh's — same 3 inherited
# errors, sorted for a deterministic multiset compare.
read -r -d '' BASELINE_SIGS <<'EOF'
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2353: Object literal may only specify known properties, and 'addendum' does not exist in type '{ taskId?: number | undefined; tool?: string | undefined; pid?: number | undefined; }'.
EOF

# --- server.ts baseline-error-line protection guard (content-match vs pristine) ---
echo "[typecheck-pf1] server.ts baseline-swap guard: baseline-error-line content-match vs $BASELINE_COMMIT"
SERVER_ADDITIVE_FAIL=0
BASELINE_ERR_LINES="980 982 1543"
if ! SRV_PRISTINE="$(git -C "$REPO_DIR" show "$BASELINE_COMMIT":server.ts 2>/dev/null)"; then
  echo "[typecheck-pf1] WARN: git unavailable — cannot read pristine server.ts to protect the baseline; NOT counted as a pass." >&2
else
  SRV_DELETED="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- server.ts 2>/dev/null | grep '^-' | grep -v '^---' | sed 's/^-//')"
  for LN in $BASELINE_ERR_LINES; do
    BASE_LINE="$(printf '%s\n' "$SRV_PRISTINE" | sed -n "${LN}p")"
    if [ -n "$BASE_LINE" ] && printf '%s\n' "$SRV_DELETED" | grep -Fxq -- "$BASE_LINE"; then
      echo "[typecheck-pf1] FAIL: pristine baseline-error line ($BASELINE_COMMIT server.ts:$LN) was deleted/modified —" >&2
      echo "[typecheck-pf1]   invalidates the pinned tsc baseline (swap risk: a pristine error line removed while a" >&2
      echo "[typecheck-pf1]   same-signature error is added elsewhere). Offending pristine content:" >&2
      echo "[typecheck-pf1]     $BASE_LINE" >&2
      SERVER_ADDITIVE_FAIL=1
    fi
  done
  [ "$SERVER_ADDITIVE_FAIL" = "0" ] && echo "[typecheck-pf1] OK — no pristine baseline-error line (L980/L982/L1543) deleted; benign in-place edits permitted."
fi

# --- server.ts no-new-ts-suppression guard ---
echo "[typecheck-pf1] server.ts suppression-swap guard: no new ts-suppression directive vs $BASELINE_COMMIT"
SERVER_SUPPRESSION_FAIL=0
if ! SRV_DIFF_RAW="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- server.ts 2>/dev/null)"; then
  echo "[typecheck-pf1] WARN: git unavailable — cannot verify server.ts adds no ts-suppression directive; NOT counted as a pass." >&2
else
  SRV_ADDED="$(printf '%s\n' "$SRV_DIFF_RAW" | grep '^+' | grep -v '^+++' || true)"
  SUPPRESSION_HITS="$(printf '%s\n' "$SRV_ADDED" | grep -E '@ts-ignore|@ts-expect-error|@ts-nocheck' || true)"
  if [ -n "$SUPPRESSION_HITS" ]; then
    echo "[typecheck-pf1] FAIL: server.ts diff vs $BASELINE_COMMIT adds a TypeScript suppression directive —" >&2
    echo "[typecheck-pf1]   could hide a new error under the pinned baseline while the count stays at $EXPECT_BASELINE." >&2
    printf '%s\n' "$SUPPRESSION_HITS" >&2
    SERVER_SUPPRESSION_FAIL=1
  else
    echo "[typecheck-pf1] OK — no added ts-suppression directive in server.ts diff vs $BASELINE_COMMIT"
  fi
fi

# --- run tsc, normalize error lines (strip (line,col)), compare to baseline multiset ---
echo "[typecheck-pf1] bunx tsc -p tsconfig.pf1.json"
TSC_OUT="$(bunx tsc -p tsconfig.pf1.json 2>&1)"; TSC_EXIT=$?

# Primary error lines only (continuation lines lack 'error TS').
ERRLINES="$(printf '%s\n' "$TSC_OUT" | grep -E 'error TS[0-9]' || true)"
TOTAL_ERR="$(printf '%s\n' "$ERRLINES" | grep -cE 'error TS' || true)"
# Normalize: strip the (line,col) coordinate so an additive line-shift does not
# move a baseline signature out of the allow-list.
NORM_CUR="$(printf '%s\n' "$ERRLINES" | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sed '/^$/d' | sort)"
NORM_BASE="$(printf '%s\n' "$BASELINE_SIGS" | sed '/^$/d' | sort)"

echo "[typecheck-pf1] total error-lines=$TOTAL_ERR  expected-baseline=$EXPECT_BASELINE"

FAIL=0
[ "$SERVER_ADDITIVE_FAIL" -ne 0 ] && FAIL=1
[ "$SERVER_SUPPRESSION_FAIL" -ne 0 ] && FAIL=1

# tsc-execution proof (WHITELIST, fail-closed), same discipline as
# typecheck-ko-t3.sh: a HEALTHY run emits diagnostics and exits 1
# (DiagnosticsPresent/--noEmit) or 2 (OutputsGenerated). Anything else means
# tsc did NOT run as a typechecker: exit 0 = clean (the 3 pinned baseline
# errors vanished), 3-125 = no legitimate meaning here, >=126 = launch/
# not-found/crash. Fail closed.
echo "[typecheck-pf1] tsc exit=$TSC_EXIT (execution-proof whitelist: {1,2})"
case "$TSC_EXIT" in
  1|2) : ;;  # ran with diagnostics — the signature checks below validate them
  *)
    echo "[typecheck-pf1] FAIL: tsc exit $TSC_EXIT outside the {1,2} ran-with-diagnostics whitelist —" >&2
    echo "[typecheck-pf1]   0=clean(baseline vanished) / 3-125=undefined(fail-closed) / >=126=launch-or-crash." >&2
    FAIL=1
    ;;
esac

# New = normalized current signatures not accounted for by the baseline multiset.
NEW_SIGS="$(comm -13 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"
MISSING_SIGS="$(comm -23 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"

if [ -n "$NEW_SIGS" ]; then
  echo "[typecheck-pf1] FAIL: tsc error(s) beyond the documented pristine baseline (PF1 must not add typecheck regressions):" >&2
  printf '%s\n' "$NEW_SIGS" >&2
  FAIL=1
fi
if [ -n "$MISSING_SIGS" ]; then
  # Nothing in PF1 may legitimately remove a pinned baseline error without
  # touching server.ts — ANY vanished baseline signature at this packet
  # (PK-PF1-0, zero server.ts edits) means tsc did not run over the expected
  # surface (the silent-tsc false-pass this guard closes).
  echo "[typecheck-pf1] FAIL: a pristine baseline error signature is no longer present —" >&2
  echo "[typecheck-pf1]   tsc did not run as a typechecker over the expected surface (silent-false-pass guard). Missing:" >&2
  printf '%s\n' "$MISSING_SIGS" >&2
  FAIL=1
fi
if [ "$TOTAL_ERR" -ne "$EXPECT_BASELINE" ] && [ -z "$NEW_SIGS" ]; then
  echo "[typecheck-pf1] NOTE: total error count $TOTAL_ERR != baseline $EXPECT_BASELINE but no NEW signatures — see MISSING above." >&2
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[typecheck-pf1] GATE FAIL (exit 1)"
  exit 1
fi
echo "[typecheck-pf1] OK — 0 errors beyond the $EXPECT_BASELINE pristine (inherited, not PF1's) baseline; reflection/outcome-feedback.ts stub typechecks clean (G-PF1 PASS, exit 0)"
exit 0
