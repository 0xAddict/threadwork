#!/usr/bin/env bash
# cdp-gate.sh — CDP (Code Development Approval) gate.
#
# A PreToolUse shim invoked from enforce-delegation.sh with the hook JSON on
# stdin. Blocks code-modifying tool calls when the current Claude Code session
# was initiated by Coach Stokes (Telegram chat_id 7657065545), routing each
# request to GweiSprayer (chat_id 1712539766) for inline Approve/Reject.
#
# Exit 0 = allow the tool call.  Exit 2 = block (approval required).
#
# Source of truth: pinned task-board memory #611 (task #393). Rebuilt + extended
# 2026-05-19 via TDD (~/cdp-gate/tests/cdp-gate.bats). Extension vs the original:
# Bash is now DENY-BY-DEFAULT for Coach-origin sessions — only a conservative
# read-only allowlist passes; everything else blocks (fail-safe).
#
# Env overrides (default to production paths; tests inject hermetic dirs):
#   CDP_ORIGIN_DIR   tg-session-origin stamp dir
#   CDP_STATE_DIR    pending/unlocks/consumed/rejected marker dir
#   CDP_TELEGRAM_CMD command used to send the approval message
#   CDP_NOW          override "now" epoch (TTL tests)
#   CDP_GATE_DISABLED=1  kill switch — always exit 0
#   AGENT_LABEL      agent whose stamp is consulted

set -uo pipefail

COACH_CHAT_ID=7657065545
GWEI_CHAT_ID=1712539766

# Kill switch.
[ "${CDP_GATE_DISABLED:-0}" = "1" ] && exit 0

ORIGIN_DIR="${CDP_ORIGIN_DIR:-$HOME/.claude/state/tg-session-origin}"
STATE_DIR="${CDP_STATE_DIR:-/tmp/cdp-state}"
AGENT="${AGENT_LABEL:-unknown}"
NOW="${CDP_NOW:-$(date '+%s')}"

STDIN_DATA="$(cat)"

# ── Parse the tool name + command/path out of the hook JSON ───────────────────
TOOL="$(printf '%s' "$STDIN_DATA" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -z "$TOOL" ] && exit 0

# ── Which tools are code-modifying (candidates for gating)? ───────────────────
TOOL_IS_GATED=0
case "$TOOL" in
  Edit|Write|NotebookEdit|Bash) TOOL_IS_GATED=1 ;;
esac
# Read / Grep / Glob / task-board / telegram / everything else: never gated.
[ "$TOOL_IS_GATED" -eq 0 ] && exit 0

# ── Determine session origin from the stamp ───────────────────────────────────
# origin_class: "coach" | "other" | "absent" | "bad"
STAMP="$ORIGIN_DIR/${AGENT}.json"
origin_class="absent"
if [ -f "$STAMP" ]; then
  parsed="$(python3 - "$STAMP" "$NOW" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    chat = int(d.get("chat_id"))
    exp = d.get("expires_at")
    now = int(sys.argv[2])
    if exp is not None and int(exp) < now:
        print("expired")
    else:
        print(chat)
except Exception:
    print("bad")
PY
)"
  case "$parsed" in
    "")        origin_class="bad" ;;
    bad)       origin_class="bad" ;;
    expired)   origin_class="expired" ;;
    "$COACH_CHAT_ID") origin_class="coach" ;;
    *[!0-9]*)  origin_class="bad" ;;
    *)         origin_class="other" ;;
  esac
fi

# ── Decide whether THIS session is Stokes-gated ───────────────────────────────
# Allowed outright: an explicit non-Coach numeric stamp, or a genuine
# agent session that the caller marked as having no Telegram origin.
if [ "$origin_class" = "other" ]; then
  exit 0
fi
if [ "$origin_class" = "absent" ] && [ "${CDP_NO_STAMP_IS_AGENT:-0}" = "1" ]; then
  # enforce-delegation.sh sets CDP_NO_STAMP_IS_AGENT=1 when agent_id is present
  # (a sub-agent / non-Telegram session). Such sessions are not Coach-gated.
  exit 0
fi
# Everything else under a gated tool — coach / absent / bad / expired — is
# treated as Coach-gated and FAILS CLOSED. Only "other" passed above.

