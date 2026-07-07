#!/usr/bin/env bash
# typecheck-p6.sh — P6 typed-failure-classification typecheck gate (G1).
#
# Runs `tsc -p tsconfig.p6.json` (noEmit, strict) over the P6 file set: the new
# module (verification/failure-classification.ts), the additively-touched live
# files (verification/verify.ts, watchdog.ts, src/escalation-bridge/index.ts,
# db.ts), decision.ts (read-only CritiqueSeverity import for ATM-004's
# distinctness guardrail), and the new P6 test files. A P6 change that breaks a
# type on any of these fails this gate before it fails downstream. Mirrors
# typecheck-p5.sh.
#
# DELTA ALLOW-LIST (parallel to G3's BASELINE-FAILURES.md): `watchdog.ts`
# carries 8 PRE-EXISTING latent `TS2345: 'string | null' -> 'string'` errors at
# pristine 5014d7f (never strict-typechecked before; `task.to_agent` nullability;
# see build-p6/TSC-BASELINE.md). They are NOT P6's and cannot be fixed without
# editing non-P6 watchdog.ts lines (violates ATM-015 byte-parity). So the gate
# ALLOWS exactly those 8 baseline-signature errors and FAILS on anything else —
# keeping watchdog.ts fully in the typecheck program so P6's additive call-site
# edits ARE covered.
#
# Self-provisioning: node_modules here is a symlink to the live repo and does
# NOT materialize bun-types/@types/node as real dirs, so tsc needs an explicit
# typeRoots (./.typeroots). Those symlinks are machine-specific (git-excluded)
# and are regenerated from the local bun cache on every run.
#
# Usage: ./scripts/typecheck-p6.sh
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
    echo "[typecheck-p6] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

# Frozen pristine baseline: exactly this many watchdog.ts TS2345 string|null errors.
EXPECT_BASELINE=8
# Regex matching ONLY the pre-existing watchdog baseline signature (any line/col).
BASELINE_RE="^watchdog\.ts\([0-9]+,[0-9]+\): error TS2345: Argument of type 'string \| null' is not assignable to parameter of type 'string'\.\$"

echo "[typecheck-p6] bunx tsc -p tsconfig.p6.json"
TSC_OUT="$(bunx tsc -p tsconfig.p6.json 2>&1)"

# Count all primary error lines and the allowed baseline errors.
TOTAL_ERR=$(printf '%s\n' "$TSC_OUT" | grep -cE "error TS" || true)
BASELINE_ERR=$(printf '%s\n' "$TSC_OUT" | grep -cE "$BASELINE_RE" || true)
# Non-baseline = every error TS line that is NOT a baseline-signature line.
NONBASELINE=$(printf '%s\n' "$TSC_OUT" | grep -E "error TS" | grep -vE "$BASELINE_RE" || true)
NONBASELINE_CNT=$(printf '%s\n' "$NONBASELINE" | grep -cE "error TS" || true)

echo "[typecheck-p6] total error-lines=$TOTAL_ERR  allowed-baseline=$BASELINE_ERR/$EXPECT_BASELINE  non-baseline=$NONBASELINE_CNT"

FAIL=0
if [ "$BASELINE_ERR" -ne "$EXPECT_BASELINE" ]; then
  echo "[typecheck-p6] FAIL: watchdog.ts baseline error count = $BASELINE_ERR, expected $EXPECT_BASELINE." >&2
  echo "[typecheck-p6]   A change to watchdog.ts added or removed a 'string|null' error vs pristine 5014d7f." >&2
  echo "[typecheck-p6]   Review: P6 edits must be additive only (ATM-015). See build-p6/TSC-BASELINE.md." >&2
  FAIL=1
fi
if [ "$NONBASELINE_CNT" -gt 0 ]; then
  echo "[typecheck-p6] FAIL: $NONBASELINE_CNT tsc error(s) beyond the documented pristine baseline:" >&2
  printf '%s\n' "$NONBASELINE" | grep -E "error TS" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[typecheck-p6] GATE FAIL (exit 1)"
  exit 1
fi
echo "[typecheck-p6] OK — 0 errors beyond the $EXPECT_BASELINE pristine watchdog baseline (G1 PASS, exit 0)"
exit 0
