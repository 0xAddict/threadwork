#!/usr/bin/env bash
# tests/hooks/emit-state.test.sh — TDD shell tests for emit-state.sh hook
#
# Acceptance criteria verified:
#   1. Script exists and is executable
#   2. Integration: JSONL append + agent_sessions SQLite row match
#   3. Perf: 100 calls in <2s wall time
#   4. Silent failure: exits 0 when agent identity is empty
#   5. Snoopy regression: Stop hook wired; coexists with PreToolUse recycle
#   6. settings.json: all 7 hook points wired to emit-state.sh
#
# Usage: bash tests/hooks/emit-state.test.sh
# Exit 0 = all pass, Exit 1 = at least one failure

set -uo pipefail

EMIT="$HOME/.claude/hooks/emit-state.sh"
TASKS_DB="$HOME/.claude/mcp-servers/task-board/tasks.db"
JSONL_DIR="$HOME/.claude/state/heartbeat-v2"
SETTINGS="$HOME/.claude/settings.json"
TEST_SESSION="claude-test"
TMUX_BIN="/Users/coachstokes/.local/bin/tmux"

PASS=0
FAIL=0

ok()   { printf "  ✓ %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ✗ %s — %s\n" "$1" "$2"; FAIL=$((FAIL + 1)); }
section() { printf "\n=== %s ===\n" "$1"; }

ms_now() { python3 -c "import time; print(int(time.time() * 1000))"; }

cleanup() {
  sqlite3 "$TASKS_DB" "DELETE FROM agent_sessions WHERE agent='test';" 2>/dev/null || true
  rm -f "$JSONL_DIR/state-test.jsonl" /tmp/emit-perf-result.txt
  "$TMUX_BIN" kill-session -t "$TEST_SESSION" 2>/dev/null || true
}
trap cleanup EXIT

section "Setup"
mkdir -p "$JSONL_DIR"
"$TMUX_BIN" new-session -d -s "$TEST_SESSION" 2>/dev/null || true
sleep 0.2

# ─── 1. Script existence ─────────────────────────────────────────────────────
section "1. Script existence"
if [ -f "$EMIT" ] && [ -x "$EMIT" ]; then
  ok "emit-state.sh exists and is executable"
else
  fail "emit-state.sh exists and is executable" "not found or not executable: $EMIT"
  printf "\nFATAL: emit-state.sh missing — skipping integration tests\n"
  printf "  %d pass / %d fail\n\n" "$PASS" "$FAIL"
  exit 1
fi

# ─── 2. Integration: JSONL append ────────────────────────────────────────────
section "2. Integration — JSONL"
rm -f "$JSONL_DIR/state-test.jsonl"
sqlite3 "$TASKS_DB" "DELETE FROM agent_sessions WHERE agent='test';" 2>/dev/null || true

# Run inside claude-test so '#S' → 'claude-test' → agent='test'
"$TMUX_BIN" run-shell -t "$TEST_SESSION" "bash '$EMIT' ACTIVE_THINKING 999 Bash"
sleep 0.5  # allow async sqlite subshell to complete

if [ -f "$JSONL_DIR/state-test.jsonl" ]; then
  LAST="$(tail -1 "$JSONL_DIR/state-test.jsonl")"
  if echo "$LAST" | grep -q '"state":"ACTIVE_THINKING"'; then
    ok "JSONL state=ACTIVE_THINKING"
  else
    fail "JSONL state" "expected ACTIVE_THINKING in: $LAST"
  fi
  if echo "$LAST" | grep -q '"agent":"test"'; then
    ok "JSONL agent=test (stripped from claude-test session)"
  else
    fail "JSONL agent" "expected test in: $LAST"
  fi
  if echo "$LAST" | grep -q '"task_id":"999"'; then
    ok "JSONL task_id=999"
  else
    fail "JSONL task_id" "expected 999 in: $LAST"
  fi
  if echo "$LAST" | grep -q '"source":"hook"'; then
    ok "JSONL source=hook"
  else
    fail "JSONL source" "expected hook in: $LAST"
  fi
