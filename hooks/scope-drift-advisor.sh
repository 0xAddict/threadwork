#!/usr/bin/env bash
# scope-drift-advisor.sh — DESCRIPTION-VS-NOTES DRIFT ADVISORY (#13014 item 12)
#
# SOFT advisory, NEVER blocking. PostToolUse on mcp__task-board__send_note:
# the note has ALREADY LANDED when this hook runs; exit 2 only feeds stderr
# back to Claude as a system-message suggestion (same mechanic as
# board-report-enforcer.sh `post` nags). There is no `pre` mode and never
# will be — this hook has no block path by design.
#
# Trigger heuristic (cheap + dumb, false positives tolerated):
#   After a note lands on card #N, fire the advisory if EITHER
#     - notes count on the card >= SCOPE_DRIFT_NOTES_COUNT (default 12), OR
#     - cumulative notes length >= SCOPE_DRIFT_LEN_MULT (default 4) x
#       max(description length, SCOPE_DRIFT_DESC_FLOOR (default 200))
#   The floor stops one-liner descriptions from making the multiple trivially
#   crossable by a single long note.
#
# Output: once-per-card-per-day (SCOPE_DRIFT_COOLDOWN_SEC, default 86400)
# suggestion: "scope drift on #N — consider splitting into a proper card
# (#1608->#13012 incident)". Rate-limit state: $STATE_DIR/fired-<id>.stamp.
#
# Skip rules (fail-open / exit 0, mirrors freshness-check.sh house pattern):
#   SCOPE_DRIFT_HOOK_DISABLED=1    global kill-switch (logged disabled.log)
#   SCOPE_DRIFT_BYPASS=1           per-call silence (logged bypass.log)
#   agent not in agents.enabled and SCOPE_DRIFT_HOOK_ENABLED != 1
#   tool is not send_note / invalid task_id / invalid agent / db missing
#   terminal-status card (completed/cancelled/done/complete) — archival
#     record-keeping notes are legitimate (#13014 item 8c), not scope drift
#   synthetic / watchdog tasks
#   any internal error — this hook never blocks anything
#
# Env-var knobs (overridable):
#   SCOPE_DRIFT_NOTES_COUNT=12    notes-count trigger
#   SCOPE_DRIFT_LEN_MULT=4        cumulative-notes-length multiple of desc len
#   SCOPE_DRIFT_DESC_FLOOR=200    description-length floor for the multiple
#   SCOPE_DRIFT_COOLDOWN_SEC=86400  once-per-card-per-day rate limit
#   SCOPE_DRIFT_STATE_DIR=...     state dir override (used by tests)
#   SCOPE_DRIFT_DB=...            db override (TESTS ONLY)
#
# Exit codes: 0 = silent, 2 = advisory emitted on stderr (non-blocking:
# PostToolUse exit 2 surfaces stderr to Claude; the tool already ran).
# bash 3.2 safe: no arrays, no ${var,,}, set -u guarded throughout.

set -u

MODE="${1:-}"
STATE_DIR="${SCOPE_DRIFT_STATE_DIR:-$HOME/.claude/state/scope-drift-advisor}"
DEBUG_LOG="$STATE_DIR/debug.log"
BYPASS_LOG="$STATE_DIR/bypass.log"
DISABLED_LOG="$STATE_DIR/disabled.log"
AUDIT_LOG="$STATE_DIR/audit.log"
ENABLED_AGENTS_FILE="$STATE_DIR/agents.enabled"
DB="${SCOPE_DRIFT_DB:-$HOME/.claude/mcp-servers/task-board/tasks.db}"

NOTES_COUNT_DEFAULT=12
LEN_MULT_DEFAULT=4
DESC_FLOOR_DEFAULT=200
COOLDOWN_SEC_DEFAULT=86400

mkdir -p "$STATE_DIR" 2>/dev/null || true

log_debug() {
  echo "$(date -u +%FT%TZ) [$MODE] $*" >> "$DEBUG_LOG" 2>/dev/null || true
}

log_audit() {
  # Format: ts mode agent task verdict detail
  echo "$(date -u +%FT%TZ) mode=$MODE agent=${AGENT_LABEL:-?} task=${1:-?} verdict=${2:-?} detail=${3:-}" \
    >> "$AUDIT_LOG" 2>/dev/null || true
}

