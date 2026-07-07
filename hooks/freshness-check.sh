#!/usr/bin/env bash
# freshness-check.sh — PreToolUse hook for task-board operations
#
# Modes (dispatched by $1):
#   preclaim    PreToolUse, claim_task path: BLOCK if task is older than
#               FRESHNESS_HOURS_COLD (default 24h) and the claiming agent has
#               not posted a "FRESHNESS: <verdict> — <reasoning>" note within
#               the last 5 minutes. Allow otherwise.
#
#   prerevisit  PreToolUse, revisit-class operations (claim_task,
#               delegate_task, complete_task, send_note): 4-ZONE LADDER
#               using last-activity timestamp (last_progress_at →
#               last_heartbeat_at → claimed_at → created_at):
#
#               ZONE 0 (age < FRESHNESS_REVISIT_GRACE_MIN, default 5 min):
#                 exit 0 ALLOW. Audit: fresh-grace.
#
#               ZONE 1 (GRACE_MIN ≤ age < KEYWORD_MIN, default 30 min):
#                 Scan last 5 notes for structural-change keywords
#                 (REVERSED|DECISION|BLOCKED|ESCALAT*|OVERRIDDEN|FURY|CORRECTION,
#                 word-boundary anchored — see check_structural_keywords).
#                 If any match → exit 2 BLOCK with full inject.
#                 Otherwise → exit 0 ALLOW.
#
#               ZONE 2 (KEYWORD_MIN ≤ age < HARDBLOCK_HR*60, default 2h):
#                 Existing behavior: exit 2 BLOCK unless agent posted
#                 FRESHNESS note in last 5 min, then ALLOW. Full inject on block.
#
#               ZONE 3 (age ≥ HARDBLOCK_HR*60, default 120 min):
#                 HARD BLOCK exit 2 with full inject UNLESS the agent has
#                 posted a FRESHNESS verdict note within the last 5 minutes
#                 (#1713-adjacent fix: gate-queued cards age >2h BY DESIGN, so
#                 every post-gate dispatch hit an unclearable wall — third
#                 ZONE-3 incident 2026-06-11, walled steve off #1602. Same
#                 verdict-note mechanic as ZONE-1/2; the hardblock still fires
#                 for the no-verdict case, which is its actual purpose: stop
#                 blind writes to stale cards).
#
# Skip rules (fail-open / exit 0):
#   - FRESHNESS_HOOK_DISABLED=1   global kill-switch (logged to disabled.log)
#   - FRESHNESS_BYPASS=1          per-call emergency (logged to bypass.log)
#   - task age < threshold        brand-new / recently-active tasks
#   - preclaim: task status != 'pending'   DB layer rejects non-pending claims
#   - prerevisit: terminal status (completed/cancelled/done/complete) —
#     terminal cards are archives, not stale work (#13014 item 8c)
#   - boss-self coord (from='boss' AND to_agent='boss')
#   - watchdog/synthetic (from='watchdog' OR is_synthetic=1)
#   - any internal error          fail-open; hook NEVER deadlocks Claude Code
#
# Env-var thresholds (overridable):
#   FRESHNESS_HOURS_COLD=24            preclaim mode threshold (hours)
#   FRESHNESS_REVISIT_GRACE_MIN=5      prerevisit Zone 0 threshold (minutes)
#   FRESHNESS_REVISIT_KEYWORD_MIN=30   prerevisit Zone 1 upper bound (minutes)
#   FRESHNESS_REVISIT_HARDBLOCK_HR=2   prerevisit Zone 3 threshold (hours → minutes)
#
# Exit codes: 0 = allow, 2 = block (with stderr context). Mirrors
# subagent-blackboard.sh structure.

set -u

MODE="${1:-}"
STATE_DIR="$HOME/.claude/state/freshness-hook"
DEBUG_LOG="$STATE_DIR/debug.log"
BYPASS_LOG="$STATE_DIR/bypass.log"
DISABLED_LOG="$STATE_DIR/disabled.log"
AUDIT_LOG="$HOME/.claude/state/freshness-hook.log"
DB="${FRESHNESS_DB:-$HOME/.claude/mcp-servers/task-board/tasks.db}"  # env override is for TESTS ONLY
# P4 Stage 7 KO-1 (#10376057): pipe-through sanitizer CLI for the pinned-memory
# excerpts emitted by emit_stale_context(). Env-overridable so tests can point
# at the worktree CLI; defaults to the live path so production behavior is
# unchanged when unset.
MEMORY_INTEGRITY_CLI="${MEMORY_INTEGRITY_CLI:-$HOME/.claude/mcp-servers/task-board/memory-integrity-cli.ts}"
BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
CACHE_TTL=10
FRESHNESS_HOURS_COLD_DEFAULT=24

# Zone thresholds (minutes) — overridable via env
FRESHNESS_REVISIT_GRACE_MIN_DEFAULT=5
FRESHNESS_REVISIT_KEYWORD_MIN_DEFAULT=30
FRESHNESS_REVISIT_HARDBLOCK_HR_DEFAULT=2

mkdir -p "$STATE_DIR" 2>/dev/null || true
mkdir -p "$(dirname "$AUDIT_LOG")" 2>/dev/null || true

log_debug() {
  echo "$(date -u +%FT%TZ) [$MODE] $*" >> "$DEBUG_LOG" 2>/dev/null || true
}

log_audit() {
  # Single-line append-only audit. One line per invocation.
  # Format: ts mode agent task verdict detail
  echo "$(date -u +%FT%TZ) mode=$MODE agent=${AGENT_LABEL:-?} task=${1:-?} verdict=${2:-?} detail=${3:-}" \
    >> "$AUDIT_LOG" 2>/dev/null || true
}

