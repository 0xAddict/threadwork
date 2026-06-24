#!/bin/bash
# board-report-enforcer.test.sh — isolated test matrix for board-report-enforcer.sh
# Runs the REAL hook binary with crafted stdin + env. State is sandboxed via
# BOARD_REPORT_STATE_DIR. Run with /bin/bash (3.2) — that is the arming target.
set -u

HOOK="$HOME/.claude/hooks/board-report-enforcer.sh"
TMP=$(mktemp -d /tmp/brh-test.XXXXXX)
export BOARD_REPORT_STATE_DIR="$TMP/state"
mkdir -p "$BOARD_REPORT_STATE_DIR"
printf 'boss\nsteve\nsadie\nkiera\nsnoopy\n' > "$BOARD_REPORT_STATE_DIR/agents.enabled"

PASS=0; FAIL=0

mkjson() {
  # $1=tool $2=session $3=task_id(optional) $4=parent_task_id(optional)
  local tid_part="" ptid_part=""
  [ -n "${3:-}" ] && tid_part="\"task_id\": $3"
  [ -n "${4:-}" ] && ptid_part="\"parent_task_id\": $4"
  local inner=""
  [ -n "$tid_part" ] && inner="$tid_part"
  if [ -n "$ptid_part" ]; then
    [ -n "$inner" ] && inner="$inner, "
    inner="$inner$ptid_part"
  fi
  printf '{"tool_name": "%s", "session_id": "%s", "tool_input": {%s}}' "$1" "$2" "$inner"
}

run_hook() {
  # $1=mode $2=json ; env passed via caller. Sets RC and ERR.
  ERR=$(printf '%s' "$2" | /bin/bash "$HOOK" "$1" 2>&1 >/dev/null)
  RC=$?
}

check() {
  # $1=name $2=expected_rc $3=actual_rc [$4=substring-that-must-appear-in-ERR]
  local ok=1
  [ "$2" != "$3" ] && ok=0
  if [ -n "${4:-}" ]; then
    case "$ERR" in *"$4"*) ;; *) ok=0 ;; esac
  fi
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); echo "PASS  $1"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $1 (expected rc=$2 got rc=$3; want substr='${4:-}'; stderr: $(echo "$ERR" | head -3 | tr '\n' ' '))"
  fi
}

export AGENT_LABEL=boss
export BOARD_REPORT_NAG_COOLDOWN_SEC=120

# T1: syntax
/bin/bash -n "$HOOK"; check "T1a bash3.2 -n syntax" 0 $?
bash -n "$HOOK"; check "T1b env-bash -n syntax" 0 $?

# T2: empty/garbage stdin fail-open
ERR=$(printf '' | /bin/bash "$HOOK" post 2>&1 >/dev/null); RC=$?
check "T2a empty stdin post fail-open" 0 $RC
ERR=$(printf 'not-json' | /bin/bash "$HOOK" pre 2>&1 >/dev/null); RC=$?
check "T2b garbage stdin pre fail-open" 0 $RC

# T3: non-enabled agent never gated
S=t3sess
for i in 1 2 3 4 5; do
  AGENT_LABEL=stranger run_hook post "$(mkjson Bash $S)"
done
AGENT_LABEL=stranger run_hook post "$(mkjson mcp__task-board__claim_task $S 1713)"
AGENT_LABEL=stranger run_hook pre "$(mkjson Bash $S)"
check "T3 non-enabled agent: pre never blocks" 0 $RC

# T4: enabled agent, NON-board session: silent forever
S=t4sess
LAST=0
i=0
while [ $i -lt 40 ]; do
  run_hook post "$(mkjson Bash $S)"; LAST=$RC; i=$((i+1))
done
check "T4a non-board session: 40 Bash posts silent" 0 $LAST
run_hook pre "$(mkjson Bash $S)"
check "T4b non-board session: pre never blocks" 0 $RC

# T5: card tracked via claim_task, nag fires at NAG_CALLS
S=t5sess
run_hook post "$(mkjson mcp__task-board__claim_task $S 1713)"   # activity 1, card tracked
NAGGED=0
i=0
while [ $i -lt 14 ]; do
  run_hook post "$(mkjson Bash $S)"; i=$((i+1))
done
# that was activity 15 total -> nag expected on the last one
check "T5 nag fires at threshold (15 calls)" 2 $RC "BOARD-REPORTING NAG"
case "$ERR" in *"#1713"*) PASS=$((PASS+1)); echo "PASS  T5b nag names the card";; *) FAIL=$((FAIL+1)); echo "FAIL  T5b nag does not name card: $ERR";; esac

# T6: nag dedup (cooldown)
run_hook post "$(mkjson Bash $S)"
check "T6 nag deduped within cooldown" 0 $RC

# T7: drive into block zone; pre gate blocks non-exempt tool
i=0
while [ $i -lt 20 ]; do
  BOARD_REPORT_NAG_COOLDOWN_SEC=99999 run_hook post "$(mkjson Bash $S)"; i=$((i+1))
done
run_hook pre "$(mkjson Bash $S)"
check "T7a block zone: pre blocks Bash" 2 $RC "BOARD-REPORTING GATE"
run_hook pre "$(mkjson Edit $S)"
check "T7b block zone: pre blocks Edit" 2 $RC "send_note"

