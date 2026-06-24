#!/usr/bin/env bash
# stokes-reply-watcher.sh — Dumb cron forwarder: Stokes inbound TG messages → GweiSprayer
# Reads Boss session transcripts on disk (NEVER calls getUpdates).
# Runs every 60s via launchd com.threadwork.stokes-reply-watcher.
# Forwards each new Stokes (chat_id REPLACE_WITH_TELEGRAM_CHAT_ID) message to GweiSprayer (REPLACE_WITH_TELEGRAM_CHAT_ID).
set -o pipefail

# ─── Constants ───────────────────────────────────────────────────────────────
STOKES_CHAT_ID="REPLACE_WITH_TELEGRAM_CHAT_ID"
GWEI_CHAT_ID="REPLACE_WITH_TELEGRAM_CHAT_ID"
TRANSCRIPT_BASE="/Users/coachstokes/.claude/projects/-"
STATE_DIR="/Users/coachstokes/.claude/state/stokes-reply-watcher"
WATERMARK_FILE="$STATE_DIR/watermark"
SEEN_FILE="$STATE_DIR/seen_message_ids"
LOG_FILE="$STATE_DIR/watcher.log"
TOKEN_FILE="$STATE_DIR/bot_token"

# ─── Setup ───────────────────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

# ─── Load token (never log it) ───────────────────────────────────────────────
if [[ ! -f "$TOKEN_FILE" ]]; then
    log "ERROR: bot_token file missing at $TOKEN_FILE — aborting"
    exit 1
fi
BOT_TOKEN="$(cat "$TOKEN_FILE")"
if [[ -z "$BOT_TOKEN" ]]; then
    log "ERROR: bot_token file is empty — aborting"
    exit 1
fi

# ─── Watermark: initialize to now if missing, then exit (no backfill) ────────
if [[ ! -f "$WATERMARK_FILE" ]]; then
    INIT_TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    echo "$INIT_TS" > "$WATERMARK_FILE"
    log "INIT: watermark initialized to $INIT_TS — no backfill, exiting"
    exit 0
fi

WATERMARK="$(cat "$WATERMARK_FILE" | tr -d '[:space:]')"
if [[ -z "$WATERMARK" ]]; then
    log "ERROR: watermark file is empty — reinitializing to now, no backfill"
    echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$WATERMARK_FILE"
    exit 0
fi

log "RUN: watermark=$WATERMARK"

# ─── Load seen message IDs ────────────────────────────────────────────────────
touch "$SEEN_FILE"

# ─── Scan recent transcript files (modified in last 24h) ─────────────────────
# We also include files from the past 25h to handle slight timing edge cases.
FORWARDED=0
MAX_TS="$WATERMARK"

# find jsonl files modified in last 25 hours (1500 min), collect into a temp file list
# Using a temp file to avoid bash 3.2 mapfile incompatibility on macOS
FILE_LIST_TMP="$STATE_DIR/_file_list.txt"
find "$TRANSCRIPT_BASE" -name "*.jsonl" -mmin -1500 2>/dev/null | sort > "$FILE_LIST_TMP"
FILE_COUNT=$(wc -l < "$FILE_LIST_TMP" | tr -d ' ')

log "SCAN: checking $FILE_COUNT recently-modified jsonl files"

if [[ "$FILE_COUNT" -eq 0 ]]; then
    log "RUN: no recent jsonl files found — nothing to do"
    rm -f "$FILE_LIST_TMP"
    exit 0
fi

# Parse messages using python3 (handles JSON safely)
# Pass the file list via a temp file to avoid arg list limits
python3 - "$WATERMARK" "$STOKES_CHAT_ID" "$FILE_LIST_TMP" <<'PYEOF'
import sys, json, re, os

watermark = sys.argv[1]
stokes_id = sys.argv[2]
file_list_path = sys.argv[3]

# Read file list from temp file (avoids arg list limits)
with open(file_list_path) as fl:
    files = [line.strip() for line in fl if line.strip()]

state_dir = "/Users/coachstokes/.claude/state/stokes-reply-watcher"
seen_file = os.path.join(state_dir, "seen_message_ids")
output_file = os.path.join(state_dir, "_pending_forwards.jsonl")

# Load seen message IDs
seen_ids = set()
try:
    with open(seen_file) as f:
        seen_ids = set(line.strip() for line in f if line.strip())
except FileNotFoundError:
    pass

# channel block pattern
# <channel source="plugin:telegram:telegram" chat_id="REPLACE_WITH_TELEGRAM_CHAT_ID" message_id="NNN" user="REPLACE_WITH_TELEGRAM_CHAT_ID" user_id="REPLACE_WITH_TELEGRAM_CHAT_ID" ts="ISO8601">TEXT</channel>
CHANNEL_PAT = re.compile(
    r'<channel\s+source="[^"]*telegram[^"]*"\s+chat_id="' + re.escape(stokes_id) + r'"\s+message_id="(\d+)"\s+[^>]*?ts="([^"]+)"[^>]*>(.*?)</channel>',
    re.DOTALL
)

def ts_gt(ts_a, ts_b):
    """Return True if ts_a > ts_b (ISO8601 string comparison works for UTC)"""
    return ts_a > ts_b

