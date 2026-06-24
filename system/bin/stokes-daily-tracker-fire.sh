#!/bin/bash
# stokes-daily-tracker-fire.sh — daily wake prompt for Stokes productivity check-in
#
# Invoked by launchd at 20:30 EEST daily.
# Presence-checks (Kairos staleness, TipTap activity, GAM calendar) before firing.
# Sends a Pillar-deliverable-enumerated prompt to Stokes (TG chat REPLACE_WITH_TELEGRAM_CHAT_ID).
# Records prompt_msg_id to prompts_sent table.
# Surfaces Telegram via osascript if all-clear.
#
# First-fire-today exception: if setup completed after the 18:00-21:00 EEST window
# AND today has no prompts_sent row → fire immediately (now+5min fallback).

set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
# SEND via the dedicated Woodchuck bot (@woodchuck_threadwork_bot, bot_id 8668963584).
# Dedicated token => no 409 contention with the shared agent bot or the old manager bot.
# Token lives (0600) in woodchuck.env; never hard-code it here.
WOODCHUCK_ENV="$HOME/.claude/state/stokes-daily-tracker/woodchuck.env"
if [ -f "$WOODCHUCK_ENV" ]; then
  # shellcheck disable=SC1090
  . "$WOODCHUCK_ENV"
fi
TG_TOKEN="${WOODCHUCK_TG_TOKEN:-}"
STOKES_CHAT="REPLACE_WITH_TELEGRAM_CHAT_ID"
DB="$HOME/.claude/state/stokes-daily-tracker/journal.db"
KAIROS_DB="$HOME/bin/kairos.db"
GAM="/Users/coachstokes/bin/gam7/gam"
LOG="$HOME/.claude/state/stokes-daily-tracker/fire.log"
TS=$(date -u +%FT%TZ)
TODAY=$(TZ="Europe/Helsinki" date +%Y-%m-%d)

# EEST window: 18:00-21:00 (STOKES_TRACKER_WINDOW_HOURS env override: "HH:HH")
WINDOW_START_H=18
WINDOW_END_H=21
if [ -n "${STOKES_TRACKER_WINDOW_HOURS:-}" ]; then
  WINDOW_START_H=$(echo "$STOKES_TRACKER_WINDOW_HOURS" | cut -d- -f1)
  WINDOW_END_H=$(echo "$STOKES_TRACKER_WINDOW_HOURS" | cut -d- -f2)
fi

