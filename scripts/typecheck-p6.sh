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
# BASELINE-SWAP GUARD (Codex round-3 fold, Finding 5 / P3): the count==8 +
# zero-non-baseline checks below are, on their own, "swappable" — a P6 edit
# that DELETES one pristine baseline error line (e.g. by touching a
# pre-existing non-P6 line the count check never inspects individually) while
# ADDING a new non-baseline-signature error elsewhere would still read
# BASELINE_ERR=8 and NONBASELINE_CNT could still land at 0 if the new error
# happens to share the exact baseline regex signature — count and signature
# alone can't tell "the same 8 pristine lines, untouched" apart from "a
# different 8 lines that happen to match the same regex". Pinning the
# watchdog.ts diff vs pristine 5014d7f to be PURELY ADDITIVE (zero deleted
# lines) closes that gap structurally: no pristine line can be modified or
# removed, so the 8 baseline errors are provably the SAME 8, not a swap.
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
BASELINE_COMMIT="5014d7f"

# Returns via echo: "<insertions> <deletions>" from `git diff --numstat` for
# watchdog.ts vs $BASELINE_COMMIT, or a sentinel "GIT_UNAVAILABLE" on any git
# failure (missing binary, not a repo, bad ref, etc.) so the caller can
# distinguish "confirmed zero deletions" from "could not confirm".
watchdog_diff_numstat() {
  local out
  if ! out="$(git -C "$REPO_DIR" diff --numstat "$BASELINE_COMMIT" -- watchdog.ts 2>/dev/null)"; then
    echo "GIT_UNAVAILABLE"
    return
  fi
  if [ -z "$out" ]; then
    # No diff at all vs base for this path — trivially additive (0/0).
    echo "0 0"
    return
  fi
  # numstat format: "<ins>\t<del>\t<path>" — take the first matching line.
  awk '{print $1, $2; exit}' <<<"$out"
}

echo "[typecheck-p6] watchdog.ts baseline-swap guard: additive-diff check vs $BASELINE_COMMIT"
WATCHDOG_ADDITIVE_FAIL=0
WATCHDOG_NUMSTAT="$(watchdog_diff_numstat)"
if [ "$WATCHDOG_NUMSTAT" = "GIT_UNAVAILABLE" ]; then
  # Per the fold instructions: if git is unavailable, warn but do not
  # silently pass the additive check — this is printed loudly as a WARN
  # (not folded into a quiet "OK"), and is NOT counted as a hard gate
  # failure on its own (an environment without git is an infra issue this
  # P3 guard should not be solely responsible for blocking on), mirroring
  # the existing provision_typeroots WARN-without-fail convention above.
  echo "[typecheck-p6] WARN: git unavailable — cannot verify watchdog.ts is additive-only vs $BASELINE_COMMIT; NOT counted as a pass." >&2
else
  WD_INS="$(awk '{print $1}' <<<"$WATCHDOG_NUMSTAT")"
  WD_DEL="$(awk '{print $2}' <<<"$WATCHDOG_NUMSTAT")"
  echo "[typecheck-p6] watchdog.ts diff vs $BASELINE_COMMIT: +$WD_INS -$WD_DEL"
  if [ "$WD_DEL" != "0" ]; then
    echo "[typecheck-p6] FAIL: watchdog.ts diff vs $BASELINE_COMMIT contains $WD_DEL deleted line(s) — a non-additive" >&2
    echo "[typecheck-p6]   edit invalidates the pinned 8-error baseline (a pristine baseline error line could have been" >&2
    echo "[typecheck-p6]   swapped for a different same-signature error elsewhere while the count stayed at 8)." >&2
    WATCHDOG_ADDITIVE_FAIL=1
  fi
fi
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
if [ "$WATCHDOG_ADDITIVE_FAIL" -ne 0 ]; then
  FAIL=1
fi
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