# Read stdin once (hooks pass JSON on stdin)
STDIN_DATA=$(cat)

# --- Helpers -----------------------------------------------------------------

# Extract tool_name from hook JSON. Use `python3 -c` (NOT heredoc — heredoc
# would steal stdin from the pipe, mirroring subagent-blackboard.sh:39-46).
extract_tool_name() {
  python3 -c 'import json,sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get("tool_name", ""))
except Exception:
    pass' 2>/dev/null
}

# Extract tool_input.task_id from hook JSON
extract_task_id() {
  python3 -c 'import json,sys
try:
    data = json.loads(sys.stdin.read())
    ti = data.get("tool_input", {}) or {}
    tid = ti.get("task_id", "")
    if tid == "" or tid is None:
        sys.exit(0)
    print(tid)
except Exception:
    pass' 2>/dev/null
}

# Extract tool_input.message from hook JSON (used by the ^FRESHNESS: escape-valve
# exemption in prerevisit mode — see BUGFIX #1617). Returns empty string if absent.
extract_message() {
  python3 -c 'import json,sys
try:
    data = json.loads(sys.stdin.read())
    ti = data.get("tool_input", {}) or {}
    msg = ti.get("message", "")
    if msg is None:
        msg = ""
    print(msg)
except Exception:
    pass' 2>/dev/null
}

# Validate task_id is a positive integer
valid_task_id() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Validate agent label: lowercase letters, digits, underscore, hyphen
valid_agent_label() {
  case "$1" in
    ''|*[!a-z0-9_-]*) return 1 ;;
    [a-z]*) return 0 ;;
    *) return 1 ;;
  esac
}

