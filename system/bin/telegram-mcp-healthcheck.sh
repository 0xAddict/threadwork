#!/usr/bin/env bash
# telegram-mcp-healthcheck.sh
#
# Self-healing health monitor for boss's telegram MCP poller.
#
# What it checks (non-disruptive — does NOT race with boss's long-poll):
#   1. /Users/coachstokes/.claude/channels/telegram/boss/bot.pid exists
#   2. The PID inside is alive
#   3. That process is `bun server.ts` inside a claude-plugins-official/telegram/*
#   4. Its parent chain reaches a live `claude` process bound to the claude-boss
#      tmux session
#   5. Optional: telegram getMe returns ok:true on boss's token (this is safe,
#      it does not conflict with a concurrent long-poll getUpdates)
#
# On UNHEALTHY:
#   - Find every `bun .../plugin/telegram/server.ts` process on the box
#   - For each, walk its parent chain to find a `claude` ancestor
#   - If no live claude ancestor is found -> orphan -> SIGTERM it
#   - Clear stale bot.pid files whose owning PID is no longer alive
#   - Re-verify health (re-read bot.pid, getMe)
#
# Alerting:
#   - State file at /tmp/telegram-mcp-last-state = healthy | unhealthy
#   - Only posts to the team telegram group on state TRANSITION:
#       healthy -> unhealthy : "WARNING: Telegram MCP disconnected - self-heal attempt"
#       unhealthy -> healthy : "OK: Telegram MCP recovered (killed N stale pollers)"
#   - Recovered message still fires if the prior state was unhealthy even
#     across reboots (state file survives) — a fresh boot with no prior file
#     defaults to "healthy" and stays silent unless we actually see a problem.
#
# Exit codes:
#   0 = healthy, or was unhealthy but successfully self-healed
#   1 = unrecoverable (still unhealthy after heal attempt, or config missing)
#   2 = internal error (missing dependencies, unreadable token, etc.)
#
# HARD RULES:
#   * Never kill boss's live poller. Orphans only — PIDs whose claude ancestor
#     is dead or whose ppid chain reparents to launchd (pid 1).
#   * Never hardcode the bot token. Read from ~/.claude/telegram-pool.sh.
#   * Never spam the group. State file debounces all alerts.
#   * Never delete bot.pid files while the owning PID is still alive.

set -u  # DO NOT set -e — we want to control failure paths precisely

# ----- configuration ----------------------------------------------------------

HOME_DIR="${HOME:-/Users/coachstokes}"
POOL_FILE="${TGMCP_POOL_FILE:-$HOME_DIR/.claude/telegram-pool.sh}"
CHANNEL_DIR="${TGMCP_CHANNEL_DIR:-$HOME_DIR/.claude/channels/telegram}"
BOSS_BOT_DIR="$CHANNEL_DIR/boss"
BOSS_PID_FILE="$BOSS_BOT_DIR/bot.pid"
STATE_FILE="${TGMCP_STATE_FILE:-/tmp/telegram-mcp-last-state}"
LOG_FILE="${TGMCP_LOG_FILE:-/tmp/telegram-mcp-healthcheck.log}"
LOCK_FILE="${TGMCP_LOCK_FILE:-/tmp/telegram-mcp-healthcheck.lock}"
TEAM_GROUP_CHAT_ID="${TGMCP_GROUP_CHAT_ID:--1003790554582}"
BOSS_TMUX_SESSION="${TGMCP_BOSS_SESSION:-claude-boss}"
PLUGIN_PATH_MATCH="plugins/cache/claude-plugins-official/telegram/"
# TGMCP_DRY_RUN=1 suppresses all notify_group curl calls (used for tests).
DRY_RUN="${TGMCP_DRY_RUN:-0}"

# ----- logging helper ---------------------------------------------------------

log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] %s\n' "$ts" "$*" >> "$LOG_FILE"
}

die() {
  log "FATAL: $*"
  exit 2
}

# ----- dependency checks ------------------------------------------------------

command -v curl >/dev/null 2>&1 || die "curl not found"
command -v ps   >/dev/null 2>&1 || die "ps not found"
command -v awk  >/dev/null 2>&1 || die "awk not found"

# ----- concurrency lock -------------------------------------------------------
# Prevent two crons from overlapping (e.g. when a prior run is still inside
# its 2-second recheck sleep when the next launchd tick fires).
if [[ -f "$LOCK_FILE" ]]; then
  lock_pid=$(tr -d '[:space:]' < "$LOCK_FILE" 2>/dev/null)
  if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
    log "another instance (pid=$lock_pid) is still running — skipping this tick"
    exit 0
  fi
  # Stale lock — remove
  rm -f "$LOCK_FILE"