# Read stdin once (hooks pass JSON on stdin)
STDIN_DATA=$(cat)

# --- Validators ---------------------------------------------------------------
valid_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
valid_agent_label() {
  case "${1:-}" in ''|*[!a-z0-9_-]*) return 1 ;; [a-z]*) return 0 ;; *) return 1 ;; esac
}
num_or_default() {
  # $1=value $2=default -> echoes a guaranteed integer
  if valid_int "${1:-}"; then echo "$1"; else echo "$2"; fi
}

# --- Parse stdin (single python call, pipe-separated, sanitized) ---------------
# Fields: tool_name | tool_input.task_id
PARSED=$(printf '%s' "$STDIN_DATA" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    print("|"); sys.exit(0)
def clean(x):
    s = "" if x is None else str(x)
    return "".join(c for c in s if c.isalnum() or c in "_-")[:120]
ti = d.get("tool_input") or {}
print(clean(d.get("tool_name")) + "|" + clean(ti.get("task_id")))
' 2>/dev/null)
[ -z "$PARSED" ] && PARSED="|"

TOOL_NAME=$(echo "$PARSED" | cut -d'|' -f1)
TASK_ID=$(echo "$PARSED" | cut -d'|' -f2)

case "$MODE" in

  post)
    # Only notes landing can move the heuristic — everything else is silent.
    if [ "$TOOL_NAME" != "mcp__task-board__send_note" ]; then
      exit 0
    fi

    # Kill-switch / bypass (logged, house pattern)
    if [ "${SCOPE_DRIFT_HOOK_DISABLED:-}" = "1" ]; then
      echo "$(date -u +%FT%TZ) DISABLED agent=${AGENT_LABEL:-?}" >> "$DISABLED_LOG" 2>/dev/null || true
      log_audit "${TASK_ID:-?}" "DISABLED" "kill-switch"
      exit 0
    fi
    if [ "${SCOPE_DRIFT_BYPASS:-}" = "1" ]; then
      echo "$(date -u +%FT%TZ) BYPASS agent=${AGENT_LABEL:-?} task=${TASK_ID:-?}" >> "$BYPASS_LOG" 2>/dev/null || true
      log_audit "${TASK_ID:-?}" "BYPASS" "per-call"
      exit 0
    fi

    # Per-agent gate (mirrors freshness-hook agents.enabled precedent)
    agent_in_enabled_file() {
      [ -f "$ENABLED_AGENTS_FILE" ] || return 1
      grep -v '^[[:space:]]*#' "$ENABLED_AGENTS_FILE" 2>/dev/null | grep -qFx "$1"
    }
    if [ "${SCOPE_DRIFT_HOOK_ENABLED:-}" != "1" ] && ! agent_in_enabled_file "${AGENT_LABEL:-}"; then
      exit 0
    fi

    if ! valid_int "$TASK_ID"; then
      log_debug "invalid/missing task_id: '$TASK_ID' — silent"
      exit 0
    fi
    if ! valid_agent_label "${AGENT_LABEL:-}"; then
      exit 0
    fi
    if [ ! -f "$DB" ]; then
      log_debug "db missing: $DB — silent"
      exit 0
    fi

    # Rate limit FIRST (cheapest check): once per card per cooldown window.
    COOLDOWN_SEC=$(num_or_default "${SCOPE_DRIFT_COOLDOWN_SEC:-}" "$COOLDOWN_SEC_DEFAULT")
    STAMP_FILE="$STATE_DIR/fired-${TASK_ID}.stamp"
    NOW=$(date +%s 2>/dev/null || echo 0)
    if [ -f "$STAMP_FILE" ]; then
      LAST_FIRED=$(num_or_default "$(cat "$STAMP_FILE" 2>/dev/null)" 0)
      if [ "$LAST_FIRED" -gt 0 ] 2>/dev/null && [ $(( NOW - LAST_FIRED )) -lt "$COOLDOWN_SEC" ] 2>/dev/null; then
        exit 0
      fi
    fi

    # Single fast row: desc_len | status | is_synthetic | from_agent
    ROW_SQL="SELECT \
      LENGTH(COALESCE(description,'')), \
      COALESCE(status,''), \
      COALESCE(is_synthetic,0), \
      COALESCE(from_agent,'') \
      FROM tasks WHERE id=${TASK_ID};"
    ROW=$(sqlite3 -readonly "$DB" "$ROW_SQL" 2>>"$DEBUG_LOG")
    if [ -z "$ROW" ]; then
      log_debug "no row for task=$TASK_ID — silent"
      exit 0
    fi
    DESC_LEN=$(echo "$ROW" | cut -d'|' -f1)
    STATUS=$(echo "$ROW" | cut -d'|' -f2)
    IS_SYN=$(echo "$ROW" | cut -d'|' -f3)
    FROM_AGENT=$(echo "$ROW" | cut -d'|' -f4)
    valid_int "$DESC_LEN" || DESC_LEN=0

    # Terminal cards are archives (#13014 item 8c) — record-keeping notes on
    # them are legitimate, not scope drift. Synthetic/watchdog: never advise.
    case "$STATUS" in
      completed|cancelled|done|complete)
        exit 0
        ;;
    esac
    if [ "$FROM_AGENT" = "watchdog" ] || [ "$IS_SYN" = "1" ]; then
      exit 0
    fi

    # Notes aggregate: count | cumulative length
    NOTES_ROW=$(sqlite3 -readonly "$DB" \
      "SELECT COUNT(*) || '|' || COALESCE(SUM(LENGTH(message)),0) FROM notes WHERE task_id=${TASK_ID};" \
      2>>"$DEBUG_LOG")
    NOTES_COUNT=$(echo "$NOTES_ROW" | cut -d'|' -f1)
    NOTES_LEN=$(echo "$NOTES_ROW" | cut -d'|' -f2)
    valid_int "$NOTES_COUNT" || exit 0
    valid_int "$NOTES_LEN" || exit 0

    # Thresholds
    COUNT_T=$(num_or_default "${SCOPE_DRIFT_NOTES_COUNT:-}" "$NOTES_COUNT_DEFAULT")
    LEN_MULT=$(num_or_default "${SCOPE_DRIFT_LEN_MULT:-}" "$LEN_MULT_DEFAULT")
    DESC_FLOOR=$(num_or_default "${SCOPE_DRIFT_DESC_FLOOR:-}" "$DESC_FLOOR_DEFAULT")

    DESC_BASE="$DESC_LEN"
    if [ "$DESC_BASE" -lt "$DESC_FLOOR" ] 2>/dev/null; then
      DESC_BASE="$DESC_FLOOR"
    fi
    LEN_T=$(( LEN_MULT * DESC_BASE ))

    TRIGGER=""
    if [ "$NOTES_COUNT" -ge "$COUNT_T" ] 2>/dev/null; then
      TRIGGER="count(${NOTES_COUNT}>=${COUNT_T})"
    elif [ "$NOTES_LEN" -ge "$LEN_T" ] 2>/dev/null; then
      TRIGGER="length(${NOTES_LEN}>=${LEN_T})"
    fi

    if [ -z "$TRIGGER" ]; then
      exit 0
    fi

    # Fire: stamp the rate limit, audit, emit the soft advisory.
    echo "$NOW" > "$STAMP_FILE" 2>/dev/null || true
    log_audit "$TASK_ID" "ADVISE" "trigger=$TRIGGER notes=$NOTES_COUNT len=$NOTES_LEN desc=$DESC_LEN"
    cat >&2 <<EOF
=== SCOPE-DRIFT ADVISORY (soft — nothing is blocked, your note already landed) ===
scope drift on #${TASK_ID} — consider splitting into a proper card (#1608->#13012 incident).
Signal: ${TRIGGER}. Card #${TASK_ID} has ${NOTES_COUNT} notes / ~${NOTES_LEN} chars of notes
against a ~${DESC_LEN}-char description. When notes substantially exceed the description,
the card is usually carrying work its description never scoped. If that matches here, ask
Boss for a proper card (or split it yourself if you own the lane). If this is a false
positive, ignore it — this advisory fires at most once per card per day.
Knobs: SCOPE_DRIFT_NOTES_COUNT=${COUNT_T} SCOPE_DRIFT_LEN_MULT=${LEN_MULT} SCOPE_DRIFT_DESC_FLOOR=${DESC_FLOOR}
Silence: SCOPE_DRIFT_BYPASS=1 per-call | SCOPE_DRIFT_HOOK_DISABLED=1 kill-switch
EOF
    exit 2
    ;;

  *)
    log_debug "unknown mode: '$MODE' — fail-open"
    exit 0
    ;;
esac