# P4 Stage 7 KO-1 (#10376057): route the substr(content,1,150) portion of
# each pinned-memory row through the memory-integrity CLI (same
# sanitizeMemoryContent primitive as the TS write paths) before it lands in
# the stderr context block — closes the shell-hook sanitizer bypass.
# Fail-closed: a row whose CLI invocation errors is DROPPED entirely (never
# falls back to raw content).
#
# $1 = raw sqlite3 output, ASCII 0x1F (Unit Separator)-delimited columns
#      "id<0x1F>substr(content,1,150)<0x1F>source_type", one row per line.
#      0x1F (not '|') because the content excerpt routinely contains literal
#      '|' characters, and with 3 columns a '|'-delimited read would corrupt
#      the content/source_type split (bash `read` folds all overflow fields
#      into the LAST variable).
# Echoes the reassembled "[#id] <sanitized>" lines, one per surviving row.
format_pinned_mems() {
  local raw="$1"
  local out=""
  local pm_id pm_content pm_source_type sanitized cli_status
  # codex round-2 finding #2 (HIGH): $raw is now 0x1E (Record Separator)
  # row-terminated (see the two callers below), so `read -d $'\x1e'` splits
  # on ROWS instead of newlines — an embedded 0x0A in pm_content no longer
  # desyncs this loop into treating the continuation text as a new
  # pm_id/pm_source_type (which previously leaked raw, unsanitized content).
  while IFS=$'\x1f' read -r -d $'\x1e' pm_id pm_content pm_source_type; do
    [ -z "$pm_id" ] && continue
    [ -z "$pm_source_type" ] && pm_source_type="agent"
    sanitized=$(printf '%s' "$pm_content" | TASKBOARD_DB="$DB" "$BUN_BIN" "$MEMORY_INTEGRITY_CLI" --sanitize-stdin --source-type="$pm_source_type" 2>>"$DEBUG_LOG")
    cli_status=$?
    if [ "$cli_status" -ne 0 ]; then
      log_debug "memory-integrity-cli failed (exit=$cli_status) for pinned memory #${pm_id} — dropping (fail-closed)"
      continue
    fi
    if [ -n "$out" ]; then
      out="${out}
[#${pm_id}] ${sanitized}"
    else
      out="[#${pm_id}] ${sanitized}"
    fi
  done < <(printf '%s' "$raw")
  echo "$out"
}

# --- Rich inject payload (D1) -----------------------------------------------
# Emits structured context to stderr inside the exit-2 path.
# All queries are fast (indexed lookups, capped to 3 rows).
# Total stderr capped at ~3KB via per-field truncation.
#
# $1 = task_id
# $2 = age_label (e.g. "47 minutes" or "3h")
# $3 = tool_name (for the retry instruction)
# $4 = zone label (e.g. "ZONE-1-keyword-BLOCKED")
emit_stale_context() {
  local task_id="$1"
  local age_label="$2"
  local tool_name="$3"
  local zone_label="$4"

  # (a) Last 3 notes — uses correct column names: from_agent, message
  local notes_sql
  notes_sql="SELECT '[' || created_at || '] ' || from_agent || ': ' || \
    substr(message,1,200) \
    FROM notes WHERE task_id=${task_id} \
    ORDER BY id DESC LIMIT 3;"
  local recent_notes
  recent_notes=$(sqlite3 -readonly "$DB" "$notes_sql" 2>>"$DEBUG_LOG")
  [ -z "$recent_notes" ] && recent_notes="  (no notes on this task)"

  # (b) Current task status + last write_status detail
  local status_sql
  status_sql="SELECT status FROM tasks WHERE id=${task_id};"
  local task_status
  task_status=$(sqlite3 -readonly "$DB" "$status_sql" 2>>"$DEBUG_LOG")
  [ -z "$task_status" ] && task_status="(unknown)"

  local last_detail_sql
  last_detail_sql="SELECT substr(detail,1,200) FROM task_status_events \
    WHERE task_id=${task_id} ORDER BY id DESC LIMIT 1;"
  local last_detail
  last_detail=$(sqlite3 -readonly "$DB" "$last_detail_sql" 2>>"$DEBUG_LOG")
  [ -z "$last_detail" ] && last_detail="(none)"

  # (c) Related task IDs: parent, children, siblings
  local parent_sql
  parent_sql="SELECT parent_task_id FROM tasks \
    WHERE id=${task_id} AND parent_task_id IS NOT NULL;"
  local parent_id
  parent_id=$(sqlite3 -readonly "$DB" "$parent_sql" 2>>"$DEBUG_LOG")

  local related_line=""

  if [ -n "$parent_id" ]; then
    local parent_status_sql
    parent_status_sql="SELECT status FROM tasks WHERE id=${parent_id};"
    local parent_status
    parent_status=$(sqlite3 -readonly "$DB" "$parent_status_sql" 2>>"$DEBUG_LOG")
    related_line="PARENT: #${parent_id} (${parent_status:-?})"

    # Siblings: same parent, not self
    local sib_sql
    sib_sql="SELECT '#' || id || '(' || status || ')' FROM tasks \
      WHERE parent_task_id=${parent_id} AND id != ${task_id} LIMIT 5;"
    local siblings
    siblings=$(sqlite3 -readonly "$DB" "$sib_sql" 2>>"$DEBUG_LOG" | tr '\n' ' ')
    [ -n "$siblings" ] && related_line="${related_line} | SIBLINGS: ${siblings}"
  fi

  # Children
  local children_sql
  children_sql="SELECT '#' || id || '(' || status || ')' FROM tasks \
    WHERE parent_task_id=${task_id} LIMIT 5;"
  local children
  children=$(sqlite3 -readonly "$DB" "$children_sql" 2>>"$DEBUG_LOG" | tr '\n' ' ')
  if [ -n "$children" ]; then
    if [ -n "$related_line" ]; then
      related_line="${related_line} | CHILDREN: ${children}"
    else
      related_line="CHILDREN: ${children}"
    fi
  fi
  [ -z "$related_line" ] && related_line="(none)"

  # (d) Matching pinned memories — F2 hybrid heuristic.
  # Combines three guards to suppress false-positives the verifier flagged
  # (cross-context leakage of session-handoff/operating-rule pinned items
  # on generic task descriptions):
  #   1. Stoplist of low-signal words (filtered before keyword extraction)
  #   2. Overlap-2 SQL: require >= 2 distinct keyword LIKE hits per memory
  #   3. Category allow-list: only fact/decision/preference/feedback/project
  #      (excludes task_summary, role, learning, capability, etc.)
  # TG-id alone bypasses the overlap-2 rule (it is an explicit signal).
  local desc_sql
  desc_sql="SELECT substr(description,1,200) FROM tasks WHERE id=${task_id};"
  local task_desc
  task_desc=$(sqlite3 -readonly "$DB" "$desc_sql" 2>>"$DEBUG_LOG")

  # Stoplist of low-signal words frequently appearing in our memory corpus.
  # Filtering these prevents pinned-memory false matches on generic task
  # descriptions. See task #1073 F2 / brainstorm §4.2.
  local STOPLIST=" the and with for from this that have are was will can not our any all but you may use see task agent verify check update status result keyword freshness system briefing claude session handoff zone note review revisit "
  filter_stop() {
    local w lc
    w="$1"
    lc=$(echo "$w" | tr '[:upper:]' '[:lower:]')
    case "$STOPLIST" in *" $lc "*) return 1 ;; esac
    return 0
  }

  # Pull all >=5-char alpha words; keep first 3 that pass the stoplist.
  local _kws=()
  while IFS= read -r w; do
    [ -z "$w" ] && continue
    filter_stop "$w" || continue
    _kws+=("$w")
    [ "${#_kws[@]}" -ge 3 ] && break
  done < <(echo "$task_desc" | grep -oE '[a-zA-Z]{5,}')
  local kw1="${_kws[0]:-}"
  local kw2="${_kws[1]:-}"
  local kw3="${_kws[2]:-}"

  # Also extract any TG IDs (pattern: TG followed by 4 digits)
  local tg_id
  tg_id=$(echo "$task_desc" | grep -oE 'TG [0-9]{4}' | head -1 | grep -oE '[0-9]+' || true)

  # Category allow-list (per brainstorm §4.2 + sprint user prompt).
  local CATEGORY_ALLOW="'fact','decision','preference','feedback','project'"

  local pinned_mems=""
  if [ -n "$kw1" ] && [ -n "$kw2" ]; then
    # overlap-2: SQLite booleans are 0/1 ints, so (LIKE)+(LIKE)>=2 is valid.
    local overlap_sql overlap_raw
    overlap_sql="SELECT id, substr(content,1,150), COALESCE(source_type,'agent') \
      FROM memories WHERE pinned=1 \
        AND COALESCE(category,'') IN (${CATEGORY_ALLOW}) \
        AND ((content LIKE '%${kw1}%') + (content LIKE '%${kw2}%')"
    [ -n "$kw3" ] && overlap_sql="${overlap_sql} + (content LIKE '%${kw3}%')"
    overlap_sql="${overlap_sql}) >= 2 \
      ORDER BY importance DESC LIMIT 3;"
    # codex round-2 finding #2 (HIGH): two-arg `.separator COL ROW` makes
    # 0x1E the row terminator (not sqlite3's default newline), so a memory
    # whose content embeds a newline stays a SINGLE row instead of desyncing
    # format_pinned_mems's read loop into leaking raw content as an id field.
    overlap_raw=$(sqlite3 -readonly -cmd '.mode list' -cmd $'.separator \x1f \x1e' "$DB" "$overlap_sql" 2>>"$DEBUG_LOG")
    pinned_mems=$(format_pinned_mems "$overlap_raw")
  fi

  # TG-id is an explicit signal and stands alone (bypasses overlap-2).
  if [ -z "$pinned_mems" ] && [ -n "$tg_id" ]; then
    local tg_sql tg_raw
    tg_sql="SELECT id, substr(content,1,150), COALESCE(source_type,'agent') \
      FROM memories WHERE pinned=1 \
        AND COALESCE(category,'') IN (${CATEGORY_ALLOW}) \
        AND content LIKE '%${tg_id}%' \
      ORDER BY importance DESC LIMIT 3;"
    # codex round-2 finding #2 (HIGH): same 0x1E row-terminator fix as the
    # overlap_sql invocation above.
    tg_raw=$(sqlite3 -readonly -cmd '.mode list' -cmd $'.separator \x1f \x1e' "$DB" "$tg_sql" 2>>"$DEBUG_LOG")
    pinned_mems=$(format_pinned_mems "$tg_raw")
  fi
  [ -z "$pinned_mems" ] && pinned_mems="  (none matched)"

  # Emit to stderr — cap total at ~3KB
  cat >&2 <<STALE_CONTEXT_EOF
=== STALE TASK CONTEXT === task=#${task_id} age=${age_label} zone=${zone_label} tool=${tool_name}

--- LAST 3 NOTES ---
${recent_notes}

--- CURRENT TASK STATUS: ${task_status} ---
Last write_status detail: ${last_detail}

--- RELATED TASKS ---
${related_line}

--- PINNED MEMORIES (keyword-matched) ---
${pinned_mems}

=== END STALE CONTEXT ===

FRESHNESS CHECK REQUIRED [${zone_label}]

Before ${tool_name}, post a FRESHNESS verdict:

  send_note(task_id=${task_id}, message="FRESHNESS: <verdict> <one-line reasoning>")

where <verdict> is one of:
  STILL-FRESH  context is current, proceeding as planned
  STALE        context has drifted; re-read key docs before continuing
  SUPERSEDED   work already completed elsewhere; close instead

Then retry ${tool_name} within 5 minutes.

Bypass options:
  FRESHNESS_BYPASS=1             per-call emergency (logged)
  FRESHNESS_HOOK_DISABLED=1      global kill-switch (logged)
  Zone thresholds: FRESHNESS_REVISIT_GRACE_MIN=${GRACE_MIN:-?} FRESHNESS_REVISIT_KEYWORD_MIN=${KEYWORD_MIN:-?} FRESHNESS_REVISIT_HARDBLOCK_HR=${HARDBLOCK_HR:-?}
STALE_CONTEXT_EOF
}

