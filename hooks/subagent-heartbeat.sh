#!/usr/bin/env bash
# subagent-heartbeat.sh — Telegram heartbeat relay for Claude Code sub-agents
#
# Modes (first arg):
#   start     — invoked from PreToolUse hook when the main thread calls the Agent tool.
#               Posts an initial "started" Telegram message and saves message_id in state.
#   tool-call — invoked from enforce-delegation.sh on the HAS_AGENT_ID branch for every
#               sub-agent tool call. Throttled edit of the pinned message (>=5s OR >=5 calls).
#   stop      — invoked from SubagentStop hook. Edits the pinned message to a done state
#               AND posts a NEW reply so the user gets a push notification.
#
# Stdin: the original hook JSON payload. For start mode we read tool_input.description.
# For tool-call/stop we read agent_id.
#
# Non-blocking: edits/replies fire via curl in background (&). Failures logged to
# ~/.claude/state/subagent-heartbeat/debug.log. Hook ALWAYS returns 0.
#
# State file: ~/.claude/state/subagent-heartbeat/{AGENT_LABEL}-{SUBAGENT_ID}.json
# Pending slot: ~/.claude/state/subagent-heartbeat/{AGENT_LABEL}-pending-{SESSION}.json
#
# Chat: $TELEGRAM_CHAT_ID if set, else fallback 1712539766 (GweiSprayer DM).

set -u

MODE="${1:-}"
STATE_DIR="$HOME/.claude/state/subagent-heartbeat"
DEBUG_LOG="$STATE_DIR/debug.log"
LOCK_DIR="$STATE_DIR/locks"

mkdir -p "$STATE_DIR" "$LOCK_DIR" 2>/dev/null

log() {
  local ts
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '%s [%s] %s\n' "$ts" "${MODE:-?}" "$*" >> "$DEBUG_LOG" 2>/dev/null
}

# Always-success wrapper — never propagate failures to the caller hook.
trap 'exit 0' EXIT

CHAT_ID="${TELEGRAM_CHAT_ID:-1712539766}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

if [ -z "$BOT_TOKEN" ]; then
  log "no TELEGRAM_BOT_TOKEN — skipping"
  exit 0
fi

# Read stdin JSON payload once (if any)
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat 2>/dev/null || true)
fi

json_get() {
  local field="$1"
  [ -z "$STDIN_DATA" ] && { printf ''; return; }
  printf '%s' "$STDIN_DATA" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
def walk(obj, k):
    if isinstance(obj, dict):
        if k in obj and obj[k] is not None:
            v = obj[k]
            if isinstance(v, (str, int, float, bool)):
                print(v); return True
        for v in obj.values():
            if walk(v, k): return True
    elif isinstance(obj, list):
        for v in obj:
            if walk(v, k): return True
    return False
walk(d, '${field}')
" 2>/dev/null
}

payload_tool_name() {
  [ -z "$STDIN_DATA" ] && { printf ''; return; }
  printf '%s' "$STDIN_DATA" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for k in ('tool_name','name'):
    v = d.get(k) if isinstance(d, dict) else None
    if v: print(v); sys.exit(0)
t = d.get('tool') if isinstance(d, dict) else None
if isinstance(t, dict):
    for k in ('name','tool_name'):
        if t.get(k): print(t[k]); sys.exit(0)
" 2>/dev/null
}

payload_agent_description() {
  [ -z "$STDIN_DATA" ] && { printf ''; return; }
  printf '%s' "$STDIN_DATA" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = {}
if isinstance(d, dict):
    ti = d.get('tool_input') or d.get('input') or {}
    if not ti and isinstance(d.get('tool'), dict):
        ti = d['tool'].get('input') or {}
desc = ''
if isinstance(ti, dict):
    desc = ti.get('description') or ti.get('prompt') or ti.get('task') or ''
    if not desc:
        p = ti.get('parameters') or {}
        if isinstance(p, dict):
            desc = p.get('description') or p.get('prompt') or ''
print((desc or '')[:200])
" 2>/dev/null
}

sha1_short() {
  printf '%s' "$1" | shasum 2>/dev/null | cut -c1-12
}

with_lock() {
  local key="$1"; shift
  local lock="$LOCK_DIR/$(sha1_short "$key").lock"
  local tries=0
  while ! mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 25 ]; then
      log "lock timeout for $key"
      return 1
    fi
    python3 -c "import time; time.sleep(0.1)" 2>/dev/null || sleep 1
  done
  "$@"
  local rc=$?
  rmdir "$lock" 2>/dev/null
  return $rc
}

