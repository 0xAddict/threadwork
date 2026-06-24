#!/usr/bin/env bash
# sycophant-gate.sh — PreToolUse hook on mcp__plugin_telegram_telegram__reply
#
# Purpose: Block sycophant/coaching-tone replies destined for Stokes
# (chat_id 7657065545). All other chat_ids pass through immediately.
#
# Gates (applied in order, Stokes-only):
#   Gate 1 (chat-id filter): if chat_id != 7657065545 → exit 0 (allow)
#   Gate 2 (sycophant openers, REJECT): forbidden opener phrases
#   Gate 3 (book mention without refusal, REJECT): book words without #1890 phrasing
#   Gate 4 (long reply without plan citation, REJECT): >5 lines, no plan clause
#   Gate 5 (allow): everything else → exit 0
#
# Exit codes:
#   0  = allow (proceed)
#   2  = block (Claude Code PreToolUse hook block protocol)
#
# Bypass:
#   SYCOPHANT_GATE_BYPASS=1   hard bypass — exit 0 immediately (break-glass)
#   SYCOPHANT_GATE_DISABLED=1 global kill-switch
#
# Logs:
#   ~/.claude/state/sycophant-gate/debug.log
#   ~/.claude/state/sycophant-gate/bypass.log
#   ~/.claude/state/sycophant-gate/audit.log

set -u

STATE_DIR="$HOME/.claude/state/sycophant-gate"
DEBUG_LOG="$STATE_DIR/debug.log"
BYPASS_LOG="$STATE_DIR/bypass.log"
AUDIT_LOG="$STATE_DIR/audit.log"

mkdir -p "$STATE_DIR" 2>/dev/null || true

STOKES_CHAT_ID="7657065545"

log_debug() {
  echo "$(date -u +%FT%TZ) $*" >> "$DEBUG_LOG" 2>/dev/null || true
}

log_audit() {
  echo "$(date -u +%FT%TZ) verdict=${1:-?} reason=${2:-} chat=${3:-?}" \
    >> "$AUDIT_LOG" 2>/dev/null || true
}

# --- Kill-switch / bypass ------------------------------------------------------

if [ "${SYCOPHANT_GATE_DISABLED:-}" = "1" ]; then
  echo "$(date -u +%FT%TZ) DISABLED" >> "$BYPASS_LOG" 2>/dev/null || true
  exit 0
fi

if [ "${SYCOPHANT_GATE_BYPASS:-}" = "1" ]; then
  echo "$(date -u +%FT%TZ) BYPASS (SYCOPHANT_GATE_BYPASS=1)" >> "$BYPASS_LOG" 2>/dev/null || true
  exit 0
fi

# --- Read stdin (hook JSON) ---------------------------------------------------

STDIN_DATA=$(cat)

# Extract tool_name — only fire on telegram reply
TOOL_NAME=$(python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get("tool_name", ""))
except Exception:
    pass
' 2>/dev/null <<< "$STDIN_DATA")

if [ "$TOOL_NAME" != "mcp__plugin_telegram_telegram__reply" ]; then
  exit 0
fi

