#!/usr/bin/env bash
# typecheck-ko-t1.sh — KO-SWEEP T1 (generalized retention/prune) typecheck gate.
#
# Runs `tsc -p tsconfig.ko-t1.json` (noEmit, strict) over the T1 file set: db.ts
# (the new ternary_rewards_archive table + retention_prune_enabled flag seed, and
# — in later packets — the runHygiene() Step-6 extension), server.ts (the
# additively-wired run_hygiene output lines + audit.log call in PK-T1-5), and the
# new T1 test file(s). A T1 change that breaks a type on any of these fails this
# gate before it fails downstream. Mirrors scripts/typecheck-p8.sh.
#
# DELTA ALLOW-LIST (parallel to typecheck-p8.sh): `server.ts` carries PRE-EXISTING
# latent tsc errors at the T1 base commit 900750f — the SAME 3 signatures p8
# pinned. They are NOT T1's and cannot be fixed without editing non-T1 server.ts
# lines (violates the additive discipline / ATM-015 diff-scope). The gate ALLOWS
# exactly the baseline signatures (col-agnostic) and FAILS on anything else —
# keeping server.ts fully in the typecheck program so T1's additive run_hygiene
# edit IS covered.
#
# BASELINE-SWAP GUARD (mirrors typecheck-p8.sh): the count + signature checks
# alone are "swappable" (an edit that deletes one pristine baseline error line
# while adding a new same-signature error elsewhere could net the same count).
# Pinning the server.ts diff vs pristine 900750f to be PURELY ADDITIVE (zero
# deleted lines) + scanning added lines for new ts-suppression directives closes
# that gap structurally.
#
# Self-provisioning: this git worktree has NO node_modules, so tsc cannot resolve
# the runtime deps (fastembed via db.ts, @modelcontextprotocol/sdk via server.ts)
# on its own. We symlink the live repo's node_modules (discovered via
# git-common-dir) and regenerate ./.typeroots from the local bun cache on every
# run. Both are gitignored / cleaned on exit so the worktree stays pristine for
# commit (node_modules/ is in .gitignore; .typeroots is removed by the EXIT trap).
#
# Usage: ./scripts/typecheck-ko-t1.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# --- self-provision node_modules (symlink to the live repo) if absent ---
CLEAN_NM=0
if [ ! -e node_modules ]; then
  COMMON="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$COMMON" ]; then
    MAIN_ROOT="$(cd "$(dirname "$COMMON")" 2>/dev/null && pwd || true)"
    if [ -n "$MAIN_ROOT" ] && [ -d "$MAIN_ROOT/node_modules" ]; then
      ln -sfn "$MAIN_ROOT/node_modules" node_modules
      CLEAN_NM=1
    fi
  fi
  if [ ! -e node_modules ]; then
    echo "[typecheck-ko-t1] WARN: could not provision node_modules — tsc may report module-resolution errors" >&2
  fi
fi

provision_typeroots() {
  local cache="${BUN_INSTALL:-$HOME/.bun}/install/cache"
  mkdir -p .typeroots
  local bt node
  bt="$(ls -d "$cache"/bun-types@* 2>/dev/null | sort -V | tail -1 || true)"
  node="$(ls -d "$cache"/@types/node@* 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$bt" ]   && ln -sfn "$bt" .typeroots/bun-types
  [ -n "$node" ] && ln -sfn "$node" .typeroots/node
  if [ ! -e .typeroots/bun-types ] || [ ! -e .typeroots/node ]; then
    echo "[typecheck-ko-t1] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

# Keep the worktree pristine for commit: remove provisioned artifacts on exit.
# (.typeroots is NOT gitignored; the node_modules symlink is, but we only remove
# it when THIS script created it.)
cleanup() {
  rm -rf "$REPO_DIR/.typeroots"
  if [ "$CLEAN_NM" = "1" ] && [ -L "$REPO_DIR/node_modules" ]; then
    rm -f "$REPO_DIR/node_modules"
  fi
}
trap cleanup EXIT

BASELINE_COMMIT="900750f"
EXPECT_BASELINE=3
# The pristine server.ts baseline error signatures, col-agnostic (line/col
# stripped). Sorted for a deterministic multiset compare. Re-verified live at
# T1 base 900750f — identical to the p8 baseline.
read -r -d '' BASELINE_SIGS <<'EOF'
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server.ts: error TS2353: Object literal may only specify known properties, and 'addendum' does not exist in type '{ taskId?: number | undefined; tool?: string | undefined; pid?: number | undefined; }'.
EOF

# --- server.ts additive-only guard (no deleted lines vs pristine) ---
echo "[typecheck-ko-t1] server.ts baseline-swap guard: additive-diff check vs $BASELINE_COMMIT"
SERVER_ADDITIVE_FAIL=0
if ! SRV_NUMSTAT="$(git -C "$REPO_DIR" diff --numstat "$BASELINE_COMMIT" -- server.ts 2>/dev/null)"; then
  echo "[typecheck-ko-t1] WARN: git unavailable — cannot verify server.ts is additive-only vs $BASELINE_COMMIT; NOT counted as a pass." >&2
