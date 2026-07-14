#!/usr/bin/env bash
# typecheck-ko-t3.sh — T3 model-family-attribution typecheck gate (G1).
#
# Runs `tsc -p tsconfig.ko-t3.json` (noEmit, strict) over the T3 file set: the
# EPIC-01 module (verification/agent-family-registry.ts), the P7 module it and
# server.ts consume read-only (verification/cross-family-critique.ts), the P6
# module that module transitively pulls in (verification/failure-classification.ts),
# decision.ts (CritiqueSeverity reference), db.ts (new flag + tables), server.ts
# (the additively-wired critique_position EPIC-02 injection), and the T3 test
# files. A T3 change that breaks a type on any of these fails this gate before it
# fails downstream. Mirrors typecheck-p8.sh, re-baselined onto the T3 branch base
# 900750f.
#
# DELTA ALLOW-LIST (parallel to the no-regression suite gate): `server.ts` carries
# 3 PRE-EXISTING latent tsc errors at pristine 900750f (verified: two
# `TS2345 'string | null'` + one `TS2353 'addendum'`). They are NOT T3's and
# cannot be fixed without editing non-T3 server.ts lines (violates the
# additive/byte-parity discipline). The gate ALLOWS exactly the baseline
# signatures (col-agnostic) and FAILS on anything else — keeping server.ts fully
# in the typecheck program so T3's additive call-site edit IS covered.
#
# BASELINE-SWAP GUARD (mirrors typecheck-p8.sh's guards): the count + signature
# checks alone are "swappable" (a T3 edit that deletes one pristine baseline error
# line while adding a new same-signature error elsewhere could net the same
# count). Pinning the server.ts diff vs pristine 900750f to be PURELY ADDITIVE
# (zero deleted lines) + scanning added lines for new ts-suppression directives
# closes that gap structurally.
#
# Self-provisioning: node_modules here is a symlink to the live repo and does NOT
# materialize bun-types/@types/node as real dirs, so tsc needs an explicit
# typeRoots (./.typeroots), regenerated from the local bun cache on every run.
#
# Usage: ./scripts/typecheck-ko-t3.sh
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
    echo "[typecheck-ko-t3] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

BASELINE_COMMIT="900750f"
EXPECT_BASELINE=3
# The pristine server.ts baseline error signatures, col-agnostic (line/col
# stripped). Sorted for a deterministic multiset compare.
read -r -d '' BASELINE_SIGS <<'EOF'
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2353: Object literal may only specify known properties, and 'addendum' does not exist in type '{ taskId?: number | undefined; tool?: string | undefined; pid?: number | undefined; }'.
EOF

# --- server.ts baseline-error-line protection guard (content-match vs pristine) ---
# Boss ruling (guard-conflict, PK-T3-3): the prior "zero deleted lines" rule wrongly
# rejected EPIC-02's REQUIRED in-place call-site edit (threading the registry 2nd arg
# into the two resolveAgentDefaultFamily calls is an inherent -2/+2). Replaced with a
# CONTENT-MATCH on the 3 pristine baseline-error lines (900750f server.ts
# L980/L982/L1543). The guard trips ONLY if one of those exact line contents is among
# the deleted lines — the real baseline-swap risk (dropping a pristine error line while
# a same-signature error is added elsewhere keeps count+signatures identical) — while
# permitting benign in-place edits anywhere else.
echo "[typecheck-ko-t3] server.ts baseline-swap guard: baseline-error-line content-match vs $BASELINE_COMMIT"
SERVER_ADDITIVE_FAIL=0
BASELINE_ERR_LINES="980 982 1543"
if ! SRV_PRISTINE="$(git -C "$REPO_DIR" show "$BASELINE_COMMIT":server.ts 2>/dev/null)"; then
  echo "[typecheck-ko-t3] WARN: git unavailable — cannot read pristine server.ts to protect the baseline; NOT counted as a pass." >&2
else
  SRV_DELETED="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- server.ts 2>/dev/null | grep '^-' | grep -v '^---' | sed 's/^-//')"
  for LN in $BASELINE_ERR_LINES; do
    BASE_LINE="$(printf '%s\n' "$SRV_PRISTINE" | sed -n "${LN}p")"
    if [ -n "$BASE_LINE" ] && printf '%s\n' "$SRV_DELETED" | grep -Fxq -- "$BASE_LINE"; then
      echo "[typecheck-ko-t3] FAIL: pristine baseline-error line (900750f server.ts:$LN) was deleted/modified —" >&2
      echo "[typecheck-ko-t3]   invalidates the pinned tsc baseline (swap risk: a pristine error line removed while a" >&2
      echo "[typecheck-ko-t3]   same-signature error is added elsewhere). Offending pristine content:" >&2
      echo "[typecheck-ko-t3]     $BASE_LINE" >&2
      SERVER_ADDITIVE_FAIL=1
    fi
  done
  [ "$SERVER_ADDITIVE_FAIL" = "0" ] && echo "[typecheck-ko-t3] OK — no pristine baseline-error line (L980/L982/L1543) deleted; benign in-place edits permitted."
