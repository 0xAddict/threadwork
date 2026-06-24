#!/usr/bin/env bash
# =============================================================================
# sprint4-heartbeat-hook.sh — invokes Sprint 4 loop-detector + escalation-bridge
# from heartbeat-daemon-v2.sh, FAIL-SAFE and FIRE-AND-FORGET.
#
# Called from heartbeat-daemon-v2.sh classify_agent_v2() AFTER alert_v2 (~L541).
#
# Args (positional):
#   $1 agent                    e.g. "boss"
#   $2 ext_status               ALIVE | STUCK | CRASHED | IDLE | UNKNOWN
#   $3 declared_state           e.g. TOOL_IN_FLIGHT
#   $4 declared_source          e.g. hook | task-board | none
#   $5 reason                   human-readable
#   $6 consecutive_stuck        integer
#   $7 state_age_sec            integer
#   $8 method                   classifier method
#
# Design contract:
#   - NEVER block the parent daemon. We background the bun shell-out and exit
#     immediately. If bun is missing, modules error, or anything else goes
#     wrong, the daemon loop is unaffected.
#   - Per-invocation log: ~/.claude/state/heartbeat-v2/sprint4-hook.log
#   - State writes are owned by the loop-detector / escalation-bridge modules
#     themselves (loop-detector.json, escalation.json, audit log).
#   - Failure modes:
#       * bun not on PATH      → log & exit 0 (fail-safe)
#       * bun shell-out crash  → captured in stderr log, daemon unaffected
#       * runs > 5s            → daemon already moved on; orphan finishes
#                                (next tick re-evaluates from disk state)
# =============================================================================

set +e  # NEVER abort on a sub-step

HOOK_LOG="${HOME}/.claude/state/heartbeat-v2/sprint4-hook.log"
mkdir -p "$(dirname "$HOOK_LOG")" 2>/dev/null || true

agent="${1:-unknown}"
ext_status="${2:-UNKNOWN}"
declared_state="${3:-UNKNOWN}"
declared_source="${4:-none}"
reason="${5:-}"
consecutive="${6:-0}"
state_age_sec="${7:-0}"
method="${8:-}"

# Locate bun. If absent, fail-safe.
BUN_BIN="${BUN_BIN:-/Users/coachstokes/.bun/bin/bun}"
if [[ ! -x "$BUN_BIN" ]] && ! command -v bun >/dev/null 2>&1; then
  echo "[$(date '+%F %T')] $agent: bun not found — hook skipped (fail-safe)" >> "$HOOK_LOG"
  exit 0
fi
[[ ! -x "$BUN_BIN" ]] && BUN_BIN="$(command -v bun)"

TASK_BOARD_DIR="${HOME}/.claude/mcp-servers/task-board"
if [[ ! -d "$TASK_BOARD_DIR" ]]; then
  echo "[$(date '+%F %T')] $agent: task-board dir missing ($TASK_BOARD_DIR) — hook skipped" >> "$HOOK_LOG"
  exit 0
fi

# Map heartbeat-v2 external status to classifier state for Sprint 4 modules
case "$ext_status" in
  ALIVE)   classifier_state="ALIVE"   ;;
  IDLE)    classifier_state="IDLE"    ;;
  STUCK)   classifier_state="STUCK"   ;;
  CRASHED) classifier_state="STUCK"   ;;  # treat CRASHED as STUCK for escalation
  *)       classifier_state="ALIVE"   ;;
esac

# JSON-escape helper (very small surface; only string fields)
json_esc() {
  printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'
}

agent_j="$(json_esc "$agent")"
state_j="$(json_esc "$classifier_state")"
declared_j="$(json_esc "$declared_state")"
reason_j="$(json_esc "$reason")"
method_j="$(json_esc "$method")"

# Build the bun program. Inputs are passed via env vars to keep heredoc clean.
export SPRINT4_AGENT="$agent"
export SPRINT4_CLASSIFIER_STATE="$classifier_state"
export SPRINT4_REASON_CLASS="$method"
export SPRINT4_LAST_STATUS="$reason"
export SPRINT4_DECLARED_STATE="$declared_state"
export SPRINT4_CONSECUTIVE="$consecutive"