else
  if [ -z "$SRV_NUMSTAT" ]; then
    echo "[typecheck-ko-t1] server.ts diff vs $BASELINE_COMMIT: +0 -0 (no change yet)"
  else
    SRV_DEL="$(awk '{print $2; exit}' <<<"$SRV_NUMSTAT")"
    SRV_INS="$(awk '{print $1; exit}' <<<"$SRV_NUMSTAT")"
    echo "[typecheck-ko-t1] server.ts diff vs $BASELINE_COMMIT: +$SRV_INS -$SRV_DEL"
    if [ "$SRV_DEL" != "0" ]; then
      echo "[typecheck-ko-t1] FAIL: server.ts diff vs $BASELINE_COMMIT has $SRV_DEL deleted line(s) — a non-additive edit" >&2
      echo "[typecheck-ko-t1]   invalidates the pinned baseline (a pristine error line could be swapped for a" >&2
      echo "[typecheck-ko-t1]   same-signature error elsewhere while the count stays the same)." >&2
      SERVER_ADDITIVE_FAIL=1
    fi
  fi
fi

# --- server.ts no-new-ts-suppression guard ---
echo "[typecheck-ko-t1] server.ts suppression-swap guard: no new ts-suppression directive vs $BASELINE_COMMIT"
SERVER_SUPPRESSION_FAIL=0
if ! SRV_DIFF_RAW="$(git -C "$REPO_DIR" diff "$BASELINE_COMMIT" -- server.ts 2>/dev/null)"; then
  echo "[typecheck-ko-t1] WARN: git unavailable — cannot verify server.ts adds no ts-suppression directive; NOT counted as a pass." >&2
else
  SRV_ADDED="$(printf '%s\n' "$SRV_DIFF_RAW" | grep '^+' | grep -v '^+++' || true)"
  SUPPRESSION_HITS="$(printf '%s\n' "$SRV_ADDED" | grep -E '@ts-ignore|@ts-expect-error|@ts-nocheck' || true)"
  if [ -n "$SUPPRESSION_HITS" ]; then
    echo "[typecheck-ko-t1] FAIL: server.ts diff vs $BASELINE_COMMIT adds a TypeScript suppression directive —" >&2
    echo "[typecheck-ko-t1]   could hide a new error under the pinned baseline while the count stays at $EXPECT_BASELINE." >&2
    printf '%s\n' "$SUPPRESSION_HITS" >&2
    SERVER_SUPPRESSION_FAIL=1
  else
    echo "[typecheck-ko-t1] OK — no added ts-suppression directive in server.ts diff vs $BASELINE_COMMIT"
  fi
fi

# --- run tsc, normalize error lines (strip (line,col)), compare to baseline multiset ---
echo "[typecheck-ko-t1] bunx tsc -p tsconfig.ko-t1.json"
TSC_OUT="$(bunx tsc -p tsconfig.ko-t1.json 2>&1)"

# Primary error lines only (continuation lines lack 'error TS').
ERRLINES="$(printf '%s\n' "$TSC_OUT" | grep -E 'error TS[0-9]' || true)"
TOTAL_ERR="$(printf '%s\n' "$ERRLINES" | grep -cE 'error TS' || true)"
# Normalize: strip the (line,col) coordinate so an additive line-shift does not
# move a baseline signature out of the allow-list.
NORM_CUR="$(printf '%s\n' "$ERRLINES" | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sed '/^$/d' | sort)"
NORM_BASE="$(printf '%s\n' "$BASELINE_SIGS" | sed '/^$/d' | sort)"

echo "[typecheck-ko-t1] total error-lines=$TOTAL_ERR  expected-baseline=$EXPECT_BASELINE"

FAIL=0
[ "$SERVER_ADDITIVE_FAIL" -ne 0 ] && FAIL=1
[ "$SERVER_SUPPRESSION_FAIL" -ne 0 ] && FAIL=1

# New = normalized current signatures not accounted for by the baseline multiset.
NEW_SIGS="$(comm -13 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"
MISSING_SIGS="$(comm -23 <(printf '%s\n' "$NORM_BASE") <(printf '%s\n' "$NORM_CUR") || true)"

if [ -n "$NEW_SIGS" ]; then
  echo "[typecheck-ko-t1] FAIL: tsc error(s) beyond the documented pristine baseline:" >&2
  printf '%s\n' "$NEW_SIGS" >&2
  FAIL=1
fi
if [ -n "$MISSING_SIGS" ]; then
  # A missing baseline signature means a pristine error vanished — usually a
  # non-additive server.ts edit. Report (the additive guard above is the hard
  # catch; this is a corroborating signal).
  echo "[typecheck-ko-t1] WARN: a pristine baseline error signature is no longer present (check server.ts additive-only):" >&2
  printf '%s\n' "$MISSING_SIGS" >&2
fi
if [ "$TOTAL_ERR" -ne "$EXPECT_BASELINE" ] && [ -z "$NEW_SIGS" ]; then
  echo "[typecheck-ko-t1] NOTE: total error count $TOTAL_ERR != baseline $EXPECT_BASELINE but no NEW signatures — see MISSING above." >&2
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[typecheck-ko-t1] GATE FAIL (exit 1)"
  exit 1
fi
echo "[typecheck-ko-t1] OK — 0 errors beyond the $EXPECT_BASELINE pristine server.ts baseline (T1 typecheck PASS, exit 0)"
exit 0
