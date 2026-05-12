#!/usr/bin/env bash
# sprint-chain-driver.sh — Auto-chain Generator-Verifier harness sprints.
#
# Polls ${HARNESS_ROOT}/.harness/sprints/sprint-*/status.txt. When a sprint's
# status reads "passed" and no sentinel exists, fires the next sprint's prompt
# into the target tmux session via send-keys, then writes a sentinel so the
# same transition never re-fires.
#
# Designed to be run by launchd (com.threadwork.sprint-chain-driver) on a
# StartInterval of 120s. Idempotent — sentinel files in $LOG_DIR guarantee
# at-most-once chaining per sprint. Mkdir-lock prevents concurrent ticks from
# double-firing if a tick runs long.
#
# Mirrors subagent-stall-watcher.sh conventions (logging, atomicity, env-var
# config). Authorized via task #853, research #835/#837.
set -euo pipefail
IFS=$'\n\t'

# --- config ---------------------------------------------------------------
HARNESS_ROOT="${HARNESS_ROOT:-}"
TARGET_TMUX_SESSION="${TARGET_TMUX_SESSION:-claude-steve}"
LOG_DIR="${LOG_DIR:-$HOME/.claude/state/sprint-chain-driver}"
LOCK_DIR="${LOCK_DIR:-${LOG_DIR}/lock}"

mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/driver.log"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"
}

# No-op if HARNESS_ROOT not configured (placeholder still in plist).
if [ -z "$HARNESS_ROOT" ] || [ "$HARNESS_ROOT" = "__SET_THIS_BEFORE_LOADING__" ]; then
  log "no-op: HARNESS_ROOT unset or placeholder"
  exit 0
fi

# Atomic mkdir-lock — second concurrent tick exits cleanly.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "no-op: lock held at $LOCK_DIR"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

SPRINTS_DIR="${HARNESS_ROOT}/.harness/sprints"
if [ ! -d "$SPRINTS_DIR" ]; then
  log "no-op: sprints dir missing at $SPRINTS_DIR"
  exit 0
fi

shopt -s nullglob
fired=0
for status_file in "$SPRINTS_DIR"/sprint-*/status.txt; do
  sprint_dir=$(dirname "$status_file")
  sprint_name=$(basename "$sprint_dir")          # e.g. sprint-2
  n="${sprint_name#sprint-}"
  [[ "$n" =~ ^[0-9]+$ ]] || { log "skip: non-numeric sprint name $sprint_name"; continue; }

  status=$(tr -d '[:space:]' < "$status_file" 2>/dev/null || true)
  [ "$status" = "passed" ] || continue

  sentinel="${LOG_DIR}/fired-sprint-${n}"
  [ -e "$sentinel" ] && continue

  next_n=$((n + 1))
  next_dir="${SPRINTS_DIR}/sprint-${next_n}"
  next_prompt="${next_dir}/prompt.txt"            # convention: prompt.txt

  if [ ! -d "$next_dir" ]; then
    log "skip sprint-${n}->${next_n}: next sprint dir missing ($next_dir)"
    continue
  fi
  if [ ! -f "$next_prompt" ]; then
    log "skip sprint-${n}->${next_n}: next prompt missing ($next_prompt)"
    continue
  fi

  prompt_body=$(cat "$next_prompt")
  # Write sentinel BEFORE firing so a crash mid-send doesn't double-fire.
  printf '%s status=%s fired_for=sprint-%d->sprint-%d\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$status" "$n" "$next_n" > "$sentinel"

  tmux send-keys -t "$TARGET_TMUX_SESSION" "$prompt_body" Enter
  log "fired sprint-${n}->sprint-${next_n} into tmux:${TARGET_TMUX_SESSION} (prompt=${next_prompt})"
  fired=$((fired + 1))
done

log "tick done: fired=${fired}"
exit 0