# T8: exempt tools NEVER blocked even in block zone (the #1617 lesson, explicit)
run_hook pre "$(mkjson mcp__task-board__send_note $S 1713)"
check "T8a send_note never blocked" 0 $RC
run_hook pre "$(mkjson mcp__task-board__write_status $S 1713)"
check "T8b write_status never blocked" 0 $RC
run_hook pre "$(mkjson mcp__task-board__complete_task $S 1713)"
check "T8c complete_task never blocked" 0 $RC
run_hook pre "$(mkjson mcp__plugin_telegram_telegram__reply $S)"
check "T8d telegram reply never blocked" 0 $RC
run_hook pre "$(mkjson ToolSearch $S)"
check "T8e ToolSearch never blocked (deferred-schema remediation path)" 0 $RC
run_hook pre "$(mkjson AskUserQuestion $S)"
check "T8f AskUserQuestion never blocked" 0 $RC

# T9: a report clears the gate immediately
run_hook post "$(mkjson mcp__task-board__send_note $S 1713)"
check "T9a send_note post resets (exit 0)" 0 $RC
run_hook pre "$(mkjson Bash $S)"
check "T9b gate cleared after note" 0 $RC

# T10: write_status also clears
i=0
while [ $i -lt 31 ]; do
  BOARD_REPORT_NAG_COOLDOWN_SEC=99999 run_hook post "$(mkjson Bash $S)"; i=$((i+1))
done
run_hook pre "$(mkjson Bash $S)"
check "T10a back in block zone" 2 $RC
run_hook post "$(mkjson mcp__task-board__write_status $S 1713)"
run_hook pre "$(mkjson Bash $S)"
check "T10b write_status clears gate" 0 $RC

# T11: time-based block (crafted state: 60 min of activity, only 5 calls)
S=t11sess
NOW=$(date +%s)
cat > "$BOARD_REPORT_STATE_DIR/session-$S.state" <<EOF
cards=1707
board_touched=1
activity_count=5
last_report_ts=$((NOW-4000))
first_activity_ts=$((NOW-3600))
last_nag_ts=0
EOF
run_hook pre "$(mkjson Bash $S)"
check "T11 time-based block (60min/5 calls)" 2 $RC "#1707"

# T12: board-touched but NO inferable card -> generic nag, never block
S=t12sess
run_hook post "$(mkjson mcp__task-board__nudge_agent $S)"
i=0
while [ $i -lt 35 ]; do
  BOARD_REPORT_NAG_COOLDOWN_SEC=99999 run_hook post "$(mkjson Bash $S)"; i=$((i+1))
done
run_hook pre "$(mkjson Bash $S)"
check "T12a no-card session: pre NEVER blocks" 0 $RC
rm -f "$BOARD_REPORT_STATE_DIR/session-$S.state"
run_hook post "$(mkjson mcp__task-board__nudge_agent $S)"
run_hook post "$(mkjson Bash $S)"; run_hook post "$(mkjson Bash $S)"
i=0
while [ $i -lt 12 ]; do
  run_hook post "$(mkjson Bash $S)"; i=$((i+1))
done
check "T12b no-card session: generic advisory nag" 2 $RC "no card"

# T13: per-call bypass works and is logged
S=t5sess
i=0
while [ $i -lt 31 ]; do
  BOARD_REPORT_NAG_COOLDOWN_SEC=99999 run_hook post "$(mkjson Bash $S)"; i=$((i+1))
done
BOARD_REPORT_BYPASS=1 run_hook pre "$(mkjson Bash $S)"
check "T13a BOARD_REPORT_BYPASS=1 passes" 0 $RC
[ -s "$BOARD_REPORT_STATE_DIR/bypass.log" ] && { PASS=$((PASS+1)); echo "PASS  T13b bypass logged"; } || { FAIL=$((FAIL+1)); echo "FAIL  T13b bypass.log empty"; }

# T14: kill-switch works and is logged
BOARD_REPORT_HOOK_DISABLED=1 run_hook pre "$(mkjson Bash $S)"
check "T14a kill-switch passes" 0 $RC
[ -s "$BOARD_REPORT_STATE_DIR/disabled.log" ] && { PASS=$((PASS+1)); echo "PASS  T14b disable logged"; } || { FAIL=$((FAIL+1)); echo "FAIL  T14b disabled.log empty"; }

# T15: exemption is checked BEFORE state/agent logic in pre mode
S=t5sess
ERR=$(printf '%s' "$(mkjson mcp__task-board__send_note $S 1713)" | env -u AGENT_LABEL /bin/bash "$HOOK" pre 2>&1 >/dev/null); RC=$?
check "T15 exempt check precedes everything (no AGENT_LABEL)" 0 $RC

# T16: set -u smoke under bash 3.2 with minimal env
ERR=$(printf '%s' "$(mkjson Bash t16sess)" | env -i HOME="$HOME" PATH="$PATH" BOARD_REPORT_STATE_DIR="$BOARD_REPORT_STATE_DIR" AGENT_LABEL=boss /bin/bash "$HOOK" post 2>&1 >/dev/null); RC=$?
check "T16 minimal-env set-u smoke" 0 $RC

echo ""
echo "RESULT: $PASS passed, $FAIL failed (state dir: $TMP)"
[ "$FAIL" = "0" ] && rm -rf "$TMP"
[ "$FAIL" = "0" ]