else
  fail "JSONL file created" "missing: $JSONL_DIR/state-test.jsonl"
fi

# ─── 3. Integration: agent_sessions row ──────────────────────────────────────
section "3. Integration — agent_sessions SQLite"
ROW="$(sqlite3 "$TASKS_DB" \
  "SELECT agent,state,state_source,current_task_id,current_tool FROM agent_sessions WHERE agent='test';" \
  2>/dev/null || true)"

if [ -n "$ROW" ]; then
  ok "agent_sessions row exists for agent=test"
  echo "$ROW" | grep -q "ACTIVE_THINKING" && ok "state=ACTIVE_THINKING" \
    || fail "state" "expected ACTIVE_THINKING, got: $ROW"
  echo "$ROW" | grep -q "hook" && ok "state_source=hook" \
    || fail "state_source" "expected hook, got: $ROW"
  echo "$ROW" | grep -q "999" && ok "current_task_id=999" \
    || fail "current_task_id" "expected 999, got: $ROW"
  echo "$ROW" | grep -q "Bash" && ok "current_tool=Bash" \
    || fail "current_tool" "expected Bash, got: $ROW"
else
  fail "agent_sessions row" "no row for agent=test"
fi

# ─── 4. Performance: 100x calls in <2s ───────────────────────────────────────
section "4. Performance — 100x calls"
rm -f "$JSONL_DIR/state-test.jsonl"
START="$(ms_now)"
"$TMUX_BIN" run-shell -t "$TEST_SESSION" \
  "for i in \$(seq 1 100); do bash '$EMIT' ACTIVE_THINKING \$i Bash 2>/dev/null; done"
END="$(ms_now)"
ELAPSED=$(( END - START ))

if [ "$ELAPSED" -lt 2000 ]; then
  ok "100x calls: ${ELAPSED}ms < 2000ms"
else
  fail "100x perf" "${ELAPSED}ms >= 2000ms limit"
fi

sleep 0.3  # flush async sqlite writes
LINE_COUNT="$(wc -l < "$JSONL_DIR/state-test.jsonl" 2>/dev/null | tr -d ' ' || echo 0)"
if [ "$LINE_COUNT" -eq 100 ]; then
  ok "100 JSONL lines written"
else
  fail "JSONL line count" "expected 100, got $LINE_COUNT"
fi

# ─── 5. Silent failure on empty agent identity ────────────────────────────────
section "5. Silent failure — empty agent"
EXIT_CODE=0
# Run outside any named tmux session (TMUX unset or display-message fails → empty AGENT)
TMUX="" bash "$EMIT" ACTIVE_THINKING 123 Bash 2>/dev/null || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  ok "exits 0 with empty agent (silent fail)"
else
  fail "silent fail exit code" "expected 0, got $EXIT_CODE"
fi

# ─── 6. Stop hook: WAITING_HUMAN state ───────────────────────────────────────
section "6. Stop hook — WAITING_HUMAN"
rm -f "$JSONL_DIR/state-test.jsonl"
sqlite3 "$TASKS_DB" "DELETE FROM agent_sessions WHERE agent='test';" 2>/dev/null || true

"$TMUX_BIN" run-shell -t "$TEST_SESSION" "bash '$EMIT' WAITING_HUMAN '' ''"
sleep 0.5

STOP_STATE="$(sqlite3 "$TASKS_DB" \
  "SELECT state FROM agent_sessions WHERE agent='test';" 2>/dev/null || true)"
if [ "$STOP_STATE" = "WAITING_HUMAN" ]; then
  ok "Stop → WAITING_HUMAN written to agent_sessions"
else
  fail "Stop state" "expected WAITING_HUMAN, got: $STOP_STATE"
fi

STOP_JSONL="$(grep '"state":"WAITING_HUMAN"' "$JSONL_DIR/state-test.jsonl" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$STOP_JSONL" -gt 0 ]; then
  ok "Stop → WAITING_HUMAN in JSONL"
