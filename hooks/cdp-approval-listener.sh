#!/usr/bin/env bash
# cdp-approval-listener.sh — background daemon for the CDP gate.
#
# Polls Telegram getUpdates for callback_query taps on the Approve/Reject
# inline buttons cdp-gate.sh posts. On Approve it writes the single-use unlock
# marker the gate consumes; on Reject it writes a rejection marker.
#
# Single-instance via a pidfile. Expires stale pending requests after 15 min.
#
# Token resolution order (memory #611):
#   $TELEGRAM_CDP_BOT_TOKEN -> $TELEGRAM_BOT_TOKEN
#   -> ~/.claude/channels/telegram/cdp/.env -> ~/.claude/channels/telegram/boss/.env
#
# NOTE: inline-button callbacks require a bot whose getUpdates this process
# owns. If you reuse the main plugin's bot token you WILL get HTTP 409
# (getUpdates conflict) — see INSTALL.md. The recommended path is a dedicated
# CDP bot, but the gate itself does not require the listener to be running:
# with no listener, every Coach-origin code change simply stays blocked until
# GweiSprayer relaxes it manually (fail-closed, which is the desired default).

set -uo pipefail

STATE_DIR="${CDP_STATE_DIR:-/tmp/cdp-state}"
ORIGIN_TTL=900   # 15 min pending expiry
PIDFILE="$STATE_DIR/listener.pid"
COACH_CHAT_ID=7657065545

mkdir -p "$STATE_DIR/unlocks" "$STATE_DIR/rejected" "$STATE_DIR/pending" "$STATE_DIR/consumed"

# ── Single-instance guard ─────────────────────────────────────────────────────
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "cdp-approval-listener already running (pid $(cat "$PIDFILE"))." >&2
  exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# ── Resolve bot token ─────────────────────────────────────────────────────────
resolve_token() {
  [ -n "${TELEGRAM_CDP_BOT_TOKEN:-}" ] && { echo "$TELEGRAM_CDP_BOT_TOKEN"; return; }
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ]     && { echo "$TELEGRAM_BOT_TOKEN"; return; }
  for env in "$HOME/.claude/channels/telegram/cdp/.env" \
             "$HOME/.claude/channels/telegram/boss/.env"; do
    if [ -f "$env" ]; then
      local t; t="$(grep -E '^TELEGRAM(_CDP)?_BOT_TOKEN=' "$env" | head -1 | cut -d= -f2-)"
      [ -n "$t" ] && { echo "$t"; return; }
    fi
  done
  echo ""
}
BOT_TOKEN="$(resolve_token)"
if [ -z "$BOT_TOKEN" ]; then
  echo "cdp-approval-listener: no bot token resolved — exiting." >&2
  exit 1
fi
API="https://api.telegram.org/bot${BOT_TOKEN}"

session_hash_for_coach() {
  # The gate hashes AGENT_LABEL|chat_id. The listener cannot know which agent
  # without it being encoded in the callback_data, so cdp-gate.sh embeds the
  # request_id (which starts with the session hash) in callback_data.
  printf '%s' "$1"
}

expire_stale_pending() {
  local now; now="$(date '+%s')"
  for f in "$STATE_DIR"/pending/*.json; do
    [ -f "$f" ] || continue
    local ts; ts="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("ts",0))' "$f" 2>/dev/null || echo 0)"
    [ $((now - ts)) -gt "$ORIGIN_TTL" ] && rm -f "$f"
  done
}

echo "cdp-approval-listener started (pid $$)."
OFFSET=0
while true; do
  expire_stale_pending
  RESP="$(curl -fsS --max-time 35 \
    "${API}/getUpdates?timeout=30&offset=${OFFSET}&allowed_updates=%5B%22callback_query%22%5D" \
    2>/dev/null || echo '{}')"

  # Parse each callback_query: update_id, callback id, data, message id/chat.
  echo "$RESP" | python3 - "$STATE_DIR" <<'PY'
import json, sys, os, time
state = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
maxoff = 0
for upd in data.get("result", []):
    maxoff = max(maxoff, upd.get("update_id", 0))
    cq = upd.get("callback_query")
    if not cq:
        continue
    payload = cq.get("data", "")          # e.g. cdp_approve:<request_id>
    if ":" not in payload:
        continue
    action, req_id = payload.split(":", 1)
    sess_hash = req_id.split("-", 1)[0]   # request_id = <hash>-<ts>-<pid>
    if action == "cdp_approve":
        open(os.path.join(state, "unlocks", f"{sess_hash}.ok"), "w").close()
    elif action == "cdp_reject":
        open(os.path.join(state, "rejected", f"{req_id}.rej"), "w").close()
    # consume the pending marker
    p = os.path.join(state, "pending", f"{req_id}.json")
    if os.path.exists(p):
        os.remove(p)
if maxoff:
    with open(os.path.join(state, ".offset"), "w") as f:
        f.write(str(maxoff + 1))
PY

  [ -f "$STATE_DIR/.offset" ] && OFFSET="$(cat "$STATE_DIR/.offset")"
done