CURRENT_H=$(TZ="Europe/Helsinki" date +%H)
CURRENT_H=$((10#$CURRENT_H))  # strip leading zero

log() {
  echo "[$TS] $*" >> "$LOG"
}

log "fire.sh start — today=$TODAY current_h=$CURRENT_H window=${WINDOW_START_H}-${WINDOW_END_H} (sender=woodchuck/8668963584)"

if [ -z "$TG_TOKEN" ]; then
  log "ERROR: Woodchuck token not found ($WOODCHUCK_ENV missing or WOODCHUCK_TG_TOKEN unset) — cannot send. Exiting."
  exit 1
fi

# ── Check if already sent today ───────────────────────────────────────────────
ALREADY_SENT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM prompts_sent WHERE date='$TODAY';" 2>/dev/null || echo 0)

if [ "$ALREADY_SENT" -gt 0 ]; then
  log "prompt already sent today — exiting"
  exit 0
fi

# ── First-fire-today exception: if post-window and no row yet → fire NOW ──────
# Check: current time > window end AND no prompts_sent for today
# "fallback-time" / "window passed" / "first-fire" logic
FIRE_NOW=0
if [ "$CURRENT_H" -ge "$WINDOW_END_H" ]; then
  log "post-window fallback: now+5min exception — firing immediately (first run, post-window exception)"
  FIRE_NOW=1
fi

# If we're before the window, just exit (launchd fires again tomorrow)
if [ "$CURRENT_H" -lt "$WINDOW_START_H" ] && [ "$FIRE_NOW" -eq 0 ]; then
  log "pre-window ($CURRENT_H < $WINDOW_START_H) — exiting, will retry later"
  exit 0
fi

# ── Presence check 1: Kairos staleness ───────────────────────────────────────
# julianday arithmetic on kairos.db observations timestamp
# If last observation > 10 minutes ago → Stokes likely away from desk → defer
if [ -f "$KAIROS_DB" ]; then
  MINS_SINCE=$(sqlite3 "$KAIROS_DB" \
    "SELECT CAST((julianday('now') - julianday(MAX(timestamp))) * 1440 AS INTEGER) FROM observations;" \
    2>/dev/null || echo 9999)
  log "kairos: minutes since last observation = $MINS_SINCE"
  if [ "$MINS_SINCE" -gt 10 ] && [ "$FIRE_NOW" -eq 0 ]; then
    log "deferred — Stokes away from desk (kairos staleness: last obs ${MINS_SINCE}m ago)"
    exit 0
  fi
else
  log "kairos.db not found at $KAIROS_DB — skipping staleness check"
fi

# ── Presence check 2: TipTap activity (IndexedDB leveldb) ────────────────────
# strings-dump the leveldb 000289.log file; look for tipTap updatedAt within last 60 seconds
LEVELDB_LOG="$HOME/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/000289.log"
if [ -f "$LEVELDB_LOG" ]; then
  # Extract any timestamp-looking strings near tipTap and check recency
  TIPTAP_TS=$(strings "$LEVELDB_LOG" 2>/dev/null | grep -i "updatedAt" | tail -1 | grep -oE '[0-9]{13}' | tail -1 || echo "")
  if [ -n "$TIPTAP_TS" ]; then
    NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || echo 0)
    DIFF_S=$(python3 -c "print(max(0, ($NOW_MS - $TIPTAP_TS) // 1000))" 2>/dev/null || echo 9999)
    log "tiptap: updatedAt=$TIPTAP_TS now_ms=$NOW_MS diff_s=$DIFF_S"
    if [ "$DIFF_S" -lt 60 ] && [ "$FIRE_NOW" -eq 0 ]; then
      log "deferred — Stokes is actively typing in TipTap (updatedAt ${DIFF_S}s ago)"
      exit 0
    fi
  else
    log "tiptap: no updatedAt timestamp found in leveldb 000289.log"
  fi
else
  log "tiptap: leveldb log not found at expected path — skipping check"
fi

# ── Presence check 3: GAM calendar — meeting in next 30 min ──────────────────
NOW_ISO=$(TZ="Europe/Helsinki" date +%Y-%m-%dT%H:%M:%S)
FUTURE_ISO=$(TZ="Europe/Helsinki" date -v+30M +%Y-%m-%dT%H:%M:%S 2>/dev/null || \
  python3 -c "from datetime import datetime,timedelta; print((datetime.now()+timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%S'))")
if [ -x "$GAM" ]; then
  CALENDAR_CHECK=$("$GAM" user coachstokes@two8bands.com show events query "$NOW_ISO/$FUTURE_ISO" 2>/dev/null | grep -c "summary:" || echo 0)
  log "gam calendar: events in next 30min = $CALENDAR_CHECK"
  if [ "$CALENDAR_CHECK" -gt 0 ] && [ "$FIRE_NOW" -eq 0 ]; then
    log "deferred — meeting in next 30 min (GAM calendar check)"
    exit 0
  fi
else
  log "gam not executable at $GAM — skipping calendar check"
fi

# ── Build the wake prompt ─────────────────────────────────────────────────────
PROMPT_TEXT="Hey Coach — agent team here. Quick 20-second check-in for today ($TODAY).

⚠️ Answer FULLY in ONE message — you'll be LOCKED after your first reply.

🎯 THE NUMBER, ABOVE EVERYTHING: 22 box sets/day. That's the survival line. Everything else is noise until that's moving.

The play to hit it: run Meta ads FROM Coach Welly's proven organic posts (the 100k / 10k-view ones) → straight to the Arm Swing landing page. Your CTR is already ~3x industry — the win is there. The LEAK is conversion: the generic LP bleeds it, the Arm Swing LP is the lever. Fix the destination, the ads pay for themselves. This matters NOW: family trip ~1 week out, Prime Days incoming, inventory IS in stock but cash is tight. Profitable Meta ads → cash-flow survival. That's the whole game this week.

Still open and I'm staying ON them:
• Audiobook email blast to past customers — this is a TODAY job, not a someday job.
• ≥1 full week of outreach + order data logged — get the week on the board.
(Open/click metrics are Snoopy's to pull, not yours — don't spend a minute reporting those.)

Don't drift into non-revenue busywork. No reorganizing, no polishing, no more writing — if it doesn't move box sets or cash, it waits.

Now — which deliverables did you actually move forward today? Reply in ONE message, just what you worked on:

🔷 PILLAR 1 — Plug the Leaks
• Send audiobook email blast to past customers
• Record open/click metrics in lead log
• Log ≥1 full week of outreach + order data
• 24-hour capture rule for partner inbound established

❓ NEEDS CLARIFICATION (propose dropping — tell me if this still matters):
• "Tag all products in one sitting" — unclear scope; say the word and I'll drop it or you can clarify what "done" looks like.

✅ COMPLETED — no longer tracking, do NOT need a status on these:
• Open partner-referred coach lead follow-ups + referral sheets ✓
• Audiobook/ebook download end-to-end test ✓
• Lead/outreach log spreadsheet + ~40-coach backfill ✓
• COGS + CAC wired into Path to Profits dashboard ✓

🔷 PILLAR 2 — Owned Lead-Gen Engine
• [Epic 2.1] Extract front-door magnet from existing book
• [Epic 2.1] Build email + profession capture page (2 fields only)
• [Epic 2.1] Set up comment-to-DM automation with keyword trigger
• [Epic 2.1] Test full funnel: comment → auto-DM → capture page → row logged
• [Epic 2.2] Write 5–8 email nurture sequence (coach track → bulk offer)
• [Epic 2.2] Apollo sending-domain warmup started / progressed
• [Epic 2.2] Apollo coach prospect list built; cold outreach sent

🔷 PILLAR 3 — Make Paid Spend Honest
• [Epic 3.1] Cut zero-sale Amazon campaigns; concentrate on Brand Lockdown
• [Epic 3.1] Track Amazon ACoS this week (target < 35%)
• [Epic 3.2] Measure Meta cost-per-acquisition; measure promoted-reel cost-per-lead

🔷 PILLAR 4 — Seasonal-Proof & Systemize
• [Epic 4.1] Lightweight automation for product-tagging or outreach-cadence
• [Epic 4.2] Progress on coach bulk/team-order pipeline or upsell ladder

Or just tell me in your own words what shipped today.

🔥 Last thing, the one that counts: What's the ONE revenue move you're closing TODAY? Don't write me a book — give me the number you're chasing and ship it."

log "sending wake prompt to Stokes (chat $STOKES_CHAT)"

# ── Send to Telegram ──────────────────────────────────────────────────────────
SEND_RESPONSE=$(curl -s --max-time 20 -X POST \
  "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${STOKES_CHAT}" \
  --data-urlencode "text=${PROMPT_TEXT}" \
  2>>"$LOG")

MSG_ID=$(echo "$SEND_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('message_id',''))" 2>/dev/null || echo "")

if [ -n "$MSG_ID" ]; then
  log "prompt sent: message_id=$MSG_ID"
  # Record to prompts_sent table
  ESCAPED_PROMPT=$(echo "$PROMPT_TEXT" | sed "s/'/''/g")
  sqlite3 "$DB" "INSERT INTO prompts_sent(date, telegram_msg_id, prompt_text) VALUES ('$TODAY', $MSG_ID, '$ESCAPED_PROMPT');" 2>>"$LOG"
  log "recorded to prompts_sent: date=$TODAY msg_id=$MSG_ID"
else
  log "ERROR: failed to get message_id from Telegram response: $SEND_RESPONSE"
fi

# ── Surface Telegram via osascript (macos-automator) ─────────────────────────
# Activate Telegram so Stokes sees the prompt immediately
osascript -e 'tell application "Telegram" to activate' 2>>"$LOG" || \
  log "osascript: Telegram activate failed (app may not be running)"

log "fire.sh complete"
exit 0