new_messages = []  # list of (ts, message_id, text)

for filepath in files:
    try:
        with open(filepath, 'r', errors='replace') as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Only process user-role messages
                msg = obj.get('message', {})
                if not isinstance(msg, dict):
                    continue
                if msg.get('role') != 'user':
                    continue

                # Extract text content
                content = msg.get('content', '')
                if isinstance(content, list):
                    text_parts = []
                    for item in content:
                        if isinstance(item, dict):
                            if item.get('type') == 'text':
                                text_parts.append(item.get('text', ''))
                            elif item.get('type') == 'tool_result':
                                sub_content = item.get('content', '')
                                if isinstance(sub_content, list):
                                    for sc in sub_content:
                                        if isinstance(sc, dict) and sc.get('type') == 'text':
                                            text_parts.append(sc.get('text', ''))
                                elif isinstance(sub_content, str):
                                    text_parts.append(sub_content)
                    content = ' '.join(text_parts)
                elif not isinstance(content, str):
                    continue

                if stokes_id not in content:
                    continue

                # Find all channel blocks from Stokes in this content
                for m in CHANNEL_PAT.finditer(content):
                    msg_id = m.group(1)
                    ts = m.group(2)
                    text = m.group(3).strip()

                    # Skip if already seen (dedup by message_id)
                    if msg_id in seen_ids:
                        continue

                    # Skip if ts <= watermark
                    if not ts_gt(ts, watermark):
                        continue

                    new_messages.append((ts, msg_id, text))
                    seen_ids.add(msg_id)

    except Exception as e:
        sys.stderr.write(f"WARNING: error reading {filepath}: {e}\n")

# Deduplicate by message_id (keep first occurrence by ts)
seen_in_batch = set()
deduped = []
for (ts, msg_id, text) in new_messages:
    if msg_id not in seen_in_batch:
        seen_in_batch.add(msg_id)
        deduped.append((ts, msg_id, text))

# Sort by ts ascending so we forward in order
deduped.sort(key=lambda x: x[0])

# Write pending forwards
with open(output_file, 'w') as f:
    for (ts, msg_id, text) in deduped:
        f.write(json.dumps({"ts": ts, "message_id": msg_id, "text": text}) + "\n")

print(f"FOUND:{len(deduped)}")
PYEOF

PARSE_RC=$?
rm -f "$FILE_LIST_TMP"

if [[ $PARSE_RC -ne 0 ]]; then
    log "ERROR: python3 parser exited with $PARSE_RC"
    exit 1
fi

PENDING_FILE="$STATE_DIR/_pending_forwards.jsonl"

if [[ ! -f "$PENDING_FILE" ]]; then
    log "RUN: no pending file produced — nothing to forward"
    exit 0
fi

# Count pending
PENDING_COUNT=$(wc -l < "$PENDING_FILE" | tr -d ' ')
log "PENDING: $PENDING_COUNT new messages to forward"

if [[ "$PENDING_COUNT" -eq 0 ]]; then
    rm -f "$PENDING_FILE"
    exit 0
fi

# ─── Forward each pending message ────────────────────────────────────────────
TG_API="https://api.telegram.org/bot${BOT_TOKEN}/sendMessage"

while IFS= read -r line; do
    MSG_ID=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['message_id'])")
    TS=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['ts'])")
    TEXT=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['text'])")

    FORWARD_TEXT="📥 Stokes replied (${TS}):

${TEXT}"

    # Send to Gwei — do NOT log the token
    RESPONSE=$(curl -s -X POST "$TG_API" \
        -H "Content-Type: application/json" \
        -d "$(python3 -c "
import json, sys
payload = {
    'chat_id': '${GWEI_CHAT_ID}',
    'text': sys.stdin.read(),
    'parse_mode': 'HTML'
}
print(json.dumps(payload))
" <<< "$FORWARD_TEXT")" 2>/dev/null)

    TG_OK=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok','false'))" 2>/dev/null)
    TG_MSG_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('message_id','?'))" 2>/dev/null)

    if [[ "$TG_OK" == "True" ]] || [[ "$TG_OK" == "true" ]]; then
        log "FORWARDED: stokes_msg_id=$MSG_ID ts=$TS tg_result_msg_id=$TG_MSG_ID"
        # Record message_id as seen
        echo "$MSG_ID" >> "$SEEN_FILE"
        # Update MAX_TS
        if [[ "$TS" > "$MAX_TS" ]]; then
            MAX_TS="$TS"
        fi
        FORWARDED=$((FORWARDED + 1))
    else
        log "ERROR: sendMessage failed for stokes_msg_id=$MSG_ID ts=$TS response=$(echo "$RESPONSE" | head -c 200)"
    fi

done < "$PENDING_FILE"

rm -f "$PENDING_FILE"

# ─── Advance watermark ────────────────────────────────────────────────────────
if [[ "$MAX_TS" != "$WATERMARK" ]]; then
    echo "$MAX_TS" > "$WATERMARK_FILE"
    log "WATERMARK: advanced to $MAX_TS"
fi

log "DONE: forwarded=$FORWARDED"