tg_send_message() {
  local text="$1"
  local resp
  resp=$(curl -sS --max-time 8 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" 2>>"$DEBUG_LOG")
  [ -z "$resp" ] && { log "send empty resp"; return 1; }
  local mid
  mid=$(printf '%s' "$resp" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    if d.get('ok'): print(d['result']['message_id'])
except Exception: pass" 2>/dev/null)
  [ -z "$mid" ] && { log "send no mid resp=$(printf '%s' "$resp" | head -c 200)"; return 1; }
  printf '%s\n' "$mid"
}

tg_edit_message() {
  local mid="$1"; local text="$2"
  (
    curl -sS --max-time 8 \
      -X POST "https://api.telegram.org/bot${BOT_TOKEN}/editMessageText" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "message_id=${mid}" \
      --data-urlencode "text=${text}" \
      --data-urlencode "disable_web_page_preview=true" \
      >>"$DEBUG_LOG" 2>&1
  ) &
  disown 2>/dev/null || true
}

tg_send_reply() {
  local reply_to="$1"; local text="$2"
  (
    curl -sS --max-time 8 \
      -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "reply_to_message_id=${reply_to}" \
      --data-urlencode "text=${text}" \
      --data-urlencode "disable_web_page_preview=true" \
      >>"$DEBUG_LOG" 2>&1
  ) &
  disown 2>/dev/null || true
}

trunc() {
  local s="$1"; local n="${2:-200}"
  local len=${#s}
  if [ "$len" -le "$n" ]; then printf '%s' "$s"
  else printf '%s...' "${s:0:$((n - 3))}"
  fi
}

state_file_for() {
  local sub_id="$1"
  local label="${AGENT_LABEL:-unknown}"
  local safe_label safe_sub
  safe_label=$(printf '%s' "$label" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null)
  safe_sub=$(printf '%s' "$sub_id" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null)
  printf '%s/%s-%s.json' "$STATE_DIR" "$safe_label" "$safe_sub"
}

pending_state_file() {
  local label="${AGENT_LABEL:-unknown}"
  local session="${CLAUDE_SESSION_ID:-$$}"
  local safe_label safe_sess
  safe_label=$(printf '%s' "$label" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null)
  safe_sess=$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null)
  printf '%s/%s-pending-%s.json' "$STATE_DIR" "$safe_label" "$safe_sess"
}

# ---------------- MODES ----------------

case "$MODE" in

  start)
    DESC=$(payload_agent_description)
    [ -z "$DESC" ] && DESC="(no description)"
    DESC_PREVIEW=$(trunc "$DESC" 180)

    NOW=$(date +%s)
    LABEL="${AGENT_LABEL:-unknown}"
    TEXT="🟢 ${LABEL} spawned sub-agent: ${DESC_PREVIEW}"
    TEXT=$(trunc "$TEXT" 280)

    MID=$(tg_send_message "$TEXT")
    [ -z "$MID" ] && { log "start: no message_id"; exit 0; }

    PFILE=$(pending_state_file)
    PREVIEW_JSON=$(printf '%s' "$DESC_PREVIEW" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
    python3 -c "
import json
d = {
    'chat_id': ${CHAT_ID},
    'message_id': ${MID},
    'counter': 0,
    'counter_at_last_edit': 0,
    'last_edit_ts': ${NOW},
    'started_at': ${NOW},
    'task_preview': ${PREVIEW_JSON},
    'last_tool': ''
}
with open('${PFILE}', 'w') as f:
    json.dump(d, f)
" 2>>"$DEBUG_LOG"
    log "start: posted mid=${MID} pending=${PFILE}"
    exit 0
    ;;

  tool-call)
    AID=$(json_get agent_id)
    [ -z "$AID" ] && { log "tool-call: no agent_id"; exit 0; }

    SFILE=$(state_file_for "$AID")

    if [ ! -f "$SFILE" ]; then
      PFILE=$(pending_state_file)
      if [ -f "$PFILE" ]; then
        mv "$PFILE" "$SFILE" 2>/dev/null && log "tool-call: claimed pending for ${AID}"
      fi
    fi

    [ ! -f "$SFILE" ] && { log "tool-call: no state for ${AID}"; exit 0; }

    TOOL=$(payload_tool_name)
    [ -z "$TOOL" ] && TOOL="unknown"
    NOW=$(date +%s)

    # Compute edit decision inside python, write back atomically
    OUTFILE="$LOCK_DIR/$(sha1_short "$SFILE").out"
    : > "$OUTFILE" 2>/dev/null

    with_lock "$SFILE" python3 <<PY 2>>"$DEBUG_LOG"
import json, os, sys
sfile = "${SFILE}"
now = ${NOW}
tool = """${TOOL}"""
label = """${AGENT_LABEL:-unknown}"""
aid = """${AID}"""
outfile = "${OUTFILE}"

try:
    with open(sfile) as f: d = json.load(f)
except Exception:
    sys.exit(0)

d["counter"] = d.get("counter", 0) + 1
d["last_tool"] = tool
since_edit = now - d.get("last_edit_ts", 0)
calls_since = d["counter"] - d.get("counter_at_last_edit", 0)
should_edit = since_edit >= 5 or calls_since >= 5

if should_edit:
    d["last_edit_ts"] = now
    d["counter_at_last_edit"] = d["counter"]

with open(sfile, "w") as f:
    json.dump(d, f)

if should_edit:
    elapsed = now - d.get("started_at", now)
    mins = elapsed // 60
    secs = elapsed % 60
    preview = d.get("task_preview", "")
    short_aid = aid[:12]
    text = f"🔄 {label}/{short_aid}: {tool} (#{d['counter']}, {mins}m{secs}s)\n{preview}"
    if len(text) > 290:
        text = text[:287] + "..."
    mid = d.get("message_id")
    with open(outfile, "w") as f:
        f.write(f"{mid}\t{text}")
PY

    if [ -s "$OUTFILE" ]; then
      EMID=$(cut -f1 "$OUTFILE")
      ETEXT=$(cut -f2- "$OUTFILE")
      rm -f "$OUTFILE"
      if [ -n "$EMID" ] && [ -n "$ETEXT" ]; then
        tg_edit_message "$EMID" "$ETEXT"
        log "tool-call: edit fired mid=${EMID}"
      fi
    fi
    exit 0
    ;;

  stop)
    AID=$(json_get agent_id)
    [ -z "$AID" ] && { log "stop: no agent_id"; exit 0; }

    SFILE=$(state_file_for "$AID")

    if [ ! -f "$SFILE" ]; then
      PFILE=$(pending_state_file)
      [ -f "$PFILE" ] && mv "$PFILE" "$SFILE" 2>/dev/null
    fi

    [ ! -f "$SFILE" ] && { log "stop: no state for ${AID}"; exit 0; }

    read_field() {
      python3 -c "
import json, sys
try:
    d=json.load(open('${SFILE}'))
    print(d.get('$1',''))
except Exception: pass
" 2>/dev/null
    }

    MID=$(read_field message_id)
    COUNTER=$(read_field counter)
    [ -z "$COUNTER" ] && COUNTER=0
    STARTED_AT=$(read_field started_at)
    [ -z "$STARTED_AT" ] && STARTED_AT=$(date +%s)
    PREVIEW=$(read_field task_preview)

    NOW=$(date +%s)
    ELAPSED=$((NOW - STARTED_AT))
    MINS=$((ELAPSED / 60))
    SECS=$((ELAPSED % 60))
    LABEL="${AGENT_LABEL:-unknown}"
    SHORT_AID="${AID:0:12}"

    DONE_TEXT="✅ ${LABEL}/${SHORT_AID} done (${COUNTER} tool calls, ${MINS}m${SECS}s)"
    [ -n "$PREVIEW" ] && DONE_TEXT="${DONE_TEXT}
${PREVIEW}"
    DONE_TEXT=$(trunc "$DONE_TEXT" 290)

    if [ -n "$MID" ]; then
      tg_edit_message "$MID" "$DONE_TEXT"
      tg_send_reply "$MID" "✅ done: ${COUNTER} tool calls in ${MINS}m${SECS}s"
      log "stop: finalized mid=${MID}"
    else
      log "stop: no message_id in state"
    fi

    rm -f "$SFILE" 2>/dev/null
    exit 0
    ;;

  *)
    log "unknown mode: $MODE"
    exit 0
    ;;
esac
