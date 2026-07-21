#!/bin/zsh
# launch-all.sh — Ensure all 5 Claude Code + Telegram tmux sessions are running
# Called on login via LaunchAgent, or manually: ~/.claude/launch-all.sh

SESSION_NAMES=(claude-boss claude-steve claude-sadie claude-kiera claude-snoopy)
POOL_SCRIPT="$HOME/.claude/telegram-pool.sh"
TRUST_DELAY=6  # seconds to wait for trust prompt to appear

# ─── Preflight ───────────────────────────────────────────────────────────────
# Wait for network (bots need Telegram API)
for i in {1..30}; do
  curl -s --max-time 3 https://api.telegram.org > /dev/null 2>&1 && break
  sleep 2
done

# Clear stale lockfiles (from previous boot)
# NOTE: this only touches the telegram-pool per-session lockfiles under
# ~/.claude/channels/telegram/locks — it does NOT touch /tmp/kairos-recovery.lock
# (the shared Kairos single-writer lock), which must NEVER be rm'd at runtime.
LOCK_DIR="$HOME/.claude/channels/telegram/locks"
mkdir -p "$LOCK_DIR"
for lockfile in "$LOCK_DIR"/*.lock(N); do
  [[ -f "$lockfile" ]] || continue
  content=$(<"$lockfile")
  if [[ "$content" != "EXTERNAL" ]] && ! kill -0 "$content" 2>/dev/null; then
    rm -f "$lockfile"
  fi
done

# ─── Launch Missing Sessions ────────────────────────────────────────────────
launched=0

for session in "${SESSION_NAMES[@]}"; do
  # Skip if session already exists and has a running process
  if tmux has-session -t "$session" 2>/dev/null; then
    continue
  fi

  # Create session and run pool script
  tmux new-session -d -s "$session"
  tmux send-keys -t "$session" "source $POOL_SCRIPT" Enter

  # Auto-accept the workspace trust prompt, then load boot briefing
  (
    sleep $TRUST_DELAY
    tmux send-keys -t "$session" Enter 2>/dev/null
    sleep 12
    tmux send-keys -t "$session" "Call get_boot_briefing to load your memory and context. Then call list_tasks with filter='mine' to check for pending work. State your name, role, and current task status." Enter 2>/dev/null
  ) &

  launched=$((launched + 1))

  # Stagger launches so lockfiles don't race
  sleep 3
done

if [[ $launched -eq 0 ]]; then
  echo "All sessions already running."
else
  echo "Launched $launched session(s): ${SESSION_NAMES[*]}"
fi

# ─── Start Kairos Monitor ────────────────────────────────────────────────────
# Must run from here (not launchd) so it inherits the user's Screen Recording
# TCC permission via tmux. launchd-spawned processes only capture wallpaper.
#
# SHARED SINGLE-WRITER LOCK (added): this 300s re-invoke is one of THREE spawners
# that can start a Kairos monitor (the others: kairos-launcher.sh's ~10s loop and
# kairos-watchdog.py recovery). To prevent a double-launch it honors the SAME
# advisory flock recovery holds — /tmp/kairos-recovery.lock — via the identical
# fd-inheritance + /usr/bin/python3 fcntl.flock(2) mechanism (macOS has no
# flock(1) CLI; flock ONLY, never lockf). The existing `has-session` check is
# kept as a fast pre-filter; the lock closes the check-then-spawn TOCTOU window
# against the other two spawners. Canonical liveness predicate is the SAME one
# used everywhere: pgrep -f '/kairos-monitor.sh$'.
KAIROS_SESSION="kairos"
KAIROS_LOCK_PATH="${KAIROS_LOCK_PATH:-/tmp/kairos-recovery.lock}"
KAIROS_PYTHON="${KAIROS_PYTHON:-/usr/bin/python3}"

kairos_monitor_alive() { pgrep -f '/kairos-monitor.sh$' >/dev/null 2>&1; }

if ! tmux has-session -t "$KAIROS_SESSION" 2>/dev/null; then
  # Fast pre-filter said the session is gone. Take the shared lock before
  # (re)creating it, so we don't race recovery's ABSENT-case respawn or a
  # launcher coming up underneath us.
  if ! exec 9>>"$KAIROS_LOCK_PATH" 2>/dev/null; then
    # Tooling failure (lockfile unopenable) → FAIL-OPEN (availability > dedup).
    tmux new-session -d -s "$KAIROS_SESSION" "bash $HOME/bin/kairos-launcher.sh" 9>&-
    echo "Launched Kairos monitor (FAIL-OPEN: lock unopenable) in tmux session: $KAIROS_SESSION"
  else
    "$KAIROS_PYTHON" -c 'import fcntl,sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(3)     # BUSY — a peer spawner holds it (normal skip)
except OSError:
    sys.exit(4)     # tooling failure → fail-open
sys.exit(0)'
    plock=$?
    case "$plock" in
      0)
        # ACQUIRED. Critical section = an under-lock has-session RE-CHECK, then
        # the `tmux new-session` ONLY, then RELEASE immediately. Re-check
        # has-session: a peer may have (re)created the session between our
        # pre-filter and the acquire — starting a second
        # `tmux new-session -s kairos` would COLLIDE. That SESSION race is the
        # ONLY thing launch-all can lose by racing, and this re-check closes it.
        #
        # LIVELOCK FIX: we deliberately DO NOT wait for the MONITOR to become
        # visible here. The monitor is spawned by the LAUNCHER that this tmux
        # session runs, and the launcher must acquire the SAME lock to spawn it.
        # If we held the lock across a monitor-visible wait, the launcher would
        # BUSY-spin for the whole window, the monitor would never appear inside
        # it, and we would ALWAYS time out (wasted seconds every 300s cycle + a
        # launcher fork-spin). Monitor-level TOCTOU is the launcher's + recovery's
        # responsibility — they acquire this lock AFTER we release it just below.
        if tmux has-session -t "$KAIROS_SESSION" 2>/dev/null || kairos_monitor_alive; then
          echo "Kairos already running (seen under lock) — skip."
        else
          tmux new-session -d -s "$KAIROS_SESSION" "bash $HOME/bin/kairos-launcher.sh" 9>&-
          echo "Launched Kairos monitor in tmux session: $KAIROS_SESSION"
        fi
        exec 9>&-   # release IMMEDIATELY after the session-create critical action
        ;;
      3)
        # BUSY: a peer spawner (recovery/launcher) is mid-spawn. NORMAL skip —
        # do NOT create the session, do NOT fail-open.
        exec 9>&-
        echo "Kairos spawn: shared lock BUSY — peer spawner active, skipping."
        ;;
      *)
        # Genuine tooling failure → FAIL-OPEN. BUSY(3) is handled above, so a
        # busy lock is never treated as a fail-open.
        exec 9>&-
        tmux new-session -d -s "$KAIROS_SESSION" "bash $HOME/bin/kairos-launcher.sh" 9>&-
        echo "Launched Kairos monitor (FAIL-OPEN: lock helper code=$plock) in tmux session: $KAIROS_SESSION"
        ;;
    esac
  fi
else
  echo "Kairos already running."
fi

# Watchdog is now managed exclusively by com.threadwork.watchdog launchd job.
# Do not spawn a tmux watchdog session — it causes a duplicate process that
# loops forever unable to acquire the lease held by the launchd instance.