fi
printf '%s\n' "$$" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT INT TERM

# ----- extract boss bot token from pool file ---------------------------------

get_boss_token() {
  [[ -r "$POOL_FILE" ]] || { log "pool file unreadable: $POOL_FILE"; return 1; }
  # BOTS array entries look like:  "<token>|<label>|<conf>"
  # We grep for the Boss line and cut the token.
  local line
  line=$(grep -E '^[[:space:]]*"[^"]*\|Boss\|' "$POOL_FILE" | head -1)
  [[ -n "$line" ]] || { log "no Boss entry in pool file"; return 1; }
  # Strip the outer quotes then take field 1 on '|'
  local inner
  inner=$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
  printf '%s\n' "${inner%%|*}"
}

# ----- process helpers --------------------------------------------------------

# ps portable: pid ppid command. Use `-o command=` to get full argv.
ps_info() {
  local pid="$1"
  ps -p "$pid" -o pid=,ppid=,command= 2>/dev/null
}

is_alive() {
  kill -0 "$1" 2>/dev/null
}

# Walk ppid chain from a given pid up to pid 1. Returns the first ancestor
# whose command matches `claude` (the CLI). Empty if none.
find_claude_ancestor() {
  local pid="$1"
  local hops=0
  while (( hops < 20 )); do
    (( hops++ ))
    [[ -z "$pid" || "$pid" == "0" || "$pid" == "1" ]] && return 1
    local info ppid cmd
    info=$(ps_info "$pid") || return 1
    [[ -n "$info" ]] || return 1
    ppid=$(printf '%s\n' "$info" | awk '{print $2}')
    cmd=$(printf '%s\n' "$info" | awk '{for(i=3;i<=NF;i++)printf "%s%s",$i,(i==NF?"\n":" ")}')
    if [[ "$cmd" == claude* || "$cmd" == *"/claude "* || "$cmd" == *" claude "* ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
    pid="$ppid"
  done
  return 1
}

# List all live telegram-plugin bun pollers as "pid ppid cmd...".
# We only emit `bun server.ts` processes whose working directory (via lsof) or
# whose parent wrapper command (`bun run --cwd <path>`) is the telegram plugin.
# This deliberately excludes task-board/watchdog bun processes.
list_all_pollers() {
  local telegram_wrappers=""
  telegram_wrappers=$(ps -axo pid=,ppid=,command= 2>/dev/null \
    | awk -v pat="$PLUGIN_PATH_MATCH" 'index($0, pat) && /bun run/ {print $1}')
  # For each telegram wrapper, find its child `bun server.ts`.
  for wrapper_pid in $telegram_wrappers; do
    ps -axo pid=,ppid=,command= 2>/dev/null \
      | awk -v wp="$wrapper_pid" '$2==wp && /bun/ && /server\.ts/ {print}'
  done
  # Also catch any `bun server.ts` whose cwd (via lsof) is inside the plugin
  # dir — catches orphans whose wrapper already died.
  if command -v lsof >/dev/null 2>&1; then
    local all_bun_servers
    all_bun_servers=$(ps -axo pid=,ppid=,command= 2>/dev/null \
      | awk '/bun/ && /server\.ts/ && !/bun run/ {print}')
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local p
      p=$(printf '%s\n' "$line" | awk '{print $1}')
      local cwd
      cwd=$(lsof -p "$p" -a -d cwd -F n 2>/dev/null | awk '/^n/ {sub(/^n/,""); print; exit}')
      if [[ -n "$cwd" && "$cwd" == *"$PLUGIN_PATH_MATCH"* ]]; then
        printf '%s\n' "$line"
      fi
    done <<< "$all_bun_servers"
  fi
}

# ----- health probes ----------------------------------------------------------

# Confirms boss's recorded poller is a sensible bun server.ts under a live claude
# ancestor matching the claude-boss tmux session.
# Returns 0 if healthy, non-zero otherwise. Echoes a reason on non-zero.
check_boss_poller_local() {
  if [[ ! -f "$BOSS_PID_FILE" ]]; then
    echo "boss bot.pid missing"
    return 1
  fi
  local pid
  pid=$(tr -d '[:space:]' < "$BOSS_PID_FILE")
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "boss bot.pid malformed: '$pid'"
    return 1
  fi
  if ! is_alive "$pid"; then
    echo "boss poller pid=$pid not alive"
    return 1
  fi
  local cmd
  cmd=$(ps -p "$pid" -o command= 2>/dev/null)
  if [[ "$cmd" != *"bun"* || "$cmd" != *"server.ts"* ]]; then
    echo "boss pid=$pid is not bun server.ts: $cmd"
    return 1
  fi
  local claude_ancestor
  if ! claude_ancestor=$(find_claude_ancestor "$pid"); then
    echo "boss poller pid=$pid has no claude ancestor (reparented orphan?)"
    return 1
  fi
  # Try to verify the claude ancestor is actually the claude-boss tmux pane.
  # tmux may not be available in all environments; if it isn't, we accept any
  # live claude ancestor as sufficient evidence.
  if command -v tmux >/dev/null 2>&1; then
    local boss_pane_pid
    boss_pane_pid=$(tmux list-panes -t "$BOSS_TMUX_SESSION" -F "#{pane_pid}" 2>/dev/null | head -1)
    if [[ -n "$boss_pane_pid" && "$boss_pane_pid" != "$claude_ancestor" ]]; then
      # claude ancestor is alive but not boss's pane. This means boss's bot.pid
      # points to a different agent's poller — very bad.
      echo "boss bot.pid pid=$pid belongs to claude pid=$claude_ancestor, not claude-boss pane pid=$boss_pane_pid"
      return 1
    fi
  fi
  # Passed all local checks.
  return 0
}

# Non-disruptive API probe — /getMe does NOT conflict with a concurrent
# long-poll /getUpdates. Returns 0 on ok:true, non-zero otherwise.
check_boss_api() {
  local token="$1"
  local resp
  resp=$(curl -sS -m 6 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || true)
  if [[ -z "$resp" ]]; then
    echo "getMe: empty/failed response"
    return 1
  fi
  if [[ "$resp" != *'"ok":true'* ]]; then
    echo "getMe: not ok -> $resp"
    return 1
  fi
  return 0
}

# Last-resort disruptive probe — only use when poller already looks broken.
# If we get 409, another poller owns the slot (confirms orphan).
probe_getupdates_for_409() {
  local token="$1"
  local resp
  resp=$(curl -sS -m 6 "https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=-1&limit=1" 2>/dev/null || true)
  if [[ "$resp" == *'"error_code":409'* ]]; then
    return 0   # yes, 409
  fi
  return 1     # no 409 (maybe healthy, maybe different error)
}

# ----- self-heal -------------------------------------------------------------

# Kill orphans: bun server.ts processes under the telegram plugin whose
# claude ancestor is dead (or missing). Returns count of killed orphans on
# stdout.
heal_kill_orphans() {
  local killed=0
  # Build list: pid ppid command. Include both the wrapper `bun run --cwd ...`
  # and the child `bun server.ts`. We'll only SIGTERM the child server.ts
  # (killing the child is enough; wrapper exits).
  local live_boss_pid=""
  if [[ -f "$BOSS_PID_FILE" ]]; then
    live_boss_pid=$(tr -d '[:space:]' < "$BOSS_PID_FILE" 2>/dev/null)
  fi
  # We will also never kill the currently-running boss poller determined from
  # live local check.
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local pid cmd
    pid=$(printf '%s\n' "$line" | awk '{print $1}')
    cmd=$(printf '%s\n' "$line" | awk '{for(i=3;i<=NF;i++)printf "%s%s",$i,(i==NF?"\n":" ")}')
    # Skip if this is the wrapper `bun run --cwd ... --silent start` — we only
    # target actual server.ts children.
    if [[ "$cmd" != *"server.ts"* ]]; then
      continue
    fi
    if [[ -n "$live_boss_pid" && "$pid" == "$live_boss_pid" ]]; then
      log "heal: skipping live boss poller pid=$pid"
      continue
    fi
    if find_claude_ancestor "$pid" >/dev/null; then
      # Has a live claude ancestor — NOT an orphan. Could be steve/sadie/kiera/snoopy.
      log "heal: pid=$pid has live claude ancestor; skipping"
      continue
    fi
    log "heal: orphan bun server.ts pid=$pid cmd='$cmd' — sending SIGTERM"
    if kill -TERM "$pid" 2>/dev/null; then
      (( killed++ ))
      # Give it a moment to exit, then SIGKILL if still around
      sleep 1
      if is_alive "$pid"; then
        log "heal: pid=$pid did not exit on SIGTERM, sending SIGKILL"
        kill -KILL "$pid" 2>/dev/null || true
      fi
    else
      log "heal: kill failed for pid=$pid"
    fi
  done < <(list_all_pollers)
  printf '%s\n' "$killed"
}

# Clear any stale bot.pid files (every agent dir) where the recorded PID is
# not alive. Never clears a file whose PID is still running.
heal_clear_stale_pidfiles() {
  local cleared=0
  for agent_dir in "$CHANNEL_DIR"/boss "$CHANNEL_DIR"/steve "$CHANNEL_DIR"/sadie "$CHANNEL_DIR"/kiera "$CHANNEL_DIR"/snoopy; do
    local pf="$agent_dir/bot.pid"
    [[ -f "$pf" ]] || continue
    local recorded
    recorded=$(tr -d '[:space:]' < "$pf" 2>/dev/null)
    [[ -n "$recorded" ]] || continue
    if is_alive "$recorded"; then
      continue  # owning process still running; leave alone
    fi
    log "heal: removing stale pid file $pf (pid=$recorded dead)"
    rm -f "$pf" 2>/dev/null && (( cleared++ ))
  done
  printf '%s\n' "$cleared"
}

# ----- telegram notifier ------------------------------------------------------

notify_group() {
  local token="$1"
  local text="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "notify_group (DRY_RUN): $text"
    return 0
  fi
  local resp rc
  resp=$(curl -sS -m 8 \
    -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${TEAM_GROUP_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_notification=false" 2>&1)
  rc=$?
  if (( rc != 0 )); then
    log "notify_group: curl rc=$rc resp=$resp"
  elif [[ "$resp" != *'"ok":true'* ]]; then
    log "notify_group: api rejected: $resp"
    rc=1
  else
    log "notify_group: posted OK -> \"$text\""
  fi
  return $rc
}

# ----- state file -------------------------------------------------------------

read_prev_state() {
  if [[ -f "$STATE_FILE" ]]; then
    tr -d '[:space:]' < "$STATE_FILE"
  else
    printf 'healthy\n'  # optimistic default on first run -> won't alert unless we fail
  fi
}

write_state() {
  printf '%s\n' "$1" > "$STATE_FILE"
}

# ----- main -------------------------------------------------------------------

main() {
  log "----- healthcheck tick (pid $$) -----"

  local boss_token
  if ! boss_token=$(get_boss_token); then
    log "cannot read boss token — aborting"
    exit 2
  fi

  local prev_state
  prev_state=$(read_prev_state)
  log "prev_state=$prev_state"

  local reason=""
  local healthy=1

  if ! reason=$(check_boss_poller_local); then
    healthy=0
    log "local check failed: $reason"
  else
    log "local check ok (boss bot.pid alive and bound to claude-boss)"
    if ! reason=$(check_boss_api "$boss_token"); then
      healthy=0
      log "api check failed: $reason"
    else
      log "api check ok (getMe ok:true)"
    fi
  fi

  if (( healthy == 1 )); then
    if [[ "$prev_state" != "healthy" ]]; then
      log "state transition: $prev_state -> healthy (no heal needed this tick)"
      notify_group "$boss_token" "OK: Telegram MCP recovered (no self-heal needed this tick)"
    fi
    write_state "healthy"
    exit 0
  fi

  # ---- UNHEALTHY path ----
  log "UNHEALTHY: $reason"

  # Only alert on transition healthy -> unhealthy (first-time disconnect)
  if [[ "$prev_state" == "healthy" ]]; then
    notify_group "$boss_token" "WARNING: Telegram MCP disconnected - attempting self-heal ($reason)"
  else
    log "still unhealthy (prev=$prev_state) — suppressing duplicate warning"
  fi
  write_state "unhealthy"

  # Self-heal: kill orphans, clear stale pid files
  local killed cleared
  killed=$(heal_kill_orphans)
  cleared=$(heal_clear_stale_pidfiles)
  log "heal summary: killed=$killed stale_pidfiles_cleared=$cleared"

  # Re-verify. Give boss's poller a moment to restart (the plugin will spawn
  # a fresh one next time it's needed; we cannot respawn it ourselves without
  # pretending to be a claude session).
  sleep 2

  local recheck_reason=""
  local recheck_healthy=1
  if ! recheck_reason=$(check_boss_poller_local); then
    recheck_healthy=0
  elif ! recheck_reason=$(check_boss_api "$boss_token"); then
    recheck_healthy=0
  fi

  if (( recheck_healthy == 1 )); then
    log "recovered after heal (killed=$killed cleared=$cleared)"
    notify_group "$boss_token" "OK: Telegram MCP recovered (killed $killed stale pollers, cleared $cleared stale pid files)"
    write_state "healthy"
    exit 0
  fi

  # Still broken. We cannot spawn boss's poller from this script — only boss's
  # claude session can do that. Optionally, confirm the 409 picture.
  if probe_getupdates_for_409 "$boss_token"; then
    log "recheck still unhealthy; getUpdates reports 409 (another holder still present)"
  else
    log "recheck still unhealthy; getUpdates does not report 409"
  fi

  log "UNRECOVERABLE: boss poller could not be restored by the monitor"
  # Do NOT spam again this tick — we already posted the warning above. Just exit non-zero.
  exit 1
}

main "$@"
