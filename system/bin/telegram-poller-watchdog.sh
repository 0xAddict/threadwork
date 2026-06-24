#!/bin/bash
#
# telegram-poller-watchdog.sh
#
# Standalone watchdog for the per-agent Telegram getUpdates pollers.
#
# ROOT CAUSE (memories #2181/#2182): each agent runs its own telegram poller
#   (`bun .../telegram/.../server.ts`) with a distinct bot token and a per-agent
#   TELEGRAM_STATE_DIR=~/.claude/channels/telegram/<agent>/ (containing bot.pid).
#   The poller dies SILENTLY (no teardown log) with NO client-side auto-recovery;
#   the MCP channel stays "✘ failed" until a manual /mcp Reconnect.
#
# This watchdog:
#   - DETECTS (read-only) which agents have a live poller, every cycle.
#   - For a DOWN agent whose tmux pane is verified IDLE, drives the /mcp picker
#     to Reconnect plugin:telegram:telegram — defensively, with verification at
#     every step.
#
# SAFETY: only ever sends /mcp, Down, Up, Enter, Escape — and ONLY to an IDLE
#   pane of a DOWN agent. NEVER presses Enter unless the highlighted row /
#   detail view is verified telegram. On ANY unexpected capture -> Escape, log,
#   abort that agent for the cycle. Zero destructive actions, ever.
#
# REVERSIBLE: writes its pid to STATE_DIR/watchdog.pid.
#   STOP:  kill $(cat ~/.claude/state/telegram-watchdog/watchdog.pid)
#
# Logs every detection + action with ISO-8601 UTC timestamps to
#   ~/.claude/state/telegram-watchdog/watchdog.log

set -u

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
AGENTS=(boss steve sadie kiera snoopy)
CHANNELS_DIR="$HOME/.claude/channels/telegram"
STATE_DIR="$HOME/.claude/state/telegram-watchdog"
LOG_FILE="$STATE_DIR/watchdog.log"
PID_FILE="$STATE_DIR/watchdog.pid"
INTERVAL="${TELEGRAM_WATCHDOG_INTERVAL:-60}"     # seconds between cycles
POLLER_PATH_MATCH="telegram"                      # plugin path substring for safety filter
MAX_DOWNS=60                                      # cap on Down presses in the picker
TARGET_ROW="plugin:telegram:telegram"

mkdir -p "$STATE_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" >>"$LOG_FILE"; }

