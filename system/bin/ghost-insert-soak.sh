#!/usr/bin/env bash
#
# ghost-insert-soak.sh — READ-ONLY soak-test observability harness.
#
# PURPOSE: Detect & attribute "ghost" text inserts that appear in threadwork
# agent tmux INPUT BUFFERS but sit UN-SENT. We OBSERVE and ATTRIBUTE — we do
# NOT block, modify, or touch the inserts (operator considers them a feature).
#
# STRICTLY READ-ONLY: the ONLY tmux verb used is `capture-pane` (read). This
# script MUST NEVER run `tmux send-keys`, never modify any pane, never submit
# anything. Pure observation.
#
# On each candidate insert event it appends a record to events.log with the
# ISO-8601 timestamp, agent, full inserted buffer text, and a CORRELATION
# SNAPSHOT: the last ~5 lines (within +/-45s of the event) of each daemon log
# we can find — so whatever daemon ticked in the window is the prime suspect.

set -u

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
AGENTS=(boss steve sadie kiera snoopy)
POLL_INTERVAL=12          # seconds between sweeps
CORR_WINDOW=45            # +/- seconds for log correlation
CORR_TAIL_LINES=5         # last N matching lines per log

STATE_DIR="$HOME/.claude/state/ghost-soak"
SNAP_DIR="$STATE_DIR/snapshots"
EVENTS_LOG="$STATE_DIR/events.log"

# Candidate daemon logs to correlate against. Missing ones are skipped.
CORR_LOGS=(
  "$HOME/.threadwork/logs/heartbeat-v2.err.log"
  "$HOME/.threadwork/logs/heartbeat-v2.out.log"
  "$HOME/bin/heartbeat.log"
  "$HOME/.claude/state/telegram-watchdog/watchdog.log"
  "$HOME/.claude/mcp-servers/task-board/watchdog.log"
)
# Glob-expanded sets (handled separately so missing globs don't break things):
#   - any heartbeat-v2*.log under ~/.threadwork/logs
#   - any watchdog.log under ~/.claude, board-watcher, task-board
#   - context-budget dispatch-*.log

mkdir -p "$STATE_DIR" "$SNAP_DIR"
touch "$EVENTS_LOG" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Extract the INPUT-BUFFER text from a captured pane.
#
# Layout (from the bottom of the pane):
#   ──────────────  <- top separator of the prompt box
#   ❯ <typed text>  <- one or more lines of input buffer
#   ──────────────  <- bottom separator
#     ⏵⏵ bypass permissions ...   <- status line
#
# We isolate the LAST such box: the lines between the last two ─── separator
# rows. Then we strip the leading "❯ " marker and join multi-line input.
extract_input_buffer() {
  awk '
    # A separator row is a line consisting (almost) entirely of box-drawing
    # horizontal chars. Track the byte offsets of the two most recent ones.
    {
      lines[NR] = $0
      # Detect a separator: line is mostly ─ (U+2500). Heuristic: contains a
      # run of the char and little else.
      stripped = $0
      gsub(/─/, "", stripped)
      gsub(/[[:space:]]/, "", stripped)
      if ($0 ~ /─────/ && length(stripped) == 0) {
        sep[++sepcount] = NR
      }
    }
    END {
      if (sepcount < 2) { exit 0 }
      top = sep[sepcount-1]
      bot = sep[sepcount]
      buf = ""
      for (i = top+1; i < bot; i++) {
        buf = buf lines[i] "\n"
      }
      printf "%s", buf
    }
  ' <<< "$1"
}

# Normalize a raw input-buffer block into the comparable inserted text.
# - strips the "❯" prompt marker
# - trims surrounding whitespace
# - returns empty for known UI placeholders that are NOT real inserts
normalize_buffer() {
  local raw="$1"
  # Remove the prompt marker (with or without following space) at line starts.
  local txt
  txt="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]*❯[[:space:]]?//')"
  # Collapse leading/trailing blank lines and whitespace.
  txt="$(printf '%s' "$txt" | sed -E 's/[[:space:]]+$//' | sed -E '/^[[:space:]]*$/d')"
  # Trim leading/trailing whitespace overall.
  txt="$(printf '%s' "$txt" | awk '{$1=$1; print}' | paste -sd' ' -)"

  case "$txt" in
    "" ) printf '' ;;
    # Known Claude Code UI placeholders — not real ghost inserts.
    "Press up to edit queued messages" ) printf '' ;;
    "Try \"how do I"* ) printf '' ;;
    "paste again to expand" ) printf '' ;;
    * ) printf '%s' "$txt" ;;
  esac
}

# Build the full ordered, de-duplicated list of correlation logs (resolving
# globs at call time so newly created logs are picked up).
resolve_corr_logs() {
  local -a out=()
  local f
  for f in "${CORR_LOGS[@]}"; do
    [ -f "$f" ] && out+=("$f")
  done
  # heartbeat-v2*.log
  for f in "$HOME"/.threadwork/logs/heartbeat-v2*.log; do
    [ -f "$f" ] && out+=("$f")
  done
  # watchdog.log anywhere under the usual roots
  while IFS= read -r f; do
    [ -f "$f" ] && out+=("$f")
  done < <(find "$HOME/.claude" "$HOME/threadwork-dashboard/board-watcher" \
                 "$HOME/.claude/mcp-servers/task-board" \
                 -name 'watchdog*.log' 2>/dev/null)
  # context-budget dispatch logs
  for f in "$HOME"/.claude/state/context-budget/dispatch-*.log; do
    [ -f "$f" ] && out+=("$f")
  done
  # De-dupe preserving order.
  printf '%s\n' "${out[@]}" | awk '!seen[$0]++'
}

