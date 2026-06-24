#!/usr/bin/env bash
# board-report-enforcer.sh — BOARD-REPORTING ENFORCEMENT HOOK (card #1713)
#
# Agents MUST report card-related work to the board (send_note / write_status).
# Tonight's failure mode (2026-06-11): an entire P1 demo ran through nudges and
# Telegram while card #1707 sat noteless until the human complained. This hook
# makes that impossible to do silently.
#
# Modes (dispatched by $1):
#   post   PostToolUse, matcher "" (all tools). Tracks per-session board
#          activity in a state file keyed by session_id:
#            - REPORT tools (send_note, write_status, complete_task,
#              report_progress, write_finding, close_subagent) RESET the
#              counters and register the card. Always exit 0.
#            - Other task-board calls register cards (task_id /
#              parent_task_id) and mark the session board-touched.
#            - ACTIVITY tools (Agent/Task, Bash, Edit, Write, NotebookEdit,
#              SendMessage, telegram reply, board mutations) increment the
#              activity counter.
#          ZONE LADDER (per session, since last board report):
#            ZONE 0  count < NAG_CALLS and active-min < NAG_MIN  -> silent
#            ZONE 1  count >= NAG_CALLS or active-min >= NAG_MIN -> NAG
#                    (exit 2: stderr fed back to Claude; tool already ran;
#                    deduped via NAG_COOLDOWN_SEC)
#            ZONE 2  count >= BLOCK_CALLS or active-min >= BLOCK_MIN
#                    -> loud BLOCK-IMMINENT/ACTIVE nag; the `pre` gate below
#                    is what actually blocks.
#          If NO card is inferable: nag generically (ZONE 1 wording only),
#          NEVER escalate to block (avoids false-positive blocks on
#          non-board work). If the session has never touched the task-board
#          at all: fully silent.
#
#   pre    PreToolUse, matcher "" (all tools). If the session is in ZONE 2
#          (block threshold crossed) AND at least one card is tracked AND the
#          tool is NOT exempt -> exit 2 BLOCK with a structured inject telling
#          the agent exactly which send_note/write_status call clears the gate.
#
# HARD RULES (the #1617 deadlock lesson — the remediation path is EXEMPT):
#   - NEVER blocks mcp__task-board__*            (the escape valve itself)
#   - NEVER blocks mcp__plugin_telegram_telegram__*  (replies to the human)
#   - NEVER blocks ToolSearch                    (needed to LOAD send_note's
#                                                 schema when tools are deferred)
#   - NEVER blocks AskUserQuestion               (asking the human)
#   - NEVER blocks when no card is inferable     (nag-only)
#   - Any internal error -> fail-open exit 0; this hook never deadlocks.
#
# ANTI-SPAM: one report per session per window satisfies the gate — a report
# resets all counters, so with defaults an agent posting one note per ~10 min
# of real activity never sees this hook. NAG output itself is deduped
# (NAG_COOLDOWN_SEC). The point is trail, not noise: notes are bridged to the
# team group (#1785), so write quality notes.
#
# Skip rules (fail-open / exit 0):
#   BOARD_REPORT_HOOK_DISABLED=1   global kill-switch (logged disabled.log)
#   BOARD_REPORT_BYPASS=1          per-call emergency (logged bypass.log)
#   agent not in agents.enabled and BOARD_REPORT_HOOK_ENABLED != 1
#   missing/invalid session_id, unparseable stdin, missing state
#
# Env-var thresholds (overridable):
#   BOARD_REPORT_NAG_CALLS=15     activity calls before nag
#   BOARD_REPORT_NAG_MIN=10       minutes of activity before nag
#   BOARD_REPORT_BLOCK_CALLS=30   activity calls before hard block
#   BOARD_REPORT_BLOCK_MIN=25     minutes of activity before hard block
#   BOARD_REPORT_NAG_COOLDOWN_SEC=120   min seconds between nag emissions
#   BOARD_REPORT_STATE_DIR=...    state dir override (used by tests)
#
# Time-trigger floor: minute-based nag/block requires >=3 activity calls so a
# session idle for hours is not insta-gated by its first tool call.
#
# Exit codes: 0 = allow/silent, 2 = nag (post) / block (pre) with stderr.
# bash 3.2 safe: no arrays, no ${var,,}, set -u guarded throughout.

