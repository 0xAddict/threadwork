#!/usr/bin/env bash
# typecheck-ko-t4.sh — T4 reward-consumer typecheck gate (KO-sweep P8-KO-2,
# card #10376182; PK-T4-1 = ATM-006/ATM-022).
#
# Runs `tsc -p tsconfig.ko-t4.json` (noEmit, strict) over the T4-touched file
# set. In PK-T4-1 that set is db.ts (the reward_consumption_cursor DDL/seed +
# reward_consumer_enabled flag) plus its db.test.ts coverage; later T4 packets
# widen tsconfig.ko-t4.json's `include` to add verification/reward-consumer.ts
# and tests/reward-consumer.test.ts as those land. A T4 change that breaks a
# type on any covered file fails this gate before it fails downstream.
#
# Mirrors typecheck-p4.sh (the clean "expect exit 0" gate): the T4 include set
# pulls in NO baseline-error file (db.ts's transitive imports are ./config +
# ./delegation-brief + bun:sqlite only — server.ts is never reached), so unlike
# typecheck-p8.sh there is no pristine-baseline allow-list to tolerate. Any tsc
# error here is a real regression.
#
# Self-provisioning: node_modules here is a symlink to the live repo and does
# NOT materialize bun-types/@types/node as real dirs, so tsc needs an explicit
# typeRoots (./.typeroots). Those symlinks are machine-specific (git-excluded)
# and are regenerated from the local bun cache on every run, so the gate is
# reproducible on any machine that has bun installed.
#
# Usage: ./scripts/typecheck-ko-t4.sh

set -euo pipefail

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
    echo "[typecheck-ko-t4] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

echo "[typecheck-ko-t4] bunx tsc -p tsconfig.ko-t4.json"
bunx tsc -p tsconfig.ko-t4.json
echo "[typecheck-ko-t4] OK — clean exit 0"