# Extract chat_id and text from tool_input
CHAT_ID=$(python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
    ti = data.get("tool_input", {}) or {}
    print(str(ti.get("chat_id", "")))
except Exception:
    pass
' 2>/dev/null <<< "$STDIN_DATA")

TEXT=$(python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
    ti = data.get("tool_input", {}) or {}
    print(ti.get("text", ""))
except Exception:
    pass
' 2>/dev/null <<< "$STDIN_DATA")

# --- Gate 1: chat-id filter --------------------------------------------------
# Only Stokes-facing replies are gated. All others pass through.

if [ "$CHAT_ID" != "$STOKES_CHAT_ID" ]; then
  log_audit "ALLOW" "non-stokes-chat" "$CHAT_ID"
  exit 0
fi

# From here: we're replying to Stokes (chat_id 7657065545).

# Helper: flag with reason
# Default mode: ADVISORY (warn on stderr, allow through with exit 0).
# Set SYCOPHANT_GATE_MODE=block to restore PreToolUse hard-block (exit 2).
# Converted to advisory 2026-05-29 after Boss caught false-positive on legitimate
# on-plan audiobook mention (Epic 1.2). Detection logic preserved; verdict softened.
reject() {
  local reason="$1"
  local mode="${SYCOPHANT_GATE_MODE:-advisory}"

  if [ "$mode" = "block" ]; then
    log_audit "REJECT" "$reason" "$CHAT_ID"
    cat >&2 << REJECT_EOF
SYCOPHANT-GATE REJECT (mode=block): ${reason}

This reply to Stokes (chat_id ${STOKES_CHAT_ID}) was blocked by the mentor-stance gate.
Revise the reply to:
  - Remove sycophant/coaching openers
  - Reference a concrete plan clause (Pillar 1-4, Apollo, lead log, deliverable, premortem)
  - For book mentions: include the refusal phrasing (81 hours / opinion piece / shelved / Epic 1.2)

Bypass options:
  SYCOPHANT_GATE_BYPASS=1   break-glass bypass (logged)
  SYCOPHANT_GATE_DISABLED=1 global kill-switch
  SYCOPHANT_GATE_MODE=advisory  softer mode (default; warn but allow)

REJECT_EOF
    exit 2
  fi

  # Default: advisory mode — warn on stderr, allow through.
  log_audit "ADVISORY" "$reason" "$CHAT_ID"
  cat >&2 << ADVISORY_EOF
SYCOPHANT-GATE ADVISORY (mode=advisory, not blocking): ${reason}

Heuristic match on a reply to Stokes (chat_id ${STOKES_CHAT_ID}). Reply is NOT blocked
— the gate is advisory only after Boss demonstrated on 2026-05-29 that hard-block
caused false-positives on legitimate on-plan content (e.g., audiobook mentions where
the audiobook is Epic 1.2 of the signed plan).

Treat this as a flag: re-read your reply with the mentor-stance memories
(#1777/#1778/#1779/#1886/#1888/#1889/#1890/#1891/#1893) in mind. If the matched
phrase is genuinely sycophant/off-plan, revise. If it's legitimate (e.g., on-plan
book/audiobook reference, plan-anchored "three paths" enumeration, etc.), proceed.

Restore hard-block:
  SYCOPHANT_GATE_MODE=block  re-enable PreToolUse block (exit 2)

ADVISORY_EOF
  return 0
}

# --- Gate 2: sycophant openers (case-insensitive partial match) ---------------
# REJECT if text contains any of these phrases.

TEXT_LOWER=$(echo "$TEXT" | tr '[:upper:]' '[:lower:]')

if echo "$TEXT_LOWER" | grep -qi "smart partner thinking"; then
  reject "sycophant opener: 'smart partner thinking'"
fi

if echo "$TEXT_LOWER" | grep -qi "great insight"; then
  reject "sycophant opener: 'great insight'"
fi

if echo "$TEXT_LOWER" | grep -qi "let me validate"; then
  reject "sycophant opener: 'let me validate'"
fi

if echo "$TEXT_LOWER" | grep -qi "validate your instinct"; then
  reject "sycophant opener: 'validate your instinct'"
fi

if echo "$TEXT_LOWER" | grep -qi "three paths"; then
  reject "sycophant opener: 'three paths'"
fi

if echo "$TEXT_LOWER" | grep -qi "let me sequence"; then
  reject "sycophant opener: 'let me sequence'"
fi

if echo "$TEXT_LOWER" | grep -qi "compound moment"; then
  reject "sycophant opener: 'compound moment'"
fi

# --- Gate 3: book mention without #1890 refusal phrasing ---------------------
# REJECT if text matches book/audiobook/hardcover/KDP/ACX/voices.inaudio/seeds of movement
# AND text does NOT contain any of: 81 hours / opinion piece / shelved / Epic 1.2

if echo "$TEXT_LOWER" | grep -qiE "(book|audiobook|hardcover|kdp|acx|voices\.inaudio|seeds of movement)"; then
  # Book-related mention found — check for refusal phrasing
  if ! echo "$TEXT_LOWER" | grep -qiE "(81 hours|opinion piece|shelved|epic 1\.2)"; then
    reject "book mention without #1890 refusal phrasing (missing: '81 hours' OR 'opinion piece' OR 'shelved' OR 'Epic 1.2')"
  fi
fi

# --- Gate 4: long reply without plan citation --------------------------------
# REJECT if reply is >5 lines AND no plan clause cited

LINE_COUNT=$(printf '%s' "$TEXT" | wc -l)

if [ "$LINE_COUNT" -gt 5 ] 2>/dev/null; then
  if ! echo "$TEXT" | grep -qiE "(Pillar [1-4]|Apollo|lead log|deliverable|premortem)"; then
    reject "reply is ${LINE_COUNT} lines (>5) but cites no plan clause (Pillar 1-4 / Apollo / lead log / deliverable / premortem)"
  fi
fi

# --- Gate 5: allow -----------------------------------------------------------

log_audit "ALLOW" "passed-all-gates" "$CHAT_ID"
exit 0
