#!/usr/bin/env bash
# typecheck-p8.sh — P8 ternary-reward typecheck gate (G1).
#
# Runs `tsc -p tsconfig.p8.json` (noEmit, strict) over the P8 file set: the new
# module (verification/ternary-reward.ts), the P7/P6 modules it consumes
# read-only (verification/cross-family-critique.ts,
# verification/failure-classification.ts), decision.ts (read-only
# CritiqueSeverity reference for ATM-004's distinctness guardrail), db.ts (new
# table + flag seed), server.ts (the additively-wired finalize_decision hook),
# and the new P8 test files. A P8 change that breaks a type on any of these
# fails this gate before it fails downstream. Mirrors typecheck-p7.sh.
#
# DELTA ALLOW-LIST (parallel to G3's BASELINE-FAILURES.md): `server.ts` carries
# PRE-EXISTING latent tsc errors at pristine fceeaf2 (P8 module was an empty
# stub when captured; see build-p8/TSC-BASELINE.md). They are NOT P8's and
# cannot be fixed without editing non-P8 server.ts lines (violates the
# additive/byte-parity discipline). The gate ALLOWS exactly the baseline
# signatures (col-agnostic) and FAILS on anything else — keeping server.ts
# fully in the typecheck program so P8's additive call-site edit IS covered.
#
# BASELINE-SWAP GUARD (mirrors typecheck-p7.sh's guards): the count +
# signature checks alone are "swappable" (a P8 edit that deletes one pristine
# baseline error line while adding a new same-signature error elsewhere could
# net the same count). Pinning the server.ts diff vs pristine fceeaf2 to be
# PURELY ADDITIVE (zero deleted lines) + scanning added lines for new
# ts-suppression directives closes that gap structurally.
#
# Self-provisioning: node_modules here is a symlink to the live repo and does
# NOT materialize bun-types/@types/node as real dirs, so tsc needs an explicit
# typeRoots (./.typeroots), regenerated from the local bun cache on every run.
#
# Usage: ./scripts/typecheck-p8.sh
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
    echo "[typecheck-p8] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

BASELINE_COMMIT="fceeaf2"
EXPECT_BASELINE=3
# The pristine server.ts baseline error signatures, col-agnostic (line/col
# stripped). Sorted for a deterministic multiset compare.
read -r -d '' BASELINE_SIGS <<'EOF'
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2353: Object literal may only specify known properties, and 'addendum' does not exist in type '{ taskId?: number | undefined; tool?: string | undefined; pid?: number | undefined; }'.
EOF

# --- server.ts additive-only guard (no deleted lines vs pristine) ---
echo "[typecheck-p8] server.ts baseline-swap guard: additive-diff check vs $BASELINE_COMMIT"
SERVER_ADDITIVE_FAIL=0
if ! SRV_NUMSTAT="$(git -C "$REPO_DIR" diff --numstat "$BASELINE_COMMIT" -- server.ts 2>/dev/null)"; then
  echo "[typecheck-p8] WARN: git unavailable — cannot verify server.ts is additive-only vs $BASELINE_COMMIT; NOT counted as a pass." >&2
else
  if [ -z "$SRV_NUMSTAT" ]; then
    echo "[typecheck-p8] server.ts diff vs $BASELINE_COMMIT: +0 -0 (no change yet)"
  else
    SRV_DEL="$(awk '{print $2; exit}' <<<"$SRV_NUMSTAT")"
    SRV_INS="$(awk '{print $1; exit}' <<<"$SRV_NUMSTAT")"
    echo "[typecheck-p8] server.ts diff vs $BASELINE_COMMIT: +$SRV_INS -$SRV_DEL"
    if [ "$SRV_DEL" != "0" ]; then
      echo "[typecheck-p8] FAIL: server.ts diff vs $BASELINE_COMMIT has $SRV_DEL deleted line(s) — a non-additive edit" >&2
      echo "[typecheck-p8]   invalidates the pinned baseline (a pristine error line could be swapped for a" >&2
      echo "[typecheck-p8]   same-signature error elsewhere while the count stays the same)." >&2
      SERVER_ADDITIVE_FAIL=1
    fi
  fi
