#!/usr/bin/env bash
# spec_gate.sh — Physical hard gate for the Explorer/Planner/Executor/Verifier pipeline.
#
# This script is the single enforcement point for sprint contracts. It is wired
# into the PreToolUse hook on mcp__task-board__complete_task. Agents CANNOT
# bypass it — any non-zero exit causes the harness to emit a decision:block JSON
# that stops task completion.
#
# Subcommands:
#   contract-sign   <contract.json>              Canonicalize + SHA256 + write signature
#   contract-verify <contract.json>              Verify signature matches canonical hash
#   lane-scope      <contract.json> <lane_id>    Ensure changed files stay inside allowed_paths
#   lane-verify     <contract.json> <lane_id>    Run every AC test_command + check verifier-report
#   sprint-close    <contract.json>              Terminal gate: all lanes + all global gates pass
#
# Exit codes:
#   0   pass — caller may proceed
#   1   fail — contract/gate violation (BLOCKS completion)
#   2   usage error (BLOCKS completion — treat as fail)
#   3   missing dependency (BLOCKS completion)
#
# Every invocation appends an audit entry to:
#   {dirname contract.json}/gate.log
#
# Required tools: bash (>=4), jq, sha256sum (or shasum -a 256), git
#
# Author: sadie-agent, task #264, 2026-04-10

set -euo pipefail

