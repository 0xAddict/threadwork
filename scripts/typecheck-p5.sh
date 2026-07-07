#!/usr/bin/env bash
# typecheck-p5.sh — P5 write-ordering + directed-messaging typecheck gate.
#
# Runs `tsc -p tsconfig.p5.json` (noEmit) over the P5 file set: the three new
# modules (memory-ordering.ts, agent-messages.ts, agent-message-types.ts), the
# touched write-path files (memory.ts, db.ts, config.ts, nudge.ts), and the P4
# signature-lock files (memory-integrity*.ts) so a P5 change that drifts a
# frozen signature — e.g. P4's sanitizeMemoryContent(content,{sourceType}) two-arg
# lock, or P5's own withMemoryWriteTxn / nextWriteSeq / sendDirectedMessage
# signatures — fails this gate before it fails downstream. Mirrors typecheck-p4.sh.
#
# Self-provisioning: node_modules here is a symlink to the live repo and does
# NOT materialize bun-types/@types/node as real dirs, so tsc needs an explicit
# typeRoots (./.typeroots). Those symlinks are machine-specific (git-excluded)
# and are regenerated from the local bun cache on every run.
#
# Usage: ./scripts/typecheck-p5.sh

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
    echo "[typecheck-p5] WARN: could not resolve bun-types/@types/node in $cache — tsc may fail" >&2
  fi
}
provision_typeroots

echo "[typecheck-p5] bunx tsc -p tsconfig.p5.json"
bunx tsc -p tsconfig.p5.json
echo "[typecheck-p5] OK — clean exit 0"