# --- Common pre-checks (shared by both modes) --------------------------------
# Sets: TASK_ID, AGENT, ROW, AGE_HOURS, STATUS, FROM_AGENT, TO_AGENT, IS_SYN
# Exits 0 (fail-open) on any invalid state.
# $1 = threshold hours variable name (for logging)
# $2 = threshold value
run_common_checks() {
  local threshold_label="$1"
  local threshold_val="$2"

  # Kill-switch: global disable
  if [ "${FRESHNESS_HOOK_DISABLED:-}" = "1" ]; then
    echo "$(date -u +%FT%TZ) DISABLED agent=${AGENT_LABEL:-?}" \
      >> "$DISABLED_LOG" 2>/dev/null || true
    log_audit "?" "DISABLED" "kill-switch"
    exit 0
  fi

  # Phase A per-agent gate: enable for agents listed in agents.enabled.
  ENABLED_AGENTS_FILE="$HOME/.claude/state/freshness-hook/agents.enabled"
  agent_in_enabled_file() {
    [ -f "$ENABLED_AGENTS_FILE" ] || return 1
    grep -v '^[[:space:]]*#' "$ENABLED_AGENTS_FILE" | grep -qFx "$1"
  }
  if [ "${FRESHNESS_HOOK_ENABLED:-}" != "1" ] && ! agent_in_enabled_file "${AGENT_LABEL:-}"; then
    exit 0
  fi

  TASK_ID=$(echo "$STDIN_DATA" | extract_task_id)
  AGENT="${AGENT_LABEL:-}"

  if ! valid_task_id "$TASK_ID"; then
    log_debug "invalid/missing task_id: '$TASK_ID' — fail-open"
    log_audit "?" "PASS" "invalid-task-id"
    exit 0
  fi
  if ! valid_agent_label "$AGENT"; then
    log_debug "invalid/missing AGENT_LABEL: '$AGENT' — fail-open"
    log_audit "$TASK_ID" "PASS" "invalid-agent-label"
    exit 0
  fi

  # Per-call emergency bypass (after we have task_id/agent for audit)
  if [ "${FRESHNESS_BYPASS:-}" = "1" ]; then
    echo "$(date -u +%FT%TZ) BYPASS agent=$AGENT task=$TASK_ID" \
      >> "$BYPASS_LOG" 2>/dev/null || true
    log_audit "$TASK_ID" "BYPASS" "per-call"
    exit 0
  fi

  if [ ! -f "$DB" ]; then
    log_debug "db missing: $DB — fail-open"
    log_audit "$TASK_ID" "PASS" "db-missing"
    exit 0
  fi
}