# ---------- deps ----------
command -v jq >/dev/null 2>&1 || { echo "spec_gate: jq not found" >&2; exit 3; }
if command -v sha256sum >/dev/null 2>&1; then
  SHA() { sha256sum | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  SHA() { shasum -a 256 | awk '{print $1}'; }
else
  echo "spec_gate: no sha256sum or shasum available" >&2
  exit 3
fi

# ---------- logging ----------
log_event() {
  local contract="$1"; shift
  local dir
  dir="$(dirname "$contract")"
  mkdir -p "$dir"
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$dir/gate.log"
}

fail() {
  local contract="$1"; shift
  log_event "$contract" "FAIL: $*"
  echo "spec_gate: FAIL: $*" >&2
  exit 1
}

pass() {
  local contract="$1"; shift
  log_event "$contract" "PASS: $*"
  echo "spec_gate: PASS: $*"
  exit 0
}

usage() {
  cat >&2 <<'EOF'
Usage:
  spec_gate.sh contract-sign   <contract.json>
  spec_gate.sh contract-verify <contract.json>
  spec_gate.sh lane-scope      <contract.json> <lane_id>
  spec_gate.sh lane-verify     <contract.json> <lane_id>
  spec_gate.sh sprint-close    <contract.json>
EOF
  exit 2
}

# ---------- helpers ----------

# Canonical JSON = sorted keys, compact, no signature field.
# Used for signing and verifying.
canonical() {
  local f="$1"
  jq -Sc 'del(.signature)' "$f"
}

require_file() {
  [[ -f "$1" ]] || { echo "spec_gate: missing file: $1" >&2; exit 1; }
}

# Check that two glob patterns (bash extglob) overlap. Returns 0 if they do.
# Used by contract-sign to reject contracts with overlapping lanes.
globs_overlap() {
  local a="$1" b="$2"
  # A weak but pragmatic check: prefix match. If either glob's non-wildcard prefix
  # is a prefix of the other's, they may overlap and we reject.
  local pa pb
  pa="${a%%\**}"; pa="${pa%%\?*}"; pa="${pa%%\[*}"
  pb="${b%%\**}"; pb="${pb%%\?*}"; pb="${pb%%\[*}"
  if [[ -z "$pa" || -z "$pb" ]]; then
    return 0  # empty prefix = matches everything = overlap
  fi
  if [[ "$pa" == "$pb"* || "$pb" == "$pa"* ]]; then
    return 0
  fi
  return 1
}

# Test a path against a JSON array of globs. Returns 0 if path matches any.
path_matches_any() {
  local path="$1"
  shift
  local glob
  shopt -s extglob globstar nullglob
  for glob in "$@"; do
    # shellcheck disable=SC2053
    if [[ "$path" == $glob ]]; then
      return 0
    fi
  done
  return 1
}

# ---------- subcommand: contract-sign ----------
cmd_contract_sign() {
  local contract="${1:-}"; [[ -n "$contract" ]] || usage
  require_file "$contract"

  log_event "$contract" "contract-sign start"

  # Validate required fields
  local sv sid lanes_n
  sv="$(jq -r '.schema_version // empty' "$contract")"
  sid="$(jq -r '.sprint_id // empty' "$contract")"
  lanes_n="$(jq '.lanes | length' "$contract")"

  [[ "$sv" == "1.0" ]]            || fail "$contract" "schema_version must be 1.0 (got: $sv)"
  [[ -n "$sid" ]]                 || fail "$contract" "sprint_id required"
  [[ "$lanes_n" -ge 1 ]]          || fail "$contract" "at least one lane required"

  # Validate each lane
  local i
  for (( i=0; i<lanes_n; i++ )); do
    local lid goal ap_n ac_n
    lid="$(jq -r ".lanes[$i].lane_id // empty" "$contract")"
    goal="$(jq -r ".lanes[$i].goal // empty" "$contract")"
    ap_n="$(jq ".lanes[$i].allowed_paths | length" "$contract")"
    ac_n="$(jq ".lanes[$i].acceptance_criteria | length" "$contract")"

    [[ -n "$lid" ]]         || fail "$contract" "lane[$i]: lane_id required"
    [[ -n "$goal" ]]        || fail "$contract" "lane[$i]: goal required"
    [[ "$ap_n" -ge 1 ]]     || fail "$contract" "lane[$i] ($lid): allowed_paths must be non-empty"
    [[ "$ac_n" -ge 3 ]]     || fail "$contract" "lane[$i] ($lid): at least 3 acceptance_criteria required (got: $ac_n)"

    # Every AC must have id, statement, test_command, expected
    local j
    for (( j=0; j<ac_n; j++ )); do
      local aid stmt cmd exp
      aid="$(jq -r ".lanes[$i].acceptance_criteria[$j].id // empty" "$contract")"
      stmt="$(jq -r ".lanes[$i].acceptance_criteria[$j].statement // empty" "$contract")"
      cmd="$(jq -r ".lanes[$i].acceptance_criteria[$j].test_command // empty" "$contract")"
      exp="$(jq -r ".lanes[$i].acceptance_criteria[$j].expected // empty" "$contract")"
      [[ -n "$aid" && -n "$stmt" && -n "$cmd" && -n "$exp" ]] \
        || fail "$contract" "lane[$i] ($lid) AC[$j]: id/statement/test_command/expected all required"
    done
  done

  # Reject overlapping lanes — compare each pair of allowed_paths
  local a b apa apb
  for (( a=0; a<lanes_n; a++ )); do
    for (( b=a+1; b<lanes_n; b++ )); do
      while IFS= read -r apa; do
        while IFS= read -r apb; do
          if globs_overlap "$apa" "$apb"; then
            fail "$contract" "lanes $a and $b have overlapping allowed_paths: '$apa' vs '$apb'"
          fi
        done < <(jq -r ".lanes[$b].allowed_paths[]" "$contract")
      done < <(jq -r ".lanes[$a].allowed_paths[]" "$contract")
    done
  done

  # Compute signature and write back
  local hash tmp
  hash="$(canonical "$contract" | SHA)"
  tmp="$(mktemp)"
  jq --arg h "$hash" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.signature = {algo: "sha256", hash: $h, signed_at: $ts}' \
    "$contract" > "$tmp"
  mv "$tmp" "$contract"

  pass "$contract" "contract-sign $sid (${lanes_n} lanes, hash=${hash:0:12}...)"
}

# ---------- subcommand: contract-verify ----------
cmd_contract_verify() {
  local contract="${1:-}"; [[ -n "$contract" ]] || usage
  require_file "$contract"

  log_event "$contract" "contract-verify start"

  local claimed computed
  claimed="$(jq -r '.signature.hash // empty' "$contract")"
  [[ -n "$claimed" ]] || fail "$contract" "contract has no signature — run contract-sign first"
  computed="$(canonical "$contract" | SHA)"
  [[ "$claimed" == "$computed" ]] \
    || fail "$contract" "signature mismatch: contract tampered (claimed=${claimed:0:12}..., computed=${computed:0:12}...)"

  pass "$contract" "contract-verify ok (hash=${claimed:0:12}...)"
}

# ---------- subcommand: lane-scope ----------
cmd_lane_scope() {
  local contract="${1:-}" lane_id="${2:-}"
  [[ -n "$contract" && -n "$lane_id" ]] || usage
  require_file "$contract"

  log_event "$contract" "lane-scope start lane=$lane_id"

  # Re-verify signature first — cannot trust an unsigned contract
  cmd_contract_verify "$contract" >/dev/null

  # Pull allowed + forbidden paths
  local idx
  idx="$(jq -r ".lanes | map(.lane_id) | index(\"$lane_id\") // empty" "$contract")"
  [[ -n "$idx" && "$idx" != "null" ]] || fail "$contract" "lane_id $lane_id not found in contract"

  mapfile -t ALLOWED < <(jq -r ".lanes[$idx].allowed_paths[]" "$contract")
  mapfile -t FORBIDDEN < <(jq -r ".lanes[$idx].forbidden_paths[]? // empty" "$contract")

  # Diff against parent commit — requires git repo
  command -v git >/dev/null 2>&1 || fail "$contract" "git not available for lane-scope"
  local changed
  if ! changed="$(git diff --name-only HEAD~1..HEAD 2>/dev/null)"; then
    # First commit — diff against empty tree
    changed="$(git diff --name-only "$(git hash-object -t tree /dev/null)" HEAD 2>/dev/null || true)"
  fi

  [[ -n "$changed" ]] || fail "$contract" "no changed files detected for lane $lane_id"

  local f violations=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    # Forbidden wins
    if (( ${#FORBIDDEN[@]} > 0 )) && path_matches_any "$f" "${FORBIDDEN[@]}"; then
      echo "spec_gate: FORBIDDEN path touched by $lane_id: $f" >&2
      violations=$((violations+1))
      continue
    fi
    if ! path_matches_any "$f" "${ALLOWED[@]}"; then
      echo "spec_gate: out-of-scope path for $lane_id: $f" >&2
      violations=$((violations+1))
    fi
  done <<< "$changed"

  [[ $violations -eq 0 ]] || fail "$contract" "lane-scope $lane_id: $violations out-of-scope file(s)"
  pass "$contract" "lane-scope $lane_id ($(echo "$changed" | wc -l | tr -d ' ') files in scope)"
}

# ---------- subcommand: lane-verify ----------
cmd_lane_verify() {
  local contract="${1:-}" lane_id="${2:-}"
  [[ -n "$contract" && -n "$lane_id" ]] || usage
  require_file "$contract"

  log_event "$contract" "lane-verify start lane=$lane_id"

  cmd_contract_verify "$contract" >/dev/null

  local idx
  idx="$(jq -r ".lanes | map(.lane_id) | index(\"$lane_id\") // empty" "$contract")"
  [[ -n "$idx" && "$idx" != "null" ]] || fail "$contract" "lane_id $lane_id not found"

  # Locate the verifier report — must exist, must be JSON, must say PASS
  local dir report
  dir="$(dirname "$contract")"
  report="$dir/$lane_id/verifier-report.json"
  require_file "$report"

  local verdict func_score overall
  verdict="$(jq -r '.verdict // empty' "$report")"
  func_score="$(jq -r '.scores.functionality // 0' "$report")"
  overall="$(jq -r '.scores.overall // 0' "$report")"

  [[ "$verdict" == "PASS" ]] || fail "$contract" "lane $lane_id verdict is '$verdict' (must be PASS)"
  awk -v f="$func_score" 'BEGIN { exit (f >= 9) ? 0 : 1 }' \
    || fail "$contract" "lane $lane_id functionality=$func_score (must be >= 9)"
  awk -v o="$overall" 'BEGIN { exit (o >= 78) ? 0 : 1 }' \
    || fail "$contract" "lane $lane_id overall=$overall (must be >= 78)"

  # Re-run every AC test_command and compare output
  local ac_n="$(jq ".lanes[$idx].acceptance_criteria | length" "$contract")"
  local j
  for (( j=0; j<ac_n; j++ )); do
    local aid cmd expected actual
    aid="$(jq -r ".lanes[$idx].acceptance_criteria[$j].id" "$contract")"
    cmd="$(jq -r ".lanes[$idx].acceptance_criteria[$j].test_command" "$contract")"
    expected="$(jq -r ".lanes[$idx].acceptance_criteria[$j].expected" "$contract")"
    actual="$(bash -c "$cmd" 2>&1 | tail -c 4096 || true)"
    # expected = exact match OR substring OR exit code string
    if [[ "$actual" == *"$expected"* ]]; then
      log_event "$contract" "lane-verify $lane_id $aid PASS"
    else
      fail "$contract" "lane $lane_id $aid failed — expected='$expected' actual='${actual:0:200}'"
    fi
  done

  pass "$contract" "lane-verify $lane_id (verdict=PASS, func=$func_score, overall=$overall, ACs=$ac_n)"
}

# ---------- subcommand: sprint-close ----------
cmd_sprint_close() {
  local contract="${1:-}"; [[ -n "$contract" ]] || usage
  require_file "$contract"

  log_event "$contract" "sprint-close start"

  cmd_contract_verify "$contract" >/dev/null

  # Every lane must pass lane-verify
  local lanes_n i lid
  lanes_n="$(jq '.lanes | length' "$contract")"
  for (( i=0; i<lanes_n; i++ )); do
    lid="$(jq -r ".lanes[$i].lane_id" "$contract")"
    cmd_lane_verify "$contract" "$lid" >/dev/null \
      || fail "$contract" "sprint-close: lane $lid failed lane-verify"
  done

  # Every global gate must pass
  local gg_n
  gg_n="$(jq '.global_gates | length // 0' "$contract")"
  for (( i=0; i<gg_n; i++ )); do
    local gid gname gcmd gexp actual_exit
    gid="$(jq -r ".global_gates[$i].id" "$contract")"
    gname="$(jq -r ".global_gates[$i].name" "$contract")"
    gcmd="$(jq -r ".global_gates[$i].command" "$contract")"
    gexp="$(jq -r ".global_gates[$i].expected_exit_code // 0" "$contract")"
    bash -c "$gcmd" >/dev/null 2>&1 && actual_exit=0 || actual_exit=$?
    [[ "$actual_exit" == "$gexp" ]] \
      || fail "$contract" "global gate $gid ($gname) exit=$actual_exit expected=$gexp"
    log_event "$contract" "global gate $gid ($gname) PASS"
  done

  pass "$contract" "sprint-close (${lanes_n} lanes + ${gg_n} global gates all green)"
}

# ---------- dispatch ----------
case "${1:-}" in
  contract-sign)   shift; cmd_contract_sign "$@" ;;
  contract-verify) shift; cmd_contract_verify "$@" ;;
  lane-scope)      shift; cmd_lane_scope "$@" ;;
  lane-verify)     shift; cmd_lane_verify "$@" ;;
  sprint-close)    shift; cmd_sprint_close "$@" ;;
  -h|--help|help)  usage ;;
  *)               usage ;;
esac