set -u

MODE="${1:-}"
STATE_DIR="${BOARD_REPORT_STATE_DIR:-$HOME/.claude/state/board-report-hook}"
DEBUG_LOG="$STATE_DIR/debug.log"
BYPASS_LOG="$STATE_DIR/bypass.log"
DISABLED_LOG="$STATE_DIR/disabled.log"
AUDIT_LOG="$STATE_DIR/audit.log"
ENABLED_AGENTS_FILE="$STATE_DIR/agents.enabled"

NAG_CALLS_DEFAULT=15
NAG_MIN_DEFAULT=10
BLOCK_CALLS_DEFAULT=30
BLOCK_MIN_DEFAULT=25
NAG_COOLDOWN_SEC_DEFAULT=120
TIME_TRIGGER_FLOOR=3
STATE_STALE_SEC=43200   # 12h: stale state files are reinitialized

mkdir -p "$STATE_DIR" 2>/dev/null || true

log_debug() {
  echo "$(date -u +%FT%TZ) [$MODE] $*" >> "$DEBUG_LOG" 2>/dev/null || true
}

log_audit() {
  # Format: ts mode agent session tool verdict detail
  echo "$(date -u +%FT%TZ) mode=$MODE agent=${AGENT_LABEL:-?} session=${SESSION_ID:-?} tool=${TOOL_NAME:-?} verdict=${1:-?} detail=${2:-}" \
    >> "$AUDIT_LOG" 2>/dev/null || true
}

# Read stdin once (hooks pass JSON on stdin)
STDIN_DATA=$(cat)

# --- Parse stdin (single python call, sanitized pipe-separated output) -------
# Fields: tool_name | session_id | tool_input.task_id | tool_input.parent_task_id
PARSED=$(printf '%s' "$STDIN_DATA" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    print("|||"); sys.exit(0)
def clean(x):
    s = "" if x is None else str(x)
    return "".join(c for c in s if c.isalnum() or c in "_-")[:120]
ti = d.get("tool_input") or {}
print(clean(d.get("tool_name")) + "|" + clean(d.get("session_id")) + "|" +
      clean(ti.get("task_id")) + "|" + clean(ti.get("parent_task_id")))
' 2>/dev/null)
[ -z "$PARSED" ] && PARSED="|||"

TOOL_NAME=$(echo "$PARSED" | cut -d'|' -f1)
SESSION_ID=$(echo "$PARSED" | cut -d'|' -f2)
TID=$(echo "$PARSED" | cut -d'|' -f3)
PTID=$(echo "$PARSED" | cut -d'|' -f4)

# --- Validators ---------------------------------------------------------------
valid_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
valid_agent_label() {
  case "${1:-}" in ''|*[!a-z0-9_-]*) return 1 ;; [a-z]*) return 0 ;; *) return 1 ;; esac
}

num_or_default() {
  # $1=value $2=default -> echoes a guaranteed integer
  if valid_int "${1:-}"; then echo "$1"; else echo "$2"; fi
}

# --- Tool classification --------------------------------------------------------
is_report_tool() {
  case "$1" in
    mcp__task-board__send_note|\
    mcp__task-board__write_status|\
    mcp__task-board__complete_task|\
    mcp__task-board__report_progress|\
    mcp__task-board__write_finding|\
    mcp__task-board__close_subagent) return 0 ;;
    *) return 1 ;;
  esac
}

is_board_tool() {
  case "$1" in mcp__task-board__*) return 0 ;; *) return 1 ;; esac
}

is_activity_tool() {
  case "$1" in
    Agent|Task|Bash|Edit|Write|NotebookEdit|SendMessage|\
    mcp__plugin_telegram_telegram__reply|\
    mcp__task-board__claim_task|\
    mcp__task-board__delegate_task|\
    mcp__task-board__create_task|\
    mcp__task-board__nudge_agent|\
    mcp__task-board__spawn_subagent|\
    mcp__task-board__interrupt_agent) return 0 ;;
    *) return 1 ;;
  esac
}

# Exempt from the pre-gate BLOCK. The escape must ALWAYS be open (#1617):
# the remediation path is ToolSearch (load schema) -> send_note/write_status.
is_exempt_tool() {
  case "$1" in
    mcp__task-board__*|\
    mcp__plugin_telegram_telegram__*|\
    ToolSearch|\
    AskUserQuestion) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Common dispatch checks ---------------------------------------------------