# Query FRESHNESS notes for a given task + agent within last 5 minutes.
# Uses a 10-second cache keyed (task_id, agent).
# Outputs the count to stdout.
query_freshness_note_count() {
  local task_id="$1"
  local agent="$2"
  local cache_file="$STATE_DIR/task-${task_id}-${agent}.cache"
  local count=""

  if [ -f "$cache_file" ]; then
    local now mtime cage
    now=$(date +%s 2>/dev/null || echo 0)
    mtime=$(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || echo 0)
    cage=$(( now - mtime ))
    if [ "$cage" -ge 0 ] && [ "$cage" -lt "$CACHE_TTL" ]; then
      count=$(cat "$cache_file" 2>/dev/null)
    fi
  fi

  if [ -z "$count" ]; then
    local note_sql
    note_sql="SELECT message FROM notes \
      WHERE task_id=${task_id} \
        AND from_agent='${agent}' \
        AND created_at >= datetime('now','-5 minutes') \
        AND UPPER(message) LIKE 'FRESHNESS:%' \
      ORDER BY created_at DESC;"
    local match_count=0
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      if echo "$line" | grep -Eqi '^FRESHNESS:[[:space:]]*(STILL-FRESH|STALE|SUPERSEDED)[[:space:]]+\S'; then
        match_count=$((match_count + 1))
      fi
    done < <(sqlite3 -readonly "$DB" "$note_sql" 2>>"$DEBUG_LOG")
    count="$match_count"
    echo "$count" > "$cache_file" 2>/dev/null || true
  fi

  echo "$count"
}

# Scan recent notes on a task for structural-change keywords (Zone 1 check).
# Outputs the matching keyword (first match) or empty string if none.
# Keywords: REVERSED|DECISION|BLOCKED|ESCALAT*|OVERRIDDEN|FURY|CORRECTION (word-boundary anchored)
# F1: BSD word-boundary anchors [[:<:]] / [[:>:]] prevent substring false-positives
# (e.g. "decisional", "blocker", "indecisive"). ESCALAT[A-Z]* preserves the
# intentional prefix match for ESCALATE/ESCALATED/ESCALATION/ESCALATING.
#
# F4 (task #1473/#1474): author-scope the scan so a keyword in a note the calling
# agent has ALREADY POSTED PAST no longer blocks it. We scan only notes whose id
# is >= the calling agent's own most-recent note on this task — i.e. the agent's
# latest note plus anything posted after it. Rationale: once an agent has posted
# a note AFTER a structural-keyword note, it has seen/acknowledged that signal, so
# the older keyword must stop blocking. Without this, a single historical keyword
# note (often the watchdog's "ESCALATION"/"BLOCKED", or an unrelated agent's note)
# permanently poisons the last-5-notes window and blocks EVERY subsequent
# send_note from EVERY agent forever — a team-wide board-comms blackhole
# (confirmed on #850).
#   - Keyword in a note OLDER than the agent's last note  -> ALLOW (acknowledged).
#   - Keyword in the agent's OWN latest note              -> BLOCK (preserves the
#       existing contract: just flagged a structural change, re-read first).
#   - Keyword in a foreign note NEWER than agent's last   -> BLOCK (new signal).
#   - Agent has never posted (last_self_id=0)             -> scan last 5 as before
#       (first-encounter detection preserved).
check_structural_keywords() {
  local task_id="$1"
  local agent="$2"
  # Most-recent note id authored by the calling agent on this task (0 if none).
  local self_id_sql last_self_id
  self_id_sql="SELECT COALESCE(MAX(id),0) FROM notes \
    WHERE task_id=${task_id} AND from_agent='${agent}';"
  last_self_id=$(sqlite3 -readonly "$DB" "$self_id_sql" 2>>"$DEBUG_LOG")
  case "$last_self_id" in ''|*[!0-9]*) last_self_id=0 ;; esac
  local notes_sql
  notes_sql="SELECT message FROM notes \
    WHERE task_id=${task_id} AND id >= ${last_self_id} \
    ORDER BY id DESC LIMIT 5;"
  local keyword_match=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local match
    match=$(echo "$line" | grep -Eoi '[[:<:]](REVERSED|DECISION|BLOCKED|ESCALAT[A-Z]*|OVERRIDDEN|FURY|CORRECTION)[[:>:]]' | head -1 || true)
    if [ -n "$match" ]; then
      keyword_match="$match"
      break
    fi
  done < <(sqlite3 -readonly "$DB" "$notes_sql" 2>>"$DEBUG_LOG")
  echo "$keyword_match"
}

# --- Mode dispatch -----------------------------------------------------------