# Parse the leading timestamp of a log line into a Unix epoch (seconds).
# Handles:
#   [2026-06-15 15:35:56]      (local time, space sep)
#   2026-06-15T13:36:44Z       (UTC ISO)
#   [2026-06-15T13:38:44.954Z] (UTC ISO bracketed, fractional)
#   [2026-06-15T13:35:43Z]     (UTC ISO bracketed)
# Prints epoch on success, nothing on failure.
line_epoch() {
  local line="$1" ts
  # Grab the first bracketed-or-bare timestamp token.
  ts="$(printf '%s' "$line" \
        | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z?' \
        | head -1)"
  [ -z "$ts" ] && return 0

  if [[ "$ts" == *Z ]]; then
    # UTC. Strip fractional seconds and the Z, parse as UTC.
    local clean="${ts%Z}"
    clean="${clean%%.*}"
    clean="${clean/T/ }"
    date -u -j -f "%Y-%m-%d %H:%M:%S" "$clean" "+%s" 2>/dev/null
  else
    # Naive local timestamp (space or T separator).
    local clean="${ts%%.*}"
    clean="${clean/T/ }"
    date -j -f "%Y-%m-%d %H:%M:%S" "$clean" "+%s" 2>/dev/null
  fi
}

# Emit up to CORR_TAIL_LINES log lines whose timestamp is within +/-CORR_WINDOW
# of the event epoch. Scans the tail of the file (last 400 lines) for speed.
correlate_log() {
  local file="$1" event_epoch="$2"
  # Stream-based (no array indexing — bash 3.2 + set -u safe). Collect matching
  # lines to a temp, then emit the last CORR_TAIL_LINES of them.
  local tmp count line ep diff
  tmp="$(mktemp "${TMPDIR:-/tmp}/ghost-corr.XXXXXX")" || { printf '    (mktemp failed)\n'; return; }
  while IFS= read -r line; do
    ep="$(line_epoch "$line")"
    [ -z "$ep" ] && continue
    diff=$(( ep - event_epoch ))
    [ "$diff" -lt 0 ] && diff=$(( -diff ))
    if [ "$diff" -le "$CORR_WINDOW" ]; then
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < <(tail -n 400 "$file" 2>/dev/null)

  count="$(wc -l < "$tmp" | tr -d ' ')"
  if [ "${count:-0}" -eq 0 ]; then
    printf '    (no lines within +/-%ss)\n' "$CORR_WINDOW"
  else
    tail -n "$CORR_TAIL_LINES" "$tmp" | sed 's/^/    /'
  fi
  rm -f "$tmp"
}

# Record a candidate insert event with full correlation snapshot.
log_event() {
  local agent="$1" buffer="$2"
  local iso epoch
  iso="$(date "+%Y-%m-%dT%H:%M:%S%z")"
  epoch="$(date "+%s")"

  {
    printf '========================================================================\n'
    printf 'GHOST INSERT EVENT\n'
    printf 'timestamp: %s\n' "$iso"
    printf 'agent:     %s\n' "$agent"
    printf 'inserted_buffer:\n'
    printf '%s\n' "$buffer" | sed 's/^/    | /'
    printf 'correlation_snapshot (logs ticking within +/-%ss):\n' "$CORR_WINDOW"
    local f
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      printf '  --- %s ---\n' "$f"
      correlate_log "$f" "$epoch"
    done < <(resolve_corr_logs)
    printf '========================================================================\n'
  } >> "$EVENTS_LOG"
}

# ---------------------------------------------------------------------------
# Main soak loop
# ---------------------------------------------------------------------------
printf '[%s] ghost-insert-soak starting (READ-ONLY). interval=%ss window=+/-%ss agents=%s\n' \
  "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$POLL_INTERVAL" "$CORR_WINDOW" "${AGENTS[*]}"

while true; do
  for agent in "${AGENTS[@]}"; do
    session="claude-$agent"

    # Skip if the session doesn't exist (read-only existence check).
    tmux has-session -t "$session" 2>/dev/null || continue

    # READ-ONLY capture. This is the ONLY tmux verb used anywhere.
    capture="$(tmux capture-pane -t "$session" -p 2>/dev/null)"
    [ -z "$capture" ] && continue

    # Skip while the agent is actively generating — buffer churn there isn't a
    # ghost insert (and we want to avoid false positives mid-stream).
    if printf '%s' "$capture" | grep -q "esc to interrupt"; then
      continue
    fi

    raw_buf="$(extract_input_buffer "$capture")"
    cur="$(normalize_buffer "$raw_buf")"

    snap_file="$SNAP_DIR/$agent.txt"
    prior=""
    [ -f "$snap_file" ] && prior="$(cat "$snap_file" 2>/dev/null)"

    # Candidate insert: buffer is NON-EMPTY, DIFFERS from prior snapshot.
    # The prior-snapshot comparison provides the dedupe — once we've recorded a
    # given buffer for an agent we won't re-log it on subsequent polls while it
    # sits there (current == prior).
    if [ -n "$cur" ] && [ "$cur" != "$prior" ]; then
      log_event "$agent" "$cur"
    fi

    # Always update the snapshot to current (handles clears -> empty too).
    printf '%s' "$cur" > "$snap_file" 2>/dev/null || true
  done

  sleep "$POLL_INTERVAL"
done