run_common_checks() {
  if [ "${BOARD_REPORT_HOOK_DISABLED:-}" = "1" ]; then
    echo "$(date -u +%FT%TZ) DISABLED agent=${AGENT_LABEL:-?} session=${SESSION_ID:-?}" \
      >> "$DISABLED_LOG" 2>/dev/null || true
    log_audit "DISABLED" "kill-switch"
    exit 0
  fi
  if [ "${BOARD_REPORT_BYPASS:-}" = "1" ]; then
    echo "$(date -u +%FT%TZ) BYPASS agent=${AGENT_LABEL:-?} session=${SESSION_ID:-?} tool=${TOOL_NAME:-?}" \
      >> "$BYPASS_LOG" 2>/dev/null || true
    log_audit "BYPASS" "per-call"
    exit 0
  fi

  # Per-agent gate (mirrors freshness-hook agents.enabled precedent)
  agent_in_enabled_file() {
    [ -f "$ENABLED_AGENTS_FILE" ] || return 1
    grep -v '^[[:space:]]*#' "$ENABLED_AGENTS_FILE" 2>/dev/null | grep -qFx "$1"
  }
  if [ "${BOARD_REPORT_HOOK_ENABLED:-}" != "1" ] && ! agent_in_enabled_file "${AGENT_LABEL:-}"; then
    exit 0
  fi
  if ! valid_agent_label "${AGENT_LABEL:-}"; then
    exit 0
  fi
  if [ -z "$SESSION_ID" ]; then
    log_debug "missing session_id — fail-open"
    exit 0
  fi
  if [ -z "$TOOL_NAME" ]; then
    exit 0
  fi
}

# --- State handling -------------------------------------------------------------
# State file: $STATE_DIR/session-<session_id>.state — plain key=value lines.
load_state() {
  STATE_FILE="$STATE_DIR/session-${SESSION_ID}.state"
  CARDS=""
  BOARD_TOUCHED=0
  ACTIVITY_COUNT=0
  LAST_REPORT_TS=0
  FIRST_ACTIVITY_TS=0
  LAST_NAG_TS=0
  NOW=$(date +%s 2>/dev/null || echo 0)
  if [ -f "$STATE_FILE" ]; then
    # Stale-state reset (12h): a long-dead session id reused after hours
    local mtime age
    mtime=$(stat -f %m "$STATE_FILE" 2>/dev/null || stat -c %Y "$STATE_FILE" 2>/dev/null || echo 0)
    age=$(( NOW - mtime ))
    if [ "$age" -lt "$STATE_STALE_SEC" ]; then
      CARDS=$(grep '^cards=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
      BOARD_TOUCHED=$(num_or_default "$(grep '^board_touched=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)" 0)
      ACTIVITY_COUNT=$(num_or_default "$(grep '^activity_count=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)" 0)
      LAST_REPORT_TS=$(num_or_default "$(grep '^last_report_ts=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)" 0)
      FIRST_ACTIVITY_TS=$(num_or_default "$(grep '^first_activity_ts=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)" 0)
      LAST_NAG_TS=$(num_or_default "$(grep '^last_nag_ts=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)" 0)
    fi
  fi
}

save_state() {
  local tmp
  tmp="$STATE_FILE.tmp.$$"
  {
    echo "cards=$CARDS"
    echo "board_touched=$BOARD_TOUCHED"
    echo "activity_count=$ACTIVITY_COUNT"
    echo "last_report_ts=$LAST_REPORT_TS"
    echo "first_activity_ts=$FIRST_ACTIVITY_TS"
    echo "last_nag_ts=$LAST_NAG_TS"
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$STATE_FILE" 2>/dev/null
}

add_card() {
  local c="${1:-}"
  valid_int "$c" || return 0
  case " $CARDS " in
    *" $c "*) ;;
    *) CARDS="${CARDS:+$CARDS }$c" ;;
  esac
  # Keep the last 5 cards only
  CARDS=$(echo "$CARDS" | awk '{ s = (NF > 5) ? NF - 4 : 1
    out = ""
    for (i = s; i <= NF; i++) out = out (out == "" ? "" : " ") $i
    print out }')
}

