#!/usr/bin/env bash
# context-budget-watch.sh — PreToolUse hook
# Estimates context utilization from the active session's transcript JSONL.
# Fires a one-time warning when the agent crosses 60% of the configured budget.
# #638: operationalize the evacuate-then-rehydrate pattern (deep-research v2 finding c).
# #643/#644: nudge persistent claude-snoopy via tmux send-keys instead of
# spawning a one-shot `claude -p haiku` (which never had MCP access).
# Default budget bumped 200K → 1M to match modern 1M-context sessions.
#
# Always exit 0 — informational only, never blocks tool calls.

set -u

CHAT_BUDGET="${CLAUDE_CONTEXT_BUDGET_TOKENS:-1000000}"  # default 1M (matches modern 1M-context sessions); override via env
WARN_PCT="${CLAUDE_CONTEXT_WARN_PCT:-60}"
STATE_DIR="$HOME/.claude/state/context-budget"
DEBUG_LOG="$STATE_DIR/debug.log"

mkdir -p "$STATE_DIR" 2>/dev/null

trap 'exit 0' EXIT

log() {
  local ts
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '%s %s\n' "$ts" "$*" >> "$DEBUG_LOG" 2>/dev/null
}

# Read stdin JSON; extract session_id
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat 2>/dev/null || true)
fi

[ -z "$STDIN_DATA" ] && exit 0

