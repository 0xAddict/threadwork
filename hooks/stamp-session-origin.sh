#!/usr/bin/env bash
# stamp-session-origin.sh — writes the session-origin stamp the CDP gate reads.
#
# Called by the Telegram MCP plugin (server.ts) when an inbound Telegram
# message is about to be delivered to an agent, BEFORE mcp.notification().
# It records which Telegram chat_id initiated the agent's current work, so the
# CDP gate can tell a Coach-Stokes-originated session from a GweiSprayer one.
#
# Usage:  stamp-session-origin.sh <agent_label> <chat_id> [user_id]
#
# Writes ~/.claude/state/tg-session-origin/<agent>.json with a TTL.
# TTL via CDP_ORIGIN_TTL_SEC (default 1800s).

set -uo pipefail

AGENT="${1:-}"
CHAT_ID="${2:-}"
USER_ID="${3:-$CHAT_ID}"

[ -z "$AGENT" ] && { echo "stamp-session-origin: missing agent label" >&2; exit 1; }
[ -z "$CHAT_ID" ] && { echo "stamp-session-origin: missing chat_id" >&2; exit 1; }

ORIGIN_DIR="${CDP_ORIGIN_DIR:-$HOME/.claude/state/tg-session-origin}"
TTL="${CDP_ORIGIN_TTL_SEC:-1800}"
mkdir -p "$ORIGIN_DIR"

NOW="$(date '+%s')"
EXP=$((NOW + TTL))

# Atomic write via temp + mv.
TMP="$ORIGIN_DIR/.${AGENT}.json.tmp.$$"
cat > "$TMP" <<EOF
{"chat_id": ${CHAT_ID}, "user_id": ${USER_ID}, "stamped_at": ${NOW}, "expires_at": ${EXP}}
EOF
mv "$TMP" "$ORIGIN_DIR/${AGENT}.json"
