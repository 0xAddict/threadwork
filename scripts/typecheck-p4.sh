#!/usr/bin/env bash
# typecheck-p4.sh — P4 anti-laundering typecheck gate (#10376048, ATM-028).
#
# Runs `tsc -p tsconfig.p4.json` (noEmit) over the P4 signature-lock file set:
# memory-integrity.ts / memory-integrity-patterns.ts / the signature test, plus
# the future consumer set (memory.ts, decision.ts, debrief.ts, consolidate.ts
# and their test files) so a later stage that widens/narrows
# sanitizeMemoryContent's frozen two-argument signature fails this gate before
# it fails downstream in P5. Proven to catch a wrong-arity call (TS2554).
#
# Self-provisioning: node_modules here is a symlink to the live repo and does
# NOT materialize bun-types/@types/node as real dirs, so tsc needs an explicit
# typeRoots (./.typeroots). Those symlinks are machine-specific (git-excluded)
# and are regenerated from the local bun cache on every run, so the gate is
# reproducible on any machine that has bun installed.
#
# Usage: ./scripts/typecheck-p4.sh

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
    echo "[typecheck-p4] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

echo "[typecheck-p4] bunx tsc -p tsconfig.p4.json"
bunx tsc -p tsconfig.p4.json
echo "[typecheck-p4] OK — clean exit 0"