# ----------------------------------------------------------------------------
# DETECTION (read-only)
# ----------------------------------------------------------------------------
# Returns, on stdout, the set of agents WITH a live poller (one per line).
live_poller_agents() {
  local pids pid envline label statedir cmd cwd
  # Enumerate candidate server.ts processes.
  #
  # CRITICAL DISCRIMINATOR: the task-board MCP server ALSO inherits AGENT_LABEL
  # and TELEGRAM_STATE_DIR from the parent Claude session env, so env vars alone
  # cannot separate poller from task-board. The real telegram poller is invoked
  # as a BARE relative script: `<bun> server.ts` with cwd = the telegram plugin
  # dir. The task-board server is `bun run /…/mcp-servers/task-board/server.ts`
  # with cwd = /. We require BOTH: bare `server.ts` arg (no slash) AND a cwd
  # inside the telegram plugin tree. Belt-and-suspenders.
  pids=$(ps aux | grep '[s]erver.ts' | awk '{print $2}')
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null)
    # Must be invoked with a bare `server.ts` (relative, no leading path).
    case "$cmd" in
      *" server.ts"|*" server.ts "*) : ;;   # bun ... server.ts (relative)
      *) continue ;;
    esac
    # Reject anything that invokes server.ts via an absolute/relative PATH
    # (e.g. `bun run /…/task-board/server.ts`).
    case "$cmd" in
      *"/server.ts"*) continue ;;
    esac
    # cwd must be inside the telegram plugin tree.
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | head -1 | cut -c2-)
    case "$cwd" in
      *"$POLLER_PATH_MATCH"*) : ;;
      *) continue ;;
    esac
    envline=$(ps eww -p "$pid" 2>/dev/null)
    statedir=$(printf '%s\n' "$envline" | tr ' ' '\n' | grep '^TELEGRAM_STATE_DIR=' | head -1 | cut -d= -f2-)
    label=$(printf '%s\n' "$envline" | tr ' ' '\n' | grep '^AGENT_LABEL=' | head -1 | cut -d= -f2-)
    [ -z "$label" ] && continue
    # Require the state dir to actually point into the telegram channels tree.
    case "$statedir" in
      "$CHANNELS_DIR"/*) echo "$label" ;;
    esac
  done | sort -u
}

# bot.pid liveness check (secondary signal, logged for instrumentation).
botpid_status() {
  local agent="$1" f p
  f="$CHANNELS_DIR/$agent/bot.pid"
  if [ -f "$f" ]; then
    p=$(cat "$f" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      echo "botpid=$p:ALIVE"
    else
      echo "botpid=${p:-none}:DEAD"
    fi
  else
    echo "botpid=missing"
  fi
}

# ----------------------------------------------------------------------------
# IDLE detection for a pane (read-only)
# ----------------------------------------------------------------------------
# Echoes "IDLE", "BUSY", or "MCP_PICKER" / "NO_PANE".
pane_state() {
  local agent="$1" pane cap promptline
  pane="claude-$agent"
  cap=$(tmux capture-pane -t "$pane" -p 2>/dev/null)
  if [ -z "$cap" ]; then
    echo "NO_PANE"
    return
  fi
  cap=$(printf '%s\n' "$cap" | tail -30)

  # Busy signals FIRST -> BUSY. Any one present means do NOT key in. Checked
  # before MCP_PICKER so an actively-generating pane is never mistaken for a
  # leftover picker just because the transcript text happens to mention MCP.
  #
  # IMPORTANT CALIBRATION: a bare spinner glyph (✻/✶/✳) is NOT a reliable busy
  # signal — Claude Code reuses ✻ on the COMPLETED action-summary line that
  # persists in scrollback (e.g. "✻ Cogitated for 8s"). So we require:
  #   (a) the footer "esc to interrupt" (actively generating), OR
  #   (b) a "Waiting for N background agent" line (sub-agent in flight), OR
  #   (c) a known spinner VERB immediately followed by the in-progress ellipsis
  #       "…" (active spinner, not a past summary), OR
  #   (d) a spinner glyph paired with a trailing "(esc to interrupt)".
  if printf '%s\n' "$cap" | grep -qE 'esc to interrupt'; then
    echo "BUSY"; return
  fi
  if printf '%s\n' "$cap" | grep -qE 'Waiting for [0-9]+ background agent'; then
    echo "BUSY"; return
  fi
  if printf '%s\n' "$cap" | grep -qE '(Computing|Whirring|Meandering|Smooshing|Nucleating|Finagling|Metamorphosing|Thinking|Calling|Cogitating|Baking|Pondering|Forging|Working|Processing)…'; then
    echo "BUSY"; return
  fi

  # Leftover /mcp picker detection. Require the GENUINE Claude Code MCP picker
  # chrome — its distinctive header / footer — NOT arbitrary transcript text
  # that merely mentions "Reconnect" or "plugin:telegram:telegram". This is the
  # critical guard that prevents Escaping a live pane whose transcript happens to
  # quote those strings.
  if printf '%s\n' "$cap" | grep -qE 'Manage MCP servers|MCP Server Details|❯ +1\. Reconnect|^ *Esc to (go back|exit)'; then
    echo "MCP_PICKER"
    return
  fi

  # Idle requires an empty prompt line: a line that is just "❯" (optionally with
  # trailing whitespace) and nothing typed after it.
  #
  # LOCALE / NBSP BUG (live incident 2026-06-11, boss DOWN ~14 min): Claude Code
  # renders the empty input row as "❯" followed by a U+00A0 NO-BREAK SPACE
  # (bytes c2 a0), and may prefix the row with a leading space inside the input
  # box border. Under launchd the job runs in the C/POSIX locale (no LANG/LC_ALL),
  # where `[[:space:]]` matches ONLY ASCII whitespace — NOT the multibyte UTF-8
  # nbsp. So `^❯` could miss a leading-space-indented prompt, and the trailing
  # nbsp survived the strip, leaving `rest` non-empty -> the idle pane was
  # wrongly classified BUSY every cycle ("deferred: boss busy") and never
  # reconnected. Fix: tolerate a leading nbsp/space before ❯, and strip BOTH
  # ASCII whitespace AND the literal nbsp (and box-drawing border bytes) when
  # computing the residual input buffer. Locale-robust: we match the nbsp by its
  # literal UTF-8 bytes via a shell variable, not via a character class.
  local NBSP
  NBSP=$(printf '\xc2\xa0')
  # Allow an optional single leading space/nbsp (input-box padding) before ❯.
  promptline=$(printf '%s\n' "$cap" | grep -E "^[[:space:]${NBSP}]?❯" | tail -1)
  if [ -z "$promptline" ]; then
    # No visible prompt at all -> treat as BUSY (unknown state, be conservative).
    echo "BUSY"
    return
  fi
  # Strip everything up to and including ❯, then strip any trailing ASCII
  # whitespace AND nbsp. If anything non-whitespace remains, the input buffer is
  # non-empty -> not safe to key (especially for snoopy).
  local rest
  rest=$(printf '%s' "$promptline" | sed -E 's/^.*❯//')
  # Remove all nbsp bytes and ASCII whitespace from the residual.
  rest=$(printf '%s' "$rest" | sed -E "s/${NBSP}//g; s/[[:space:]]//g")
  if [ -n "$rest" ]; then
    echo "BUSY"
    return
  fi
  echo "IDLE"
}

# Escape a pane to a clean prompt (best-effort cleanup).
escape_pane() {
  local agent="$1"
  tmux send-keys -t "claude-$agent" Escape 2>/dev/null
  sleep 0.3
  tmux send-keys -t "claude-$agent" Escape 2>/dev/null
  sleep 0.3
}

# Capture the currently highlighted picker row (the line bearing the ❯ cursor).
highlighted_row() {
  local agent="$1"
  tmux capture-pane -t "claude-$agent" -p 2>/dev/null | grep -E '^[[:space:]]*❯' | tail -1
}

# ----------------------------------------------------------------------------
# RECONNECT ceremony for one DOWN + IDLE agent
# ----------------------------------------------------------------------------
reconnect_agent() {
  local agent="$1" pane="claude-$1"
  local cap row downs found detail

  # Re-check idle immediately before opening /mcp (race guard).
  local st
  st=$(pane_state "$agent")
  if [ "$st" = "MCP_PICKER" ]; then
    log "RECONNECT $agent: leftover /mcp picker detected pre-open -> Escape x2, skip cycle"
    escape_pane "$agent"
    return
  fi
  if [ "$st" != "IDLE" ]; then
    log "deferred: $agent busy (pre-open recheck = $st)"
    return
  fi

  log "RECONNECT $agent: opening /mcp picker"
  # -l = literal: send the characters "/mcp" exactly, never interpreted as keys.
  tmux send-keys -t "$pane" -l '/mcp' 2>/dev/null
  sleep 0.4
  tmux send-keys -t "$pane" Enter 2>/dev/null
  sleep 5

  # Step 2: navigate to the plugin:telegram:telegram row.
  found=0
  downs=0
  while [ "$downs" -le "$MAX_DOWNS" ]; do
    row=$(highlighted_row "$agent")
    # Sanity: we must still be in an MCP picker. If the capture looks nothing
    # like a server list, abort defensively.
    cap=$(tmux capture-pane -t "$pane" -p 2>/dev/null | tail -30)
    if ! printf '%s\n' "$cap" | grep -qiE 'MCP server|Manage MCP|plugin:|task-board'; then
      log "RECONNECT $agent: ANOMALY - picker not visible after open (capture unexpected) -> Escape, abort"
      escape_pane "$agent"
      return
    fi
    if printf '%s' "$row" | grep -qE "[[:space:]]${TARGET_ROW}([[:space:]]|\$)"; then
      found=1
      break
    fi
    # Send a small batch of Downs and re-check.
    tmux send-keys -t "$pane" Down Down Down 2>/dev/null
    downs=$((downs + 3))
    sleep 0.6
  done

  if [ "$found" -ne 1 ]; then
    log "RECONNECT $agent: $TARGET_ROW row NOT found after $downs Downs -> Escape, abort"
    escape_pane "$agent"
    return
  fi

  # Step 3: VERIFY highlighted row text == plugin:telegram:telegram and read status.
  row=$(highlighted_row "$agent")
  if ! printf '%s' "$row" | grep -qE "[[:space:]]${TARGET_ROW}([[:space:]]|\$)"; then
    log "RECONNECT $agent: ANOMALY - highlighted row not telegram at verify ('$row') -> Escape, abort"
    escape_pane "$agent"
    return
  fi
  if printf '%s' "$row" | grep -qE 'connected|✔'; then
    log "RECONNECT $agent: already connected, no action (row: $(printf '%s' "$row" | tr -s ' '))"
    escape_pane "$agent"
    return
  fi
  if ! printf '%s' "$row" | grep -qE 'failed|✘'; then
    log "RECONNECT $agent: ANOMALY - row status neither failed nor connected ('$(printf '%s' "$row" | tr -s ' ')') -> Escape, abort"
    escape_pane "$agent"
    return
  fi

  log "RECONNECT $agent: row=$TARGET_ROW status=failed -> entering detail view"
  tmux send-keys -t "$pane" Enter 2>/dev/null
  sleep 2.5

  # Step 4: confirm detail view is the telegram MCP server with a Reconnect option.
  detail=$(tmux capture-pane -t "$pane" -p 2>/dev/null | tail -30)
  if ! printf '%s\n' "$detail" | grep -qiE 'telegram:telegram MCP Server|plugin:telegram:telegram'; then
    log "RECONNECT $agent: ANOMALY - detail view is NOT telegram -> Escape, abort (NEVER Enter on non-telegram)"
    escape_pane "$agent"
    return
  fi
  if ! printf '%s\n' "$detail" | grep -qiE 'Reconnect'; then
    log "RECONNECT $agent: ANOMALY - detail view lacks Reconnect option -> Escape, abort"
    escape_pane "$agent"
    return
  fi

  log "RECONNECT $agent: detail view verified telegram + Reconnect present -> pressing Reconnect"
  tmux send-keys -t "$pane" Enter 2>/dev/null
  sleep 8

  # Step 5: verify reconnection succeeded.
  local result
  result=$(tmux capture-pane -t "$pane" -p 2>/dev/null | tail -30)
  if printf '%s\n' "$result" | grep -qiE "Reconnected to ${TARGET_ROW}|Reconnected to plugin:telegram:telegram"; then
    log "RECONNECT $agent: SUCCESS - Reconnected to $TARGET_ROW"
    escape_pane "$agent"
    return
  fi

  log "RECONNECT $agent: FAILURE - 'Reconnected' confirmation not present; leaving clean prompt, will retry next cycle"
  escape_pane "$agent"
}

# ----------------------------------------------------------------------------
# One detection + action cycle
# ----------------------------------------------------------------------------
run_cycle() {
  local live agent census state bp down_agents=()
  live=$(live_poller_agents)

  # Build + log the full census.
  census=""
  for agent in "${AGENTS[@]}"; do
    bp=$(botpid_status "$agent")
    if printf '%s\n' "$live" | grep -qx "$agent"; then
      state="UP"
    else
      state="DOWN"
      down_agents+=("$agent")
    fi
    census="${census}${agent}=${state}($bp) "
  done
  log "CENSUS ${census}"

  # Act on DOWN agents (only when idle).
  # Guard empty array: under bash 3.2 + `set -u`, expanding "${down_agents[@]}"
  # when the array is empty is a fatal "unbound variable" error (crashes the
  # whole loop). When all agents are UP, down_agents is empty -> skip cleanly.
  if [ ${#down_agents[@]} -gt 0 ]; then
    for agent in "${down_agents[@]}"; do
      state=$(pane_state "$agent")
      case "$state" in
        NO_PANE)
          log "deferred: $agent no tmux pane (claude-$agent) -> skip"
          ;;
        MCP_PICKER)
          log "$agent DOWN: leftover /mcp picker -> Escape x2, skip cycle"
          escape_pane "$agent"
          ;;
        BUSY)
          log "deferred: $agent busy"
          ;;
        IDLE)
          reconnect_agent "$agent"
          ;;
      esac
    done
  fi
}

# ----------------------------------------------------------------------------
# Mode dispatch
# ----------------------------------------------------------------------------
case "${1:-loop}" in
  once)
    # Single read-only-ish cycle (still acts on idle down agents). Used for tests
    # with --census to suppress actions.
    if [ "${2:-}" = "--census" ]; then
      live=$(live_poller_agents)
      out=""
      for agent in "${AGENTS[@]}"; do
        bp=$(botpid_status "$agent")
        if printf '%s\n' "$live" | grep -qx "$agent"; then state="UP"; else state="DOWN"; fi
        out="${out}${agent}=${state}($bp)\n"
        ps=$(pane_state "$agent")
        out="${out}    pane=${ps}\n"
      done
      printf "%b" "$out"
      log "TEST census-only pass: $(printf '%b' "$out" | tr '\n' ' ')"
    else
      run_cycle
    fi
    ;;
  loop)
    echo $$ >"$PID_FILE"
    log "WATCHDOG START pid=$$ interval=${INTERVAL}s"
    # Clean up pid file on exit.
    trap 'log "WATCHDOG STOP pid=$$"; rm -f "$PID_FILE"; exit 0' TERM INT
    while true; do
      run_cycle
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: $0 [loop|once [--census]]" >&2
    exit 2
    ;;
esac
