#!/bin/bash
#
# telegram-poller-watchdog.test.sh
#
# Regression test suite for the idle/busy classifier (pane_state) in
# telegram-poller-watchdog.sh.
#
# It sources the REAL pane_state() function out of the production script (no
# copy) and feeds it verbatim tmux-capture fixtures via a stubbed `tmux`. Each
# fixture is written with the EXACT bytes a real Claude Code pane emits — in
# particular the empty input row is "❯" + U+00A0 NO-BREAK SPACE (bytes c2 a0),
# which is what fooled the detector in the 2026-06-11 incident.
#
# CRITICAL: the suite runs every case under BOTH a UTF-8 locale AND the
# C/POSIX locale, because the launchd job runs with no LANG/LC_ALL set. The
# original bug only manifested under C/POSIX (where [[:space:]] does not match
# the multibyte nbsp), so testing only under UTF-8 would have missed it.
#
# Run anytime:  bash ~/bin/telegram-poller-watchdog.test.sh
# Exit code 0 = all pass, 1 = at least one failure.

set -u
SCRIPT="$HOME/bin/telegram-poller-watchdog.sh"
TMPDIR_T=$(mktemp -d)
trap 'rm -rf "$TMPDIR_T"' EXIT

PASS=0
FAIL=0

# ----------------------------------------------------------------------------
# Harness: source the real pane_state() and stub tmux to emit a fixture.
# ----------------------------------------------------------------------------
make_harness() {
  cat > "$TMPDIR_T/shim.sh" <<HARNESS
#!/bin/bash
set -u
FIXTURE="\$1"
ts() { :; }
log() { :; }
# Extract ONLY the pane_state function from the production script and eval it,
# so we exercise the real classifier rather than a duplicate.
eval "\$(awk '/^pane_state\(\) \{/,/^\}/' "$SCRIPT")"
tmux() {
  if [ "\$1" = "capture-pane" ]; then cat "\$FIXTURE"; return 0; fi
  return 0
}
pane_state testagent
HARNESS
}

# Assert that fixture-file $1 classifies as $2 under both locales.
assert_state() {
  local name="$1" fixture="$2" expect="$3" loc got
  for loc in "LANG=C.UTF-8" "LC_ALL=C LANG=C"; do
    got=$(env $loc bash "$TMPDIR_T/shim.sh" "$fixture")
    if [ "$got" = "$expect" ]; then
      PASS=$((PASS + 1))
      printf '  PASS [%s] %s -> %s\n' "$loc" "$name" "$got"
    else
      FAIL=$((FAIL + 1))
      printf '  FAIL [%s] %s -> got "%s", expected "%s"\n' "$loc" "$name" "$got" "$expect"
    fi
  done
}

make_harness

# ----------------------------------------------------------------------------
# Fixtures (exact bytes; ❯ = e2 9d af, nbsp = c2 a0)
# ----------------------------------------------------------------------------

# (i) REGRESSION — incident 2026-06-11, Boss stranded ~14 min.
# Background-shell + completed past-tense summary pane MUST classify IDLE, not
# busy. Empty input row is "❯" + nbsp. "✻ Cogitated for ..." is a PAST-TENSE
# completed summary (not an active spinner); "1 shell still running" is just a
# detached background bash; bottom bar shows "← for agents" (NOT "esc to
# interrupt"). This is the verbatim pane that fooled the detector.
F_I="$TMPDIR_T/case_i_regression.txt"
{
  printf '\xe2\x9c\xbb Cogitated for 1m 4s \xc2\xb7 1 shell still running\n'
  printf '\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\n'
  printf '\xe2\x9d\xaf\xc2\xa0\n'
  printf '\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\n'
  printf '  \xe2\x8f\xb5\xe2\x8f\xb5 bypass permissions on \xc2\xb7 1 shell \xc2\xb7 \xe2\x86\x90 for agents \xc2\xb7 \xe2\x86\x93 to manage\n'
} > "$F_I"

# (ii) "esc to interrupt" in the bottom status bar -> BUSY (active generation).
F_II="$TMPDIR_T/case_ii_esc_interrupt.txt"
{
  printf '\xe2\x9c\xbb Cogitating\xe2\x80\xa6\n'
  printf '\xe2\x9d\xaf\xc2\xa0\n'
  printf '  esc to interrupt\n'
} > "$F_II"

# (iii) "Waiting for 1 background agent to finish" -> BUSY (sub-agent in flight).
F_III="$TMPDIR_T/case_iii_waiting_bg_agent.txt"
{
  printf '\xe2\x9c\xbb Waiting for 1 background agent to finish\n'
  printf '\xe2\x9d\xaf\xc2\xa0\n'
} > "$F_III"

# (iv) active spinner "Cogitating… (12s)" -> BUSY (verb + in-progress ellipsis).
F_IV="$TMPDIR_T/case_iv_active_spinner.txt"
{
  printf '\xe2\x9c\xbb Cogitating\xe2\x80\xa6 (12s)\n'
  printf '\xe2\x9d\xaf\xc2\xa0\n'
  printf '  \xe2\x8f\xb5\xe2\x8f\xb5 bypass permissions on\n'
} > "$F_IV"

# (v) clean empty prompt with "← for agents" bottom bar -> IDLE.
F_V="$TMPDIR_T/case_v_clean_idle.txt"
{
  printf '\xe2\x9d\xaf\xc2\xa0\n'
  printf '  \xe2\x8f\xb5\xe2\x8f\xb5 bypass permissions on \xc2\xb7 \xe2\x86\x90 for agents \xc2\xb7 \xe2\x86\x93 to manage\n'
} > "$F_V"

# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------
echo "telegram-poller-watchdog idle/busy classifier — regression suite"
echo "(each case asserted under UTF-8 AND C/POSIX = launchd locale)"
echo

assert_state "regression: background-shell + completed-summary pane is IDLE not busy / incident 2026-06-11 Boss-stranded" "$F_I" "IDLE"
assert_state "esc-to-interrupt in bottom bar is BUSY"                  "$F_II"  "BUSY"
assert_state "Waiting-for-N-background-agent is BUSY"                  "$F_III" "BUSY"
assert_state "active spinner 'Cogitating…' is BUSY"                    "$F_IV"  "BUSY"
assert_state "clean empty prompt (← for agents) is IDLE"              "$F_V"   "IDLE"

echo
echo "------------------------------------------------------------"
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
