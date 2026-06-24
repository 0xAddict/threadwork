#!/usr/bin/env bash
# kairos-launcher.sh — supervisor entrypoint for the Kairos monitor.
#
# Reconstructed 2026-05-17 via TDD (launcher.bats). The launchd plist's
# ProgramArguments are exactly  /bin/bash  $HOME/bin/kairos-launcher.sh  — so
# launchd's entrypoint is THIS file, which in turn starts kairos-monitor.sh.
# kairos-launchd.log shows the monitor relaunched repeatedly, so the launcher
# supervises and restarts the loop.
#
# NOTE (verbatim from the launchd plist comment): launchd-spawned processes do
# NOT inherit Screen Recording (TCC) permission, so a launchd start yields
# wallpaper-only captures. RunAtLoad/KeepAlive are false in the plist; Kairos
# is meant to be started MANUALLY from a Screen-Recording-permissioned tmux
# session. This launcher works either way.
#
# Test-only env overrides:
#   KAIROS_MONITOR KAIROS_LOG KAIROS_MAX_RESTARTS

set -uo pipefail

BIN_DIR="${KAIROS_BIN_DIR:-$HOME/bin}"
MONITOR="${KAIROS_MONITOR:-$BIN_DIR/kairos-monitor.sh}"
LOG_PATH="${KAIROS_LOG:-$HOME/bin/kairos.log}"
MAX_RESTARTS="${KAIROS_MAX_RESTARTS:-0}"   # 0 = supervise forever (production)

export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.local/bin"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_PATH"
}

# Single-instance guard: refuse to stack on an already-running monitor.
# Match only a process that ENDS its argv with the monitor script path (i.e. is
# actually executing it: "bash .../kairos-monitor.sh"), not any process that
# merely mentions the string. pgrep -f matches the full argv; the regex anchors
# the monitor path to end-of-string so editors/greps/tests don't false-match.
monitor_basename="$(basename "$MONITOR")"
if pgrep -f "/${monitor_basename}\$" >/dev/null 2>&1; then
  log "Launcher: ${monitor_basename} already running — not starting a second copy."
  echo "${monitor_basename} already running; aborting." >&2
  exit 0
fi

if [ ! -x "$MONITOR" ]; then
  log "Launcher: $MONITOR missing or not executable — aborting."
  echo "ERROR: $MONITOR missing or not executable." >&2
  exit 1
fi

log "Launcher: starting kairos-monitor.sh"

restarts=0
while true; do
  "$MONITOR"
  rc=$?
  restarts=$((restarts + 1))
  if [ "$MAX_RESTARTS" -gt 0 ] && [ "$restarts" -ge "$MAX_RESTARTS" ]; then
    log "Launcher: kairos-monitor.sh exited (rc=$rc) — restart cap reached, stopping."
    break
  fi
  log "Launcher: kairos-monitor.sh exited (rc=$rc) — restarting in 10s"
  sleep 10
done