fi

# --- server.ts no-new-ts-suppression guard ---
echo "[typecheck-p8] server.ts suppression-swap guard: no new ts-suppression directive vs $BASELINE_COMMIT"
SERVER_SUPPRESSION_FAIL=0
if ! SRV_DIFF_RAW="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- server.ts 2>/dev/null)"; then
  echo "[typecheck-p8] WARN: git unavailable — cannot verify server.ts adds no ts-suppression directive; NOT counted as a pass." >&2
else
  SRV_ADDED="$(printf '%s\n' "$SRV_DIFF_RAW" | grep '^+' | grep -v '^+++' || true)"
  SUPPRESSION_HITS="$(printf '%s\n' "$SRV_ADDED" | grep -E '@ts-ignore|@ts-expect-error|@ts-nocheck' || true)"
  if [ -n "$SUPPRESSION_HITS" ]; then
    echo "[typecheck-p8] FAIL: server.ts diff vs $BASELINE_COMMIT adds a TypeScript suppression directive —" >&2
    echo "[typecheck-p8]   could hide a new error under the pinned baseline while the count stays at $EXPECT_BASELINE." >&2
    printf '%s\n' "$SUPPRESSION_HITS" >&2
    SERVER_SUPPRESSION_FAIL=1
  else
    echo "[typecheck-p8] OK — no added ts-suppression directive in server.ts diff vs $BASELINE_COMMIT"
  fi
fi

# --- run tsc, normalize error lines (strip (line,col)), compare to baseline multiset ---
echo "[typecheck-p8] bunx tsc -p tsconfig.p8.json"
TSC_OUT="$(bunx tsc -p tsconfig.p8.json 2>&1)"

# Primary error lines only (continuation lines lack 'error TS').
ERRLINES="$(printf '%s\n' "$TSC_OUT" | grep -E 'error TS[0-9]' || true)"
TOTAL_ERR="$(printf '%s\n' "$ERRLINES" | grep -cE 'error TS' || true)"
# Normalize: strip the (line,col) coordinate so an additive line-shift does not
# move a baseline signature out of the allow-list.
NORM_CUR="$(printf '%s\n' "$ERRLINES" | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sed '/^$/d' | sort)"
NORM_BASE="$(printf '%s\n' "$BASELINE_SIGS" | sed '/^$/d' | sort)"

echo "[typecheck-p8] total error-lines=$TOTAL_ERR  expected-baseline=$EXPECT_BASELINE"

FAIL=0
[ "$SERVER_ADDITIVE_FAIL" -ne 0 ] && FAIL=1
[ "$SERVER_SUPPRESSION_FAIL" -ne 0 ] && FAIL=1

# New = normalized current signatures not accounted for by the baseline multiset.
NEW_SIGS="$(comm -13 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"
MISSING_SIGS="$(comm -23 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"

if [ -n "$NEW_SIGS" ]; then
  echo "[typecheck-p8] FAIL: tsc error(s) beyond the documented pristine baseline:" >&2
  printf '%s\n' "$NEW_SIGS" >&2
  FAIL=1
fi
if [ -n "$MISSING_SIGS" ]; then
  # A missing baseline signature means a pristine error vanished — usually a
  # non-additive server.ts edit. Report (the additive guard above is the hard
  # catch; this is a corroborating signal).
  echo "[typecheck-p8] WARN: a pristine baseline error signature is no longer present (check server.ts additive-only):" >&2
  printf '%s\n' "$MISSING_SIGS" >&2
fi
if [ "$TOTAL_ERR" -ne "$EXPECT_BASELINE" ] && [ -z "$NEW_SIGS" ]; then
  echo "[typecheck-p8] NOTE: total error count $TOTAL_ERR != baseline $EXPECT_BASELINE but no NEW signatures — see MISSING above." >&2
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[typecheck-p8] GATE FAIL (exit 1)"
  exit 1
fi
echo "[typecheck-p8] OK — 0 errors beyond the $EXPECT_BASELINE pristine server.ts baseline (G1 PASS, exit 0)"
exit 0