case "$MODE" in

  preclaim)
    TOOL_NAME=$(echo "$STDIN_DATA" | extract_tool_name)
    if [ "$TOOL_NAME" != "mcp__task-board__claim_task" ]; then
      # Not our tool — allow.
      exit 0
    fi

    run_common_checks "FRESHNESS_HOURS_COLD" "${FRESHNESS_HOURS_COLD:-$FRESHNESS_HOURS_COLD_DEFAULT}"

    FRESHNESS_HOURS="${FRESHNESS_HOURS_COLD:-$FRESHNESS_HOURS_COLD_DEFAULT}"
    case "$FRESHNESS_HOURS" in
      ''|*[!0-9]*) FRESHNESS_HOURS=$FRESHNESS_HOURS_COLD_DEFAULT ;;
    esac

    # Single-row task lookup. Returns:
    #   age_hours|status|from_agent|to_agent|is_synthetic|priority
    ROW_SQL="SELECT \
      CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) AS age_hours, \
      COALESCE(status,''), \
      COALESCE(from_agent,''), \
      COALESCE(to_agent,''), \
      COALESCE(is_synthetic,0), \
      COALESCE(priority,'') \
      FROM tasks WHERE id=${TASK_ID};"
    ROW=$(sqlite3 -readonly "$DB" "$ROW_SQL" 2>>"$DEBUG_LOG")
    if [ -z "$ROW" ]; then
      log_debug "no row for task=$TASK_ID — fail-open"
      log_audit "$TASK_ID" "PASS" "no-row"
      exit 0
    fi

    AGE=$(echo "$ROW" | cut -d'|' -f1)
    STATUS=$(echo "$ROW" | cut -d'|' -f2)
    FROM_AGENT=$(echo "$ROW" | cut -d'|' -f3)
    TO_AGENT=$(echo "$ROW" | cut -d'|' -f4)
    IS_SYN=$(echo "$ROW" | cut -d'|' -f5)

    case "$AGE" in
      ''|*[!0-9-]*) log_debug "bad age '$AGE' — fail-open"; log_audit "$TASK_ID" "PASS" "bad-age"; exit 0 ;;
    esac

    # Skip: non-pending status (DB will reject the claim itself)
    if [ "$STATUS" != "pending" ]; then
      log_audit "$TASK_ID" "PASS" "status=$STATUS"
      exit 0
    fi

    # Skip: brand-new task (age < FRESHNESS_HOURS_COLD)
    if [ "$AGE" -lt "$FRESHNESS_HOURS" ] 2>/dev/null; then
      log_audit "$TASK_ID" "PASS" "fresh-age=${AGE}h<${FRESHNESS_HOURS}h"
      exit 0
    fi

    # Skip: boss-self coordination (from='boss' AND to_agent='boss')
    if [ "$FROM_AGENT" = "boss" ] && [ "$TO_AGENT" = "boss" ]; then
      log_audit "$TASK_ID" "PASS" "boss-self"
      exit 0
    fi

    # Skip: watchdog or synthetic
    if [ "$FROM_AGENT" = "watchdog" ] || [ "$IS_SYN" = "1" ]; then
      log_audit "$TASK_ID" "PASS" "synthetic-or-watchdog"
      exit 0
    fi

    COUNT=$(query_freshness_note_count "$TASK_ID" "$AGENT")

    if [ "$COUNT" -gt 0 ] 2>/dev/null; then
      log_audit "$TASK_ID" "PASS" "verdict-found age=${AGE}h"
      exit 0
    fi

    # BLOCK — preclaim mode emits simpler context (notes only, no zone inject).
    CONTEXT_SQL="SELECT '[' || created_at || '] ' || from_agent || ': ' || substr(message,1,200) \
      FROM notes WHERE task_id=${TASK_ID} \
      ORDER BY id DESC LIMIT 3;"
    RECENT_NOTES=$(sqlite3 -readonly "$DB" "$CONTEXT_SQL" 2>>"$DEBUG_LOG")
    [ -z "$RECENT_NOTES" ] && RECENT_NOTES="(no notes on this task)"

    log_audit "$TASK_ID" "BLOCK" "preclaim age=${AGE}h threshold=${FRESHNESS_HOURS}h"

    cat >&2 <<EOF