# Serialize all hook invocations through a single mkdir-lock so concurrent
# per-agent calls don't race on EscalationBridge's flock(2). If the lock is
# held, queue ourselves with a short retry; if still locked after 4s, drop
# this tick (fail-safe — next tick re-evaluates).
HOOK_LOCK="${HOME}/.claude/state/heartbeat-v2/sprint4-hook.lock"
acquired=0
for i in 1 2 3 4 5 6 7 8; do
  if mkdir "$HOOK_LOCK" 2>/dev/null; then
    acquired=1
    break
  fi
  # Stale lock cleanup: if older than 30s, remove and retry
  if [[ -d "$HOOK_LOCK" ]]; then
    lock_age=$(( $(date +%s) - $(stat -f%c "$HOOK_LOCK" 2>/dev/null || date +%s) ))
    if (( lock_age > 30 )); then
      rm -rf "$HOOK_LOCK" 2>/dev/null
    fi
  fi
  sleep 0.5
done
if (( acquired == 0 )); then
  echo "[$(date '+%F %T')] $agent: hook-lock contention — skipping this tick (fail-safe)" >> "$HOOK_LOG"
  exit 0
fi

# Fire-and-forget: nohup + & so the daemon NEVER waits.
# The background job is responsible for releasing the lock.
( "$BUN_BIN" run - >>"$HOOK_LOG" 2>&1 <<'TS'
import { LoopDetector } from '/Users/coachstokes/.claude/mcp-servers/task-board/src/loop-detector/index.ts'
import { EscalationBridge } from '/Users/coachstokes/.claude/mcp-servers/task-board/src/escalation-bridge/index.ts'

const agent = process.env['SPRINT4_AGENT'] ?? ''
const classState = (process.env['SPRINT4_CLASSIFIER_STATE'] ?? 'ALIVE') as
  'ALIVE'|'IDLE'|'STUCK'|'PARKED_PICKER'|'PARKED_PICKER_STALE'|'WATCHDOG_DEAD'|'LOOP'
const reasonClass = process.env['SPRINT4_REASON_CLASS'] ?? ''
const lastStatus = process.env['SPRINT4_LAST_STATUS'] ?? ''

if (!agent) { process.stderr.write('[sprint4-hook] no agent — skipping\n'); process.exit(0) }

const ts = new Date().toISOString()

// ── Loop Detector ─────────────────────────────────────────────────────────
try {
  const ld = new LoopDetector()
  const result = ld.tick(agent, {
    classifierState: classState,
    status_text: lastStatus,
    tool_call_signature: null,
    pane_bottom_line: process.env['SPRINT4_DECLARED_STATE'] ?? null,
    has_transcript_entry: true,
    has_write_status: true,
  })
  if (result.is_loop) {
    process.stdout.write(`[${ts}] ${agent}: LOOP detected (hash=${result.hash})\n`)
  } else if (result.recovery) {
    process.stdout.write(`[${ts}] ${agent}: LOOP recovery\n`)
  }
} catch (err) {
  process.stderr.write(`[${ts}] ${agent}: loop-detector error: ${err}\n`)
}

// ── Escalation Bridge ────────────────────────────────────────────────────
// Fire-and-forget callbacks: we log instead of taking real action here so the
// soak is observation-only until the team explicitly opts agents in.
try {
  const bridge = new EscalationBridge({
    onNudgeAgent: async (target, msg) => {
      process.stdout.write(`[${ts}] ESC nudge -> ${target}: ${msg.slice(0,80)}...\n`)
    },
    onInterruptAgent: async (target) => {
      process.stdout.write(`[${ts}] ESC interrupt -> ${target}\n`)
    },
    onSendNote: async (taskId, msg) => {
      process.stdout.write(`[${ts}] ESC boss-note (${taskId}): ${msg.slice(0,80)}...\n`)
    },
    onCriticalTelegram: async (msg) => {
      process.stderr.write(`[${ts}] ESC critical-tg: ${msg}\n`)
    },
  })
  await bridge.tick(agent, {
    classifierState: classState,
    reason_class: reasonClass,
    last_status_text: lastStatus,
    agent_status_updated_at: Math.floor(Date.now() / 1000),
  })
  bridge.destroy()
} catch (err) {
  process.stderr.write(`[${ts}] ${agent}: escalation-bridge error: ${err}\n`)
}
TS
  rm -rf "$HOOK_LOCK" 2>/dev/null
) >/dev/null 2>&1 &

# Detach: don't let the parent shell wait on the bun pid
disown 2>/dev/null || true

# Optional: prune log if it grows past ~5MB (keep last ~2MB)
if [[ -f "$HOOK_LOG" ]]; then
  log_size=$(stat -f%z "$HOOK_LOG" 2>/dev/null || echo 0)
  if (( log_size > 5242880 )); then
    tail -c 2097152 "$HOOK_LOG" > "${HOOK_LOG}.tmp" && mv "${HOOK_LOG}.tmp" "$HOOK_LOG"
  fi
fi

exit 0