# ── Bash: deny-by-default. Only a conservative read-only allowlist passes. ────
if [ "$TOOL" = "Bash" ]; then
  CMD="$(printf '%s' "$STDIN_DATA" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get("tool_input",{}).get("command",""))
except Exception:
    print("")' 2>/dev/null)"

  # Any shell metacharacter that can mutate state -> block immediately.
  if printf '%s' "$CMD" | grep -qE '>|<<|\btee\b|\$\('; then
    :  # falls through to block
  else
    # Split on pipes / && / ; / || — every segment's leading command must be
    # on the read-only allowlist, else block.
    ALL_RO=1
    # Normalize separators to newlines.
    segs="$(printf '%s' "$CMD" | sed -E 's/\|\||&&|;|\|/\n/g')"
    while IFS= read -r seg; do
      [ -z "${seg// /}" ] && continue
      # First bare word of the segment.
      first="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//' | awk '{print $1}')"
      case "$first" in
        ls|cat|grep|egrep|fgrep|rg|ps|head|tail|find|echo|pwd|whoami|date|\
        wc|stat|file|which|env|printenv|uname|hostname|uptime|df|du|sort|uniq|\
        cut|awk|sed|sqlite3|jq|column|tr|less|more|basename|dirname|realpath|\
        true|test|\[)
          # awk/sed/sqlite3 are read-only ONLY if not mutating; -i / writes
          # were already excluded by the metachar check + the sed-i check below.
          ;;
        git)
          gsub="$(printf '%s' "$seg" | awk '{print $2}')"
          case "$gsub" in
            status|log|diff|show|branch|remote|rev-parse|describe|blame|\
            config|ls-files|shortlog|tag) ;;  # tag w/o args is read-ish; allow
            *) ALL_RO=0 ;;
          esac
          ;;
        *) ALL_RO=0 ;;
      esac
      # sed -i / perl -i are mutating even though sed is allowlisted.
      printf '%s' "$seg" | grep -qE '\bsed\b.*-i|\bperl\b.*-i' && ALL_RO=0
    done <<<"$segs"

    if [ "$ALL_RO" -eq 1 ]; then
      exit 0   # purely read-only bash — allow
    fi
  fi
  # else: not read-only -> block (fall through)
fi

# ── At this point: a gated, Coach-attributed, mutating call. ──────────────────
# Single-use unlock: if an Approve marker exists, consume it atomically (one
# atomic `mv` wins exactly once) and allow this single call.
SESSION_HASH="$(printf '%s' "${AGENT}|${COACH_CHAT_ID}" | shasum | cut -c1-16)"
mkdir -p "$STATE_DIR/unlocks" "$STATE_DIR/consumed" "$STATE_DIR/pending" 2>/dev/null
UNLOCK="$STATE_DIR/unlocks/${SESSION_HASH}.ok"
if [ -f "$UNLOCK" ]; then
  CONSUMED="$STATE_DIR/consumed/${SESSION_HASH}.$(date '+%s').$$"
  if mv "$UNLOCK" "$CONSUMED" 2>/dev/null; then
    exit 0   # consumed exactly one approval
  fi
fi

# ── Blocked: write a pending marker + post the Telegram approval request. ─────
REQ_ID="${SESSION_HASH}-$(date '+%s')-$$"
PENDING="$STATE_DIR/pending/${REQ_ID}.json"
{
  printf '{"request_id":"%s","agent":"%s","tool":"%s","ts":%s}\n' \
    "$REQ_ID" "$AGENT" "$TOOL" "$NOW"
} > "$PENDING" 2>/dev/null

TG_CMD="${CDP_TELEGRAM_CMD:-}"
MSG="CDP gate: ${AGENT} wants to run ${TOOL} (Coach Stokes origin). Approve?"
if [ -n "$TG_CMD" ]; then
  "$TG_CMD" "$GWEI_CHAT_ID" "$MSG" "$REQ_ID" >/dev/null 2>&1 || true
fi

echo "CDP gate: ${TOOL} blocked — Coach Stokes origin. Approval request sent to GweiSprayer (req ${REQ_ID})." >&2
exit 2