Freshness check required (task #${TASK_ID}, age ${AGE}h, threshold ${FRESHNESS_HOURS}h) [preclaim]

This task is older than ${FRESHNESS_HOURS}h. Before claim_task, post a verdict:

  send_note(task_id=${TASK_ID}, message="FRESHNESS: <verdict> <one-line reasoning>")

where <verdict> is one of:
  STILL-FRESH  premise still valid, work still needed
  STALE        premise outdated, but task may be revivable
  SUPERSEDED   work already completed elsewhere; close instead of claim

Recent context (last 3 notes):
${RECENT_NOTES}

Then retry claim_task within 5 minutes.

Bypass options:
  FRESHNESS_BYPASS=1            per-call emergency (logged)
  FRESHNESS_HOOK_DISABLED=1     global kill-switch (logged)
  Threshold override: FRESHNESS_HOURS_COLD=N  (current: ${FRESHNESS_HOURS}h)
EOF
    exit 2
    ;;

  prerevisit)
    # D2: 4-ZONE THRESHOLD LADDER
    # Applies to: claim_task, delegate_task, complete_task, send_note
    # Uses minutes-based age from last-activity timestamp.

    TOOL_NAME=$(echo "$STDIN_DATA" | extract_tool_name)
    case "$TOOL_NAME" in
      mcp__task-board__claim_task|\
      mcp__task-board__delegate_task|\
      mcp__task-board__complete_task|\
      mcp__task-board__send_note)
        : # valid revisit-class tool
        ;;
      *)
        # Not a revisit-class tool — allow.
        exit 0
        ;;
    esac

    # -------------------------------------------------------------------------
    # BUGFIX #1617 — FIX (a): ^FRESHNESS: escape-valve exemption.
    #
    # The block-inject in every zone instructs the agent to post a
    #   send_note(message="FRESHNESS: <verdict> ...")
    # as the way to clear the gate. But send_note is itself a revisit-class
    # tool, so that very escape-valve note re-enters THIS hook. On a task that
    # is keyword-poisoned (ZONE-1) or stale (ZONE-2/3) the FRESHNESS note's own
    # send_note got blocked before it could land in the notes table — a hard
    # deadlock with no escape (verified live on #1595, 2026-06-10). EXEMPT any
    # send_note whose message starts with "FRESHNESS:" so the verdict can
    # ALWAYS land. This is the intended escape valve and must never be gated.
    # Scoped to send_note only — other revisit-class tools are unaffected.
    if [ "$TOOL_NAME" = "mcp__task-board__send_note" ]; then
      _FCHK_MSG=$(echo "$STDIN_DATA" | extract_message)
      if echo "$_FCHK_MSG" | grep -Eqi '^[[:space:]]*FRESHNESS:'; then
        log_audit "${TASK_ID:-?}" "ALLOW" "freshness-verdict-note-exempt tool=$TOOL_NAME"
        exit 0
      fi
    fi

    run_common_checks "FRESHNESS_REVISIT_LADDER" "zone-ladder"

    # Load zone thresholds (env-var overridable, with validation)
    GRACE_MIN="${FRESHNESS_REVISIT_GRACE_MIN:-$FRESHNESS_REVISIT_GRACE_MIN_DEFAULT}"
    case "$GRACE_MIN" in
      ''|*[!0-9]*) GRACE_MIN=$FRESHNESS_REVISIT_GRACE_MIN_DEFAULT ;;
    esac

    KEYWORD_MIN="${FRESHNESS_REVISIT_KEYWORD_MIN:-$FRESHNESS_REVISIT_KEYWORD_MIN_DEFAULT}"
    case "$KEYWORD_MIN" in
      ''|*[!0-9]*) KEYWORD_MIN=$FRESHNESS_REVISIT_KEYWORD_MIN_DEFAULT ;;
    esac

    HARDBLOCK_HR="${FRESHNESS_REVISIT_HARDBLOCK_HR:-$FRESHNESS_REVISIT_HARDBLOCK_HR_DEFAULT}"
    case "$HARDBLOCK_HR" in
      ''|*[!0-9]*) HARDBLOCK_HR=$FRESHNESS_REVISIT_HARDBLOCK_HR_DEFAULT ;;
    esac
    HARDBLOCK_MIN=$(( HARDBLOCK_HR * 60 ))

    # Task lookup: use last_progress_at -> last_heartbeat_at -> claimed_at -> created_at
    # Returns minutes-based age for zone arithmetic, plus task metadata.
    ROW_SQL="SELECT \
      CAST((julianday('now') - julianday( \
        COALESCE(last_progress_at, last_heartbeat_at, claimed_at, created_at) \
      )) * 1440 AS INTEGER) AS activity_age_min, \
      CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) AS create_age_hours, \
      COALESCE(status,''), \
      COALESCE(from_agent,''), \
      COALESCE(to_agent,''), \
      COALESCE(is_synthetic,0) \
      FROM tasks WHERE id=${TASK_ID};"
    ROW=$(sqlite3 -readonly "$DB" "$ROW_SQL" 2>>"$DEBUG_LOG")
    if [ -z "$ROW" ]; then
      log_debug "no row for task=$TASK_ID — fail-open"
      log_audit "$TASK_ID" "PASS" "no-row"
      exit 0
    fi

    ACTIVITY_AGE_MIN=$(echo "$ROW" | cut -d'|' -f1)
    CREATE_AGE=$(echo "$ROW" | cut -d'|' -f2)
    STATUS=$(echo "$ROW" | cut -d'|' -f3)
    FROM_AGENT=$(echo "$ROW" | cut -d'|' -f4)
    TO_AGENT=$(echo "$ROW" | cut -d'|' -f5)
    IS_SYN=$(echo "$ROW" | cut -d'|' -f6)

    case "$ACTIVITY_AGE_MIN" in
      ''|*[!0-9-]*) log_debug "bad activity_age_min '$ACTIVITY_AGE_MIN' — fail-open"; log_audit "$TASK_ID" "PASS" "bad-activity-age"; exit 0 ;;
    esac

    # Skip: boss-self coordination
    if [ "$FROM_AGENT" = "boss" ] && [ "$TO_AGENT" = "boss" ]; then
      log_audit "$TASK_ID" "PASS" "boss-self"
      exit 0
    fi

    # Skip: watchdog or synthetic
    if [ "$FROM_AGENT" = "watchdog" ] || [ "$IS_SYN" = "1" ]; then
      log_audit "$TASK_ID" "PASS" "synthetic-or-watchdog"
      exit 0
    fi

    # Skip: terminal status (#13014 item 8c). Terminal cards are ARCHIVES, not
    # stale work — post-completion notes (acceptance evidence, governance
    # dispositions, audit appendices) are legitimate and common. The skip
    # existed for completed/cancelled, but the board also carries the terminal
    # spellings 'done' and 'complete' (e.g. #1707/#13006), which fell through
    # to the zone ladder and hit ZONE-3 hardblocks during routine
    # record-keeping. ALLOW outright for all four terminal spellings; the
    # gate's actual purpose — stopping blind writes to stale ACTIVE work —
    # is untouched (active statuses still ride the full zone ladder below).
    case "$STATUS" in
      completed|cancelled|done|complete)
        log_audit "$TASK_ID" "PASS" "terminal-status=$STATUS"
        exit 0
        ;;
    esac

    # Age label for human-readable display
    if [ "$ACTIVITY_AGE_MIN" -lt 60 ] 2>/dev/null; then
      AGE_LABEL="${ACTIVITY_AGE_MIN}min"
    else
      AGE_LABEL="$(( ACTIVITY_AGE_MIN / 60 ))h$(( ACTIVITY_AGE_MIN % 60 ))min"
    fi

    # -------------------------------------------------------------------------
    # ZONE 0: age < GRACE_MIN → always allow
    # -------------------------------------------------------------------------
    if [ "$ACTIVITY_AGE_MIN" -lt "$GRACE_MIN" ] 2>/dev/null; then
      log_audit "$TASK_ID" "ALLOW" "fresh-grace age=${AGE_LABEL}<${GRACE_MIN}min tool=$TOOL_NAME"
      exit 0
    fi

    # -------------------------------------------------------------------------
    # ZONE 1: GRACE_MIN ≤ age < KEYWORD_MIN → keyword scan
    # -------------------------------------------------------------------------
    if [ "$ACTIVITY_AGE_MIN" -lt "$KEYWORD_MIN" ] 2>/dev/null; then
      KEYWORD_MATCH=$(check_structural_keywords "$TASK_ID" "$AGENT")
      if [ -z "$KEYWORD_MATCH" ]; then
        log_audit "$TASK_ID" "ALLOW" "ALLOW-no-keywords age=${AGE_LABEL} zone=1 tool=$TOOL_NAME"
        exit 0
      fi
      # BUGFIX #1617 — FIX (b): verdict-detection now reads the NOTES TABLE.
      # Previously ZONE-1 blocked purely on the keyword scan and NEVER consulted
      # whether the agent had already posted a FRESHNESS verdict — so the block
      # the inject promises to clear could not be cleared by posting the verdict
      # it asks for (confirmed live on #1595: a correctly-formatted verdict in the
      # notes table did not unblock). The notes table is the source of truth, and
      # query_freshness_note_count already reads it (FRESHNESS: <verdict> by this
      # agent in the last 5 min). Honour it here so the documented loop works:
      # block -> post FRESHNESS verdict (now allowed by fix (a)) -> retry passes.
      COUNT=$(query_freshness_note_count "$TASK_ID" "$AGENT")
      if [ "$COUNT" -gt 0 ] 2>/dev/null; then
        log_audit "$TASK_ID" "ALLOW" "verdict-found-zone1 keyword=${KEYWORD_MATCH} age=${AGE_LABEL} zone=1 tool=$TOOL_NAME"
        exit 0
      fi
      # Keyword found and no verdict posted — BLOCK with full inject (bypass
      # options + zone thresholds are emitted inside emit_stale_context).
      log_audit "$TASK_ID" "BLOCK" "BLOCK-keyword-${KEYWORD_MATCH} age=${AGE_LABEL} zone=1 tool=$TOOL_NAME"
      emit_stale_context "$TASK_ID" "$AGE_LABEL" "$TOOL_NAME" "ZONE-1-keyword-${KEYWORD_MATCH}"
      exit 2
    fi

    # -------------------------------------------------------------------------
    # ZONE 3: age ≥ HARDBLOCK_MIN → HARD BLOCK unless a FRESHNESS verdict note
    # was posted by this agent in the last 5 minutes.
    #
    # FIX (#1713-adjacent, 2026-06-11): ZONE-3 previously rejected the verdict-
    # note path outright ("does NOT bypass this zone") and pointed at
    # FRESHNESS_BYPASS=1 — which is unreachable from MCP tool calls (the agent
    # cannot set env vars on the hook's process). Gate-queued cards age >2h BY
    # DESIGN, so every post-gate dispatch hard-walled (third ZONE-3 incident
    # today; walled steve off #1602). The #1617 fixes made the verdict
    # mechanic work in ZONE-1/2 and exempted the ^FRESHNESS: send_note itself,
    # so the verdict note can ALWAYS land — extend the same clearance here.
    # The hardblock is preserved for the no-verdict case: an agent must still
    # read the stale-context inject and post a reasoned verdict before writing
    # to a >2h-stale card.
    # -------------------------------------------------------------------------
    if [ "$ACTIVITY_AGE_MIN" -ge "$HARDBLOCK_MIN" ] 2>/dev/null; then
      COUNT=$(query_freshness_note_count "$TASK_ID" "$AGENT")
      if [ "$COUNT" -gt 0 ] 2>/dev/null; then
        log_audit "$TASK_ID" "ALLOW" "verdict-found-zone3 age=${AGE_LABEL} zone=3 tool=$TOOL_NAME"
        exit 0
      fi
      log_audit "$TASK_ID" "BLOCK" "HARDBLOCK-age-${HARDBLOCK_HR}h age=${AGE_LABEL} zone=3 tool=$TOOL_NAME"
      emit_stale_context "$TASK_ID" "$AGE_LABEL" "$TOOL_NAME" "ZONE-3-HARDBLOCK-${HARDBLOCK_HR}h"
      cat >&2 <<EOF