fi

# --- server.ts no-new-ts-suppression guard ---
echo "[typecheck-ko-t3] server.ts suppression-swap guard: no new ts-suppression directive vs $BASELINE_COMMIT"
SERVER_SUPPRESSION_FAIL=0
if ! SRV_DIFF_RAW="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- server.ts 2>/dev/null)"; then
  echo "[typecheck-ko-t3] WARN: git unavailable — cannot verify server.ts adds no ts-suppression directive; NOT counted as a pass." >&2
else
  SRV_ADDED="$(printf '%s\n' "$SRV_DIFF_RAW" | grep '^+' | grep -v '^+++' || true)"
  SUPPRESSION_HITS="$(printf '%s\n' "$SRV_ADDED" | grep -E '@ts-ignore|@ts-expect-error|@ts-nocheck' || true)"
  if [ -n "$SUPPRESSION_HITS" ]; then
    echo "[typecheck-ko-t3] FAIL: server.ts diff vs $BASELINE_COMMIT adds a TypeScript suppression directive —" >&2
    echo "[typecheck-ko-t3]   could hide a new error under the pinned baseline while the count stays at $EXPECT_BASELINE." >&2
    printf '%s\n' "$SUPPRESSION_HITS" >&2
    SERVER_SUPPRESSION_FAIL=1
  else
    echo "[typecheck-ko-t3] OK — no added ts-suppression directive in server.ts diff vs $BASELINE_COMMIT"
  fi
fi

# --- run tsc, normalize error lines (strip (line,col)), compare to baseline multiset ---
echo "[typecheck-ko-t3] bunx tsc -p tsconfig.ko-t3.json"
TSC_OUT="$(bunx tsc -p tsconfig.ko-t3.json 2>&1)"

# Primary error lines only (continuation lines lack 'error TS').
ERRLINES="$(printf '%s\n' "$TSC_OUT" | grep -E 'error TS[0-9]' || true)"
TOTAL_ERR="$(printf '%s\n' "$ERRLINES" | grep -cE 'error TS' || true)"
# Normalize: strip the (line,col) coordinate so an additive line-shift does not
# move a baseline signature out of the allow-list.
NORM_CUR="$(printf '%s\n' "$ERRLINES" | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sed '/^$/d' | sort)"
NORM_BASE="$(printf '%s\n' "$BASELINE_SIGS" | sed '/^$/d' | sort)"

echo "[typecheck-ko-t3] total error-lines=$TOTAL_ERR  expected-baseline=$EXPECT_BASELINE"

FAIL=0
[ "$SERVER_ADDITIVE_FAIL" -ne 0 ] && FAIL=1
[ "$SERVER_SUPPRESSION_FAIL" -ne 0 ] && FAIL=1

# New = normalized current signatures not accounted for by the baseline multiset.
NEW_SIGS="$(comm -13 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"
MISSING_SIGS="$(comm -23 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"

if [ -n "$NEW_SIGS" ]; then
  echo "[typecheck-ko-t3] FAIL: tsc error(s) beyond the documented pristine baseline:" >&2
  printf '%s\n' "$NEW_SIGS" >&2
  FAIL=1
fi
if [ -n "$MISSING_SIGS" ]; then
  # A missing baseline signature means a pristine error vanished — usually a
  # non-additive server.ts edit. Report (the additive guard above is the hard
  # catch; this is a corroborating signal).
  echo "[typecheck-ko-t3] WARN: a pristine baseline error signature is no longer present (check server.ts additive-only):" >&2
  printf '%s\n' "$MISSING_SIGS" >&2
fi
if [ "$TOTAL_ERR" -ne "$EXPECT_BASELINE" ] && [ -z "$NEW_SIGS" ]; then
  echo "[typecheck-ko-t3] NOTE: total error count $TOTAL_ERR != baseline $EXPECT_BASELINE but no NEW signatures — see MISSING above." >&2
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[typecheck-ko-t3] GATE FAIL (exit 1)"
  exit 1
fi
echo "[typecheck-ko-t3] OK — 0 errors beyond the $EXPECT_BASELINE pristine server.ts baseline (G1 PASS, exit 0)"
exit 0