# Minutes of unreported activity (0 if no activity yet)
active_minutes() {
  if [ "$FIRST_ACTIVITY_TS" -gt 0 ] 2>/dev/null && [ "$NOW" -gt "$FIRST_ACTIVITY_TS" ] 2>/dev/null; then
    echo $(( (NOW - FIRST_ACTIVITY_TS) / 60 ))
  else
    echo 0
  fi
}

primary_card() {
  # Last (= most recently touched) tracked card
  echo "$CARDS" | awk '{ if (NF > 0) print $NF }'
}

# --- Thresholds -----------------------------------------------------------------
NAG_CALLS=$(num_or_default "${BOARD_REPORT_NAG_CALLS:-}" "$NAG_CALLS_DEFAULT")
NAG_MIN=$(num_or_default "${BOARD_REPORT_NAG_MIN:-}" "$NAG_MIN_DEFAULT")
BLOCK_CALLS=$(num_or_default "${BOARD_REPORT_BLOCK_CALLS:-}" "$BLOCK_CALLS_DEFAULT")
BLOCK_MIN=$(num_or_default "${BOARD_REPORT_BLOCK_MIN:-}" "$BLOCK_MIN_DEFAULT")
NAG_COOLDOWN_SEC=$(num_or_default "${BOARD_REPORT_NAG_COOLDOWN_SEC:-}" "$NAG_COOLDOWN_SEC_DEFAULT")

in_block_zone() {
  # $1=count $2=mins
  if [ "$1" -ge "$BLOCK_CALLS" ] 2>/dev/null; then return 0; fi
  if [ "$1" -ge "$TIME_TRIGGER_FLOOR" ] 2>/dev/null && [ "$2" -ge "$BLOCK_MIN" ] 2>/dev/null; then return 0; fi
  return 1
}

in_nag_zone() {
  if [ "$1" -ge "$NAG_CALLS" ] 2>/dev/null; then return 0; fi
  if [ "$1" -ge "$TIME_TRIGGER_FLOOR" ] 2>/dev/null && [ "$2" -ge "$NAG_MIN" ] 2>/dev/null; then return 0; fi
  return 1
}

emit_report_instructions() {
  # $1 = card id (may be empty)
  local card="${1:-}"
  if [ -n "$card" ]; then
    cat >&2 <<EOF
ACTION REQUIRED — post a board update to your card NOW (one good note clears this for ~${NAG_MIN}+ min):

  send_note(task_id=${card}, message="<what you just did / found / decided>")
  or
  write_status(agent="${AGENT_LABEL:-you}", task_id=${card}, status="working", detail="<current step>")

Reporting tools, ToolSearch, and Telegram replies are NEVER blocked by this gate.
EOF
  else
    cat >&2 <<EOF
No board card could be inferred for this session, so nothing is blocked — but you
have task-board activity without any card trail. If this work relates to a card,
claim it and post send_note(task_id=<card>, ...) so the board reflects reality.
EOF
  fi
  cat >&2 <<EOF
Bypass (logged): BOARD_REPORT_BYPASS=1 per-call | BOARD_REPORT_HOOK_DISABLED=1 kill-switch
Thresholds: BOARD_REPORT_NAG_CALLS=${NAG_CALLS} BOARD_REPORT_NAG_MIN=${NAG_MIN} BOARD_REPORT_BLOCK_CALLS=${BLOCK_CALLS} BOARD_REPORT_BLOCK_MIN=${BLOCK_MIN}
EOF
}