HARD BLOCK: task is ${AGE_LABEL} old (>= ${HARDBLOCK_HR}h threshold).
To clear: post the FRESHNESS verdict note described above (it is never blocked),
then retry within 5 minutes. FRESHNESS_BYPASS=1 remains the emergency override.
EOF
      exit 2
    fi

    # -------------------------------------------------------------------------
    # ZONE 2: KEYWORD_MIN ≤ age < HARDBLOCK_MIN → standard gate with FRESHNESS bypass
    # -------------------------------------------------------------------------
    COUNT=$(query_freshness_note_count "$TASK_ID" "$AGENT")

    if [ "$COUNT" -gt 0 ] 2>/dev/null; then
      log_audit "$TASK_ID" "ALLOW" "verdict-found age=${AGE_LABEL} zone=2 tool=$TOOL_NAME"
      exit 0
    fi

    # BLOCK zone 2
    log_audit "$TASK_ID" "BLOCK" "prerevisit age=${AGE_LABEL} zone=2 tool=$TOOL_NAME"
    emit_stale_context "$TASK_ID" "$AGE_LABEL" "$TOOL_NAME" "ZONE-2-standard"
    cat >&2 <<EOF

To bypass: post a FRESHNESS note first (see above), then retry within 5 minutes.
EOF
    exit 2
    ;;

  *)
    log_debug "unknown mode: '$MODE' — fail-open"
    exit 0
    ;;
esac