session_id=$(printf '%s' "$STDIN_DATA" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    sid = d.get("session_id") or (d.get("tool", {}) or {}).get("session_id") or ""
    print(sid)
except Exception:
    pass
' 2>/dev/null)

[ -z "$session_id" ] && { log "no session_id in stdin"; exit 0; }

# Find the transcript jsonl file. Path layout has shifted historically; glob defensively.
transcript=""
for candidate in \
  "$HOME/.claude/projects/-/${session_id}.jsonl" \
  "$HOME/.claude/projects/"*"/${session_id}.jsonl"; do
  if [ -f "$candidate" ]; then
    transcript="$candidate"
    break
  fi
done

[ -z "$transcript" ] && { log "no transcript for session $session_id"; exit 0; }

bytes=$(wc -c < "$transcript" 2>/dev/null | tr -d ' ')
[ -z "$bytes" ] && { log "wc failed on $transcript"; exit 0; }

# Rough proxy: 1 token ≈ 4 bytes (overestimates a bit, fine for a recycle trigger)
est_tokens=$((bytes / 4))
threshold=$((CHAT_BUDGET * WARN_PCT / 100))

state_file="$STATE_DIR/state-${session_id}.json"

if [ "$est_tokens" -lt "$threshold" ]; then
  log "session $session_id under budget: ${est_tokens}/${CHAT_BUDGET} (<${WARN_PCT}%)"
  exit 0
fi

# Dedup — only warn once per session at the 60% tier.
already_warned=""
if [ -f "$state_file" ]; then
  already_warned=$(python3 -c "
import json
try:
    d = json.load(open('$state_file'))
    print(d.get('warned_60', ''))
except Exception:
    pass
" 2>/dev/null)
fi

if [ -n "$already_warned" ]; then
  log "session $session_id already warned at 60%, suppressing"
  exit 0
fi

# Record the warn
ISO_TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
python3 -c "
import json
with open('$state_file', 'w') as f:
    json.dump({'warned_60': '$ISO_TS', 'est_tokens': $est_tokens, 'budget': $CHAT_BUDGET}, f)
" 2>/dev/null

# --- Auto-recycle dispatch (#643/#644) ---
# Nudge the persistent `claude-snoopy` tmux session via send-keys with a
# structured AUTO-RECYCLE NUDGE block. Snoopy runs the SOP (force_debrief →
# save_memory → tmux /clear into target's pane → Telegram ping GweiSprayer).
#
# The legacy `claude -p haiku` dispatch was retired because the headless
# invocation never had MCP access (force_debrief / save_memory / telegram
# reply all unavailable). Snoopy is L0 superuser with full MCP — he is the
# right place to run the recycle SOP.
RECYCLE_AGENT="${AGENT_LABEL:-unknown}"
DISPATCH_LOG="$STATE_DIR/dispatch-${session_id}.log"
RECYCLE_TEST_MODE="${RECYCLE_TEST_MODE:-0}"
SNOOPY_SESSION="claude-snoopy"
DISPATCH_OUTCOME=""   # set to "nudged" | "self-loop" | "snoopy-offline"

# Pre-touch the restart-window flag (TG #5371 / task #1134) so the watchdog
# starts suppressing false-positive heartbeat-overdue / circuit-open alerts
# the moment a recycle is initiated. Without this, there is a ~30-90s gap
# between Snoopy receiving the AUTO-RECYCLE nudge and the new session firing
# session-boot.sh — during which the old session has gone silent and the
# watchdog would page GweiSprayer. session-boot.sh re-touches the flag once
# the fresh session boots, refreshing the TTL.
if [ -n "$RECYCLE_AGENT" ] && [ "$RECYCLE_AGENT" != "unknown" ]; then
  RESTART_FLAG_DIR="$HOME/.claude/state/restart-window"
  mkdir -p "$RESTART_FLAG_DIR" 2>/dev/null
  touch "$RESTART_FLAG_DIR/$RECYCLE_AGENT.flag" 2>/dev/null || true
fi

# Self-loop guard — don't ask Snoopy to recycle himself.
if [ "$RECYCLE_AGENT" = "snoopy" ]; then
  echo "[$ISO_TS] dispatch SKIPPED: target agent is snoopy (self-loop guard)" >> "$DISPATCH_LOG"
  DISPATCH_OUTCOME="self-loop"
elif ! tmux has-session -t "$SNOOPY_SESSION" 2>/dev/null; then
  # Snoopy offline — fall back to the stdout banner only. Operator can read
  # it in the agent's own pane and run /recycle manually.
  echo "[$ISO_TS] dispatch SKIPPED: tmux session '$SNOOPY_SESSION' not found; falling back to banner-only" >> "$DISPATCH_LOG"
  DISPATCH_OUTCOME="snoopy-offline"
else
  TEST_PREFIX=""
  [ "$RECYCLE_TEST_MODE" = "1" ] && TEST_PREFIX="[TEST] "

  # Compose the brief Snoopy will see in his pane. Markdown-style header +
  # key/value lines + an explicit SOP instruction line.
  BRIEF=$(cat <<EOF
${TEST_PREFIX}🛎️ AUTO-RECYCLE NUDGE
target_agent: ${RECYCLE_AGENT}
session_id: ${session_id}
iso_ts: ${ISO_TS}
est_tokens: ${est_tokens}
budget: ${CHAT_BUDGET}
test_mode: ${RECYCLE_TEST_MODE}

Run your auto-recycle SOP: force_debrief (boss only) → save handoff memory ([session-handoff:${RECYCLE_AGENT}:${ISO_TS}]) → tmux send-keys '/clear' Enter into claude-${RECYCLE_AGENT} → TG nudge GweiSprayer (chat 1712539766) with handoff memory id. See pinned [snoopy-sop] memory for full playbook.
EOF
)

  echo "[$ISO_TS] dispatching tmux nudge to $SNOOPY_SESSION for agent=$RECYCLE_AGENT session=$session_id tokens=${est_tokens}/${CHAT_BUDGET} test_mode=$RECYCLE_TEST_MODE" >> "$DISPATCH_LOG"

  # Use `-l` (literal) for the brief text so tmux doesn't interpret slashes,
  # newlines, or markdown chars as command escapes. Then send Enter as a
  # SEPARATE call (not chained with &&) so a stale half-typed brief is never
  # left hanging in Snoopy's prompt.
  tmux send-keys -t "$SNOOPY_SESSION" -l "$BRIEF" 2>>"$DISPATCH_LOG"
  tmux send-keys -t "$SNOOPY_SESSION" Enter 2>>"$DISPATCH_LOG"

  echo "[$ISO_TS] tmux nudge sent" >> "$DISPATCH_LOG"
  DISPATCH_OUTCOME="nudged"
fi

# Surface to the agent. Claude Code prints PreToolUse hook stdout as a system
# message. Useful even when the Snoopy nudge fires — agent (and any human
# tailing the pane) gets immediate visibility, plus this is the only signal
# if Snoopy is offline (banner-only fallback) or self-loop guard tripped.
case "$DISPATCH_OUTCOME" in
  nudged)
    OUTCOME_BLOCK="claude-snoopy has been nudged via tmux to run the recycle SOP:
  1. force_debrief (if target is boss)
  2. save_memory with [session-handoff:${RECYCLE_AGENT}:${ISO_TS}] prefix
  3. tmux send-keys '/clear' Enter into claude-${RECYCLE_AGENT}
  4. Telegram nudge to GweiSprayer

ACTION REQUIRED: TYPE /clear NOW (Snoopy will also try to inject it)."
    ;;
  self-loop)
    OUTCOME_BLOCK="Self-loop guard tripped (target is snoopy). No tmux nudge sent.
ACTION REQUIRED: invoke the manual /recycle skill, then TYPE /clear NOW."
    ;;
  snoopy-offline)
    OUTCOME_BLOCK="claude-snoopy tmux session not found — banner-only fallback.
ACTION REQUIRED: invoke the manual /recycle skill, then TYPE /clear NOW."
    ;;
  *)
    OUTCOME_BLOCK="Dispatch outcome unknown — see ${DISPATCH_LOG}.
ACTION REQUIRED: TYPE /clear NOW."
    ;;
esac

cat <<EOF

⚠️ CONTEXT BUDGET ${WARN_PCT}% — auto-recycle dispatched.

Estimated context: ${est_tokens} / ${CHAT_BUDGET} tokens (${WARN_PCT}% threshold crossed).

${OUTCOME_BLOCK}

After /clear, SessionStart will auto-rehydrate from the handoff memory.

Reference: #643 / #644 — Snoopy-driven auto-recycle.

EOF

log "warned session $session_id: ${est_tokens}/${CHAT_BUDGET} (${WARN_PCT}% crossed); outcome=${DISPATCH_OUTCOME} agent=$RECYCLE_AGENT"
exit 0