else
  fail "Stop JSONL" "no WAITING_HUMAN entry in JSONL"
fi

# ─── 7. settings.json — all 7 hook points wired ──────────────────────────────
section "7. settings.json wiring"

check_hook() {
  local event="$1" matcher="$2" label="$3"
  python3 - <<PY 2>/dev/null
import json, sys
with open('$SETTINGS') as f:
    s = json.load(f)
entries = s.get('hooks', {}).get('$event', [])
if not isinstance(entries, list):
    entries = [entries]
found = any(
    'emit-state.sh' in str(h.get('hooks', [])) and
    h.get('matcher', '') == '$matcher'
    for h in entries
)
sys.exit(0 if found else 1)
PY
}

check_hook "SessionStart"      ""      "SessionStart (no matcher)"   && ok "SessionStart → emit-state.sh"     || fail "SessionStart wiring"     "not found"
check_hook "UserPromptSubmit"  ""      "UserPromptSubmit"            && ok "UserPromptSubmit → emit-state.sh" || fail "UserPromptSubmit wiring"  "not found"
check_hook "PreToolUse"        "Agent" "PreToolUse matcher=Agent"    && ok "PreToolUse(Agent) → emit-state.sh" || fail "PreToolUse(Agent) wiring" "not found"
check_hook "PreToolUse"        ""      "PreToolUse generic"          && ok "PreToolUse(generic) → emit-state.sh" || fail "PreToolUse(generic) wiring" "not found"
check_hook "PostToolUse"       ""      "PostToolUse"                 && ok "PostToolUse → emit-state.sh"      || fail "PostToolUse wiring"       "not found"
check_hook "SubagentStop"      ""      "SubagentStop"                && ok "SubagentStop → emit-state.sh"     || fail "SubagentStop wiring"       "not found"
check_hook "Stop"              ""      "Stop (new)"                  && ok "Stop → emit-state.sh (NEW)"       || fail "Stop wiring"               "not found"

# ─── 8. Snoopy regression — coexistence ──────────────────────────────────────
section "8. Snoopy regression — coexistence"
# The Stop hook fires at session end; PreToolUse context-budget-watch fires on tool calls.
# They use different lifecycle events so cannot interfere. Verify:
#   a) context-budget-watch.sh is still wired to PreToolUse (not displaced)
#   b) Stop hook emit is independent

python3 - <<'PY' 2>/dev/null
import json, sys
with open('/Users/coachstokes/.claude/settings.json') as f:
    s = json.load(f)
entries = s.get('hooks', {}).get('PreToolUse', [])
if not isinstance(entries, list):
    entries = [entries]
found = any(
    'context-budget-watch.sh' in str(h.get('hooks', []))
    for h in entries
)
sys.exit(0 if found else 1)
PY
if [ $? -eq 0 ]; then
  ok "context-budget-watch.sh still wired to PreToolUse (Snoopy recycle intact)"
else
  fail "Snoopy recycle" "context-budget-watch.sh missing from PreToolUse hooks"
fi

# Verify Stop hook does not touch context-budget-watch.sh
python3 - <<'PY' 2>/dev/null
import json, sys
with open('/Users/coachstokes/.claude/settings.json') as f:
    s = json.load(f)
entries = s.get('hooks', {}).get('Stop', [])
if not isinstance(entries, list):
    entries = [entries]
bad = any(
    'context-budget-watch' in str(h.get('hooks', []))
    for h in entries
)
sys.exit(1 if bad else 0)
PY
if [ $? -eq 0 ]; then
  ok "Stop hook does not contain context-budget-watch.sh (clean separation)"
else
  fail "Snoopy separation" "context-budget-watch.sh leaked into Stop hook"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
printf "\n========================================\n"
printf "  %d pass / %d fail\n" "$PASS" "$FAIL"
printf "========================================\n\n"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