# --- Mode dispatch ----------------------------------------------------------------
case "$MODE" in

  post)
    run_common_checks
    load_state

    # 1) REPORT tool -> register card, reset counters, always allow silently.
    if is_report_tool "$TOOL_NAME"; then
      add_card "$TID"
      add_card "$PTID"
      BOARD_TOUCHED=1
      ACTIVITY_COUNT=0
      FIRST_ACTIVITY_TS=0
      LAST_REPORT_TS="$NOW"
      LAST_NAG_TS=0
      save_state
      log_audit "RESET" "report-tool cards=$CARDS"
      exit 0
    fi

    # 2) Any task-board tool -> board-touched + card registration.
    if is_board_tool "$TOOL_NAME"; then
      BOARD_TOUCHED=1
      add_card "$TID"
      add_card "$PTID"
    fi

    # 3) Activity accounting.
    if is_activity_tool "$TOOL_NAME"; then
      if [ "$ACTIVITY_COUNT" -eq 0 ] 2>/dev/null; then
        FIRST_ACTIVITY_TS="$NOW"
      fi
      ACTIVITY_COUNT=$(( ACTIVITY_COUNT + 1 ))
    fi

    save_state

    # 4) Non-board session: fully silent.
    if [ "$BOARD_TOUCHED" != "1" ]; then
      exit 0
    fi

    MINS=$(active_minutes)

    # 5) Zone evaluation + deduped nag.
    if ! in_nag_zone "$ACTIVITY_COUNT" "$MINS"; then
      exit 0
    fi
    if [ "$LAST_NAG_TS" -gt 0 ] 2>/dev/null && [ $(( NOW - LAST_NAG_TS )) -lt "$NAG_COOLDOWN_SEC" ] 2>/dev/null; then
      exit 0
    fi

    CARD=$(primary_card)
    LAST_NAG_TS="$NOW"
    save_state

    if [ -n "$CARD" ] && in_block_zone "$ACTIVITY_COUNT" "$MINS"; then
      log_audit "NAG-BLOCKZONE" "count=$ACTIVITY_COUNT mins=$MINS cards=$CARDS"
      cat >&2 <<EOF
=== BOARD-REPORTING GATE [BLOCK ACTIVE] === cards: $(echo "$CARDS" | sed 's/[0-9][0-9]*/#&/g')
You have ${ACTIVITY_COUNT} tool calls / ${MINS} min of card-related activity with NO board note.
The PreToolUse gate is now BLOCKING all non-reporting tools for this session.
EOF
      emit_report_instructions "$CARD"
      exit 2
    fi

    log_audit "NAG" "count=$ACTIVITY_COUNT mins=$MINS cards=${CARDS:-none}"
    if [ -n "$CARD" ]; then
      cat >&2 <<EOF
=== BOARD-REPORTING NAG === cards: $(echo "$CARDS" | sed 's/[0-9][0-9]*/#&/g')
${ACTIVITY_COUNT} tool calls / ${MINS} min of activity since your last board note.
At ${BLOCK_CALLS} calls or ${BLOCK_MIN} min, non-reporting tools will be HARD-BLOCKED.
The board is the source of truth — Telegram/nudges do NOT count as a trail (ref #1707).
EOF
    else
      cat >&2 <<EOF
=== BOARD-REPORTING NAG (no card inferred — advisory only) ===
${ACTIVITY_COUNT} tool calls / ${MINS} min of board-adjacent activity with no card trail.
EOF
    fi
    emit_report_instructions "$CARD"
    exit 2
    ;;

  pre)
    # Exempt tools FIRST — the escape valve is checked before anything that
    # could possibly fail. send_note/write_status/ToolSearch/Telegram can
    # never be blocked, even if state handling below has a bug.
    if is_exempt_tool "$TOOL_NAME"; then
      exit 0
    fi

    run_common_checks
    load_state

    # No state / no board contact / no inferable card -> never block.
    if [ "$BOARD_TOUCHED" != "1" ]; then exit 0; fi
    CARD=$(primary_card)
    if [ -z "$CARD" ]; then exit 0; fi

    MINS=$(active_minutes)
    if ! in_block_zone "$ACTIVITY_COUNT" "$MINS"; then
      exit 0
    fi

    log_audit "BLOCK" "count=$ACTIVITY_COUNT mins=$MINS cards=$CARDS blocked_tool=$TOOL_NAME"
    cat >&2 <<EOF
=== BOARD-REPORTING GATE [BLOCKED: ${TOOL_NAME}] === cards: $(echo "$CARDS" | sed 's/[0-9][0-9]*/#&/g')
This session has ${ACTIVITY_COUNT} tool calls / ${MINS} min of card-related activity
with NO board note. Non-reporting tools are blocked until you report.
EOF
    emit_report_instructions "$CARD"
    cat >&2 <<EOF
After the note lands, retry ${TOOL_NAME} — the gate clears immediately.
EOF
    exit 2
    ;;

  *)
    log_debug "unknown mode: '$MODE' — fail-open"
    exit 0
    ;;
esac
