#!/bin/bash
# Canonical Monitor recipe for harness-contract (v2, REPL-respectful).
#
# v2 changes (from iter-2 retrospective 2026-05-20):
# - Stall threshold raised 360s → 600s (10 min) — was generating an event every
#   30s after 6 min, starving the */3 cron's REPL slot. Cron observably never
#   fired during a chatty Monitor run.
# - Sleep interval raised 30s → 60s — same reason: fewer REPL re-entries.
# - Added STALL_long_silence_<n>m event at 15-min and 25-min marks for visibility
#   without per-30s spam.
#
# Pass to the Monitor tool as the `command:` field, replacing {SPRINT_DIR} with
# the absolute path to .harness/sprints/sprint-N/. Set timeout_ms=3600000 (1h),
# persistent=false. The script exits on terminal PASS/FAIL.
#
# WHEN TO SKIP MONITOR ENTIRELY:
# - Sprints expected to run >15 min and where the Cron is the primary unstick
#   actor — Monitor events compete with Cron for REPL idle slots.
# - Sprints where Generator's natural cadence is long (TDD + multi-deliverable);
#   the per-60s polling produces churn without adding value.
#
# Emits one line per significant event — the Monitor tool surfaces each line as
# a notification.

STATUS={SPRINT_DIR}/status.txt
LOG={SPRINT_DIR}/implementation-log.md
REPORT={SPRINT_DIR}/verifier-report.md

prev=""
ticks_no_change=0
last_long_silence_min_emitted=0

while true; do
  cur=$(cat "$STATUS" 2>/dev/null | tr -d '\n')

  # State transition event (always emit)
  if [ "$cur" != "$prev" ]; then
    echo "STATUS_CHANGED prev=$prev cur=$cur ts=$(date -u +%H:%M:%S)"
    prev="$cur"
    ticks_no_change=0
    last_long_silence_min_emitted=0
  else
    ticks_no_change=$((ticks_no_change+1))
  fi

  # Terminal states — emit and exit
  case "$cur" in
    PASS*)              echo "TERMINAL pass cur=$cur";              break ;;
    FAIL*)              echo "TERMINAL fail cur=$cur";              break ;;
    BLOCKED*)           echo "TERMINAL blocked cur=$cur";           break ;;
    TIMEOUT*)           echo "TERMINAL timeout cur=$cur";           break ;;
    AWAITING_AMENDMENT*) echo "TERMINAL amendment cur=$cur";        break ;;
  esac

  # Stall detection — implementing with no log progress for 10+ min (raised from 6)
  if [ "$cur" = "implementing" ] && [ -f "$LOG" ]; then
    age=$(( $(date +%s) - $(stat -f%m "$LOG" 2>/dev/null || echo 0) ))
    if [ "$age" -gt 600 ]; then
      # Emit at most once per 5 min while stalled (10 min threshold + every 5 min thereafter)
      if [ "$((age / 300))" -gt "$last_long_silence_min_emitted" ]; then
        echo "STALL_implementing log_age=${age}s (~$((age/60))min)"
        last_long_silence_min_emitted=$((age / 300))
      fi
    fi
  fi

  # Stall detection — Verifier never started; emit at 10 min then every 5 min
  if [ "$cur" = "ready_for_evaluation" ] && [ ! -f "$REPORT" ]; then
    if [ "$ticks_no_change" -gt 10 ]; then  # 10 * 60s = 10 min
      if [ "$((ticks_no_change / 5))" -gt "$last_long_silence_min_emitted" ]; then
        echo "STALL_awaiting_verifier ticks_no_change=$ticks_no_change (~$((ticks_no_change))min)"
        last_long_silence_min_emitted=$((ticks_no_change / 5))
      fi
    fi
  fi

  sleep 60
done
