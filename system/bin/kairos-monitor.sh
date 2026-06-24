#!/usr/bin/env bash
# kairos-monitor.sh — Kairos productivity tracker, main 60s observation loop.
#
# Reconstructed 2026-05-17 via TDD (bats suite in ~/bin/kairos-tests/). The
# original was clobbered by the threadwork V1-A installer on 2026-05-12; no
# verbatim copy survived. Behavior is pinned by tests in monitor.bats and by
# evidence from ~/bin/kairos-launchd.log, ~/bin/kairos.log, and the surviving
# kairos-screenshot.py / kairos-infer.py interfaces.
#
# Resolved by the surviving kairos-screenshot.py source:
#   - screenshot.py does NOT upload — it captures locally, prints the path on
#     exit 0, or a status token ("locked"/"wallpaper_only"/"no_capture") on
#     exit 2 (locked/screensaver) or 3 (TCC denied / wallpaper-only). The
#     upload to Supabase Storage is therefore done HERE, by this wrapper.
#   - TCC / Screen-Recording denial surfaces as exit 3.
#
# Test-only env overrides (default to production values when unset):
#   KAIROS_BIN_DIR KAIROS_DB KAIROS_LOG KAIROS_SHOT_DIR
#   KAIROS_TICK_INTERVAL KAIROS_MAX_TICKS

set -uo pipefail

BIN_DIR="${KAIROS_BIN_DIR:-$HOME/bin}"
DB_PATH="${KAIROS_DB:-$HOME/bin/kairos.db}"
LOG_PATH="${KAIROS_LOG:-$HOME/bin/kairos.log}"
SHOT_DIR="${KAIROS_SHOT_DIR:-/tmp/kairos-screenshots}"
TICK_INTERVAL="${KAIROS_TICK_INTERVAL:-60}"
MAX_TICKS="${KAIROS_MAX_TICKS:-0}"   # 0 = run forever (production)

mkdir -p "$SHOT_DIR"

# Supabase Storage — key recovered verbatim (identical to kairos-eod-report.py).
SUPABASE_URL="https://nblnapyfcuotnmkmqvec.supabase.co"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY:-REPLACE_WITH_SUPABASE_SERVICE_KEY}"  # SCRUBBED: set via env/keychain (was hardcoded JWT)
SUPABASE_BUCKET="kairos-screenshots"

# Telegram — DEDICATED Kairos bot/channel (split out 2026-06-05 so Kairos
# screenshots stop flooding the main threadwork channel). Set KAIROS_TG_POST=1
# only once TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID below point at the dedicated bot.
# Until then KAIROS_TG_POST defaults to 0 = no Telegram posting (capture +
# Supabase upload + DB still run normally).
# 2026-06-05: dedicated Kairos bot = "Jake" / @APGbotbot (token from GweiSprayer)
# so screenshots land in a separate bot thread, not the main threadwork channel.
# Recipient stays GweiSprayer (REPLACE_WITH_TELEGRAM_CHAT_ID) — he must /start @APGbotbot once or
# Telegram blocks the bot from DMing him (sends 403 until then).
KAIROS_TG_POST="${KAIROS_TG_POST:-1}"
TELEGRAM_BOT_TOKEN="${KAIROS_TELEGRAM_BOT_TOKEN:-REPLACE_WITH_KAIROS_BOT_TOKEN}"  # SCRUBBED: set via env/keychain (was hardcoded)
TELEGRAM_CHAT_ID="${KAIROS_TELEGRAM_CHAT_ID:-REPLACE_WITH_TELEGRAM_CHAT_ID}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_PATH"
}

# Frontmost app name via System Events. The original logs show one corrupt line
# where a raw lsappinfo dict leaked; System Events returns a clean bare name.
active_app() {
  osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null \
    || echo "Unknown"
}

# Upload a usable capture to Supabase Storage; echo a signed URL on success.
upload_screenshot() {
  local local_path="$1"
  local objpath; objpath="$(date '+%Y/%m/%d')/$(basename "$local_path")"

  curl -fsS -X POST \
    "$SUPABASE_URL/storage/v1/object/$SUPABASE_BUCKET/$objpath" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Content-Type: image/webp" \
    --data-binary "@$local_path" >/dev/null 2>>"$LOG_PATH" || return 1

  local signed
  signed="$(curl -fsS -X POST \
    "$SUPABASE_URL/storage/v1/object/sign/$SUPABASE_BUCKET/$objpath" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"expiresIn":86400}' 2>>"$LOG_PATH" \
    | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin).get("signedURL",""))' 2>/dev/null)"
  [ -n "$signed" ] || return 1
  echo "${SUPABASE_URL}/storage/v1${signed}"
}

# Insert one observations row. Columns verbatim from the live DB schema.
record_observation() {
  local ts="$1" url="$2" app="$3" inf="$4"
  # Parameterized insert via python3 — values pass as argv (never interpolated
  # into SQL), so quotes/backslashes/newlines in the inference text can't break
  # the statement. Replaces the old sqlite3-CLI string-building, which failed
  # with "unrecognized token" on any inference containing a backslash. Returns
  # python's exit code so the caller can detect a real insert failure.
  /usr/bin/python3 - "$DB_PATH" "$ts" "$url" "$app" "$inf" <<'PY' 2>>"$LOG_PATH"
import sqlite3, sys
db, ts, url, app, inf = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
con = sqlite3.connect(db, timeout=10)
con.execute(
    "INSERT INTO observations (timestamp, screenshot_url, active_app, inference, reported)"
    " VALUES (?, ?, ?, ?, 0)",
    (ts, url, app, inf),
)
con.commit()
con.close()
PY
}

send_to_telegram() {
  local img="$1" caption="$2"
  log "Sending screenshot to Telegram..."
  if curl -fsS -X POST \
      "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendPhoto" \
      -F "chat_id=$TELEGRAM_CHAT_ID" -F "photo=@$img" -F "caption=$caption" \
      >/dev/null 2>>"$LOG_PATH"; then
    log "Photo sent to Telegram"
  else
    log "Telegram send failed"
  fi
}

log "Kairos monitor started. DB: $DB_PATH"
log "Starting main observation loop (tick interval: 60s)"

tick=0
while true; do
  now="$(date '+%Y-%m-%d %H:%M:%S')"
  log "Tick $tick — $now"

  app="$(active_app)"
  log "Active app: $app"

  shot="$SHOT_DIR/screen-$(date '+%Y%m%d-%H%M%S').webp"
  shot_out="$(/usr/bin/python3 "$BIN_DIR/kairos-screenshot.py" "$shot" 2>>"$LOG_PATH")"
  shot_rc=$?

  if [ "$shot_rc" -eq 2 ]; then
    # Exit 2: screen locked / screensaver / not on console.
    log "Capture skipped: session locked ($shot_out) — skipping tick"
  elif [ "$shot_rc" -eq 3 ]; then
    # Exit 3: wallpaper-only or screencapture denied (TCC). screenshot.py
    # already logged "Capture matches desktop wallpaper reference …".
    log "Capture skipped: wallpaper-only / screen-recording denied ($shot_out) — skipping tick"
  elif [ "$shot_rc" -ne 0 ]; then
    log "Capture failed (rc=$shot_rc) — skipping tick"
  else
    log "Screenshot saved: $shot"

    url=""
    if url="$(upload_screenshot "$shot")"; then
      log "Uploaded: $url"
    else
      log "Upload failed — recording observation without URL"
      url=""
    fi

    inference="$(/usr/bin/python3 "$BIN_DIR/kairos-infer.py" "$shot" "$app" 2>>"$LOG_PATH")"
    if [ -n "$inference" ]; then
      log "Inference: $inference"
    else
      inference="(inference unavailable)"
      log "Inference: (unavailable)"
    fi

    if record_observation "$now" "$url" "$app" "$inference"; then
      log "Logged to DB"
    else
      log "DB insert FAILED — observation not recorded"
    fi

    # Telegram push every 5th tick (~5 min), matching the original log cadence.
    # Gated by KAIROS_TG_POST so the dedicated-bot split can silence the main
    # channel without stopping capture/upload/DB.
    if [ "$KAIROS_TG_POST" = "1" ] && [ $((tick % 5)) -eq 0 ]; then
      send_to_telegram "$shot" "$inference"
    fi
  fi

  tick=$((tick + 1))
  if [ "$MAX_TICKS" -gt 0 ] && [ "$tick" -ge "$MAX_TICKS" ]; then
    break
  fi
  sleep "$TICK_INTERVAL"
done
