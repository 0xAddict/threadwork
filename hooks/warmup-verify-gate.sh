#!/usr/bin/env bash
# threadwork warmup-verify-gate (PreToolUse: mcp__task-board__complete_task).
# HARD completion-gate for ONE specific task: #10060735 (Smartlead-warmup verify).
#
# GOAL: like the hardened sender-gate, this BLOCKS (exit 2) — it is NOT advisory.
# It refuses to let task #10060735 be marked complete until a real proof sentinel
# has been recorded on the task. Every other task, and every ambiguous/error case
# that is not the target task, FAILS OPEN (exit 0) so the gate can never brick the
# board.
#
# SCOPE & FAIL POLICY (precision lessons borrowed from sender-gate.sh):
#   - stdin unparseable / task_id not confidently an int  -> exit 0  (FAIL-OPEN)
#   - task_id != 10060735                                 -> exit 0  (FAIL-OPEN, scoped)
#   - task_id == 10060735, DB readable, sentinel present  -> exit 0  (ALLOW)
#   - task_id == 10060735, DB readable, NO sentinel       -> exit 2  (BLOCK)
#   - task_id == 10060735, DB UNreadable / query error    -> exit 2  (FAIL-CLOSED,
#                                                                       target only)
#
# PROOF SENTINELS (literal strings, recorded in a note/finding on task 10060735):
#   POSITIVE        : [WARMUP-PROOF-VERIFIED]
#   HONEST-TERMINAL : [WARMUP-VERIFY-TERMINAL-NEGATIVE]
# EITHER one, recorded standalone, unlocks completion.
#
# FALSE-POSITIVE GUARD (the sender-gate "quoted mention vs genuine signal" lesson):
# the gate-contract acknowledgment note (note id 2640) QUOTES *both* sentinels in
# one message ("...record EXACTLY one... [WARMUP-PROOF-VERIFIED] ... OR
# [WARMUP-VERIFY-TERMINAL-NEGATIVE]..."). That is a contract restatement, NOT proof.
# A genuine proof / terminal note records EXACTLY ONE sentinel. So a row counts as
# real proof only when it contains exactly one of the two sentinels (>=1 positive
# XOR >=1 terminal), never both in the same row. This blocks the acknowledgment
# prose from satisfying the gate while still honoring "EITHER sentinel".
set +e

TASK_ID_TARGET=10060735
DB="${WARMUP_GATE_DB:-/Users/coachstokes/.claude/mcp-servers/task-board/tasks.db}"

# --- Read stdin (PreToolUse hook JSON) -------------------------------------
input="$(cat 2>/dev/null)"

# --- Step 1/2: parse tool_input.task_id robustly; bail open if unsure -------
task_id="$(printf '%s' "$input" | python3 -c '
import sys, json
try:
    data = json.loads(sys.stdin.read())
    ti = data.get("tool_input", {}) or {}
    tid = ti.get("task_id", None)
    # accept int, or a string that is a clean integer
    if isinstance(tid, bool):
        sys.exit(0)
    if isinstance(tid, int):
        print(tid); sys.exit(0)
    if isinstance(tid, str) and tid.strip().lstrip("-").isdigit():
        print(int(tid.strip())); sys.exit(0)
except Exception:
    pass
# unparseable / missing / non-numeric -> print nothing
' 2>/dev/null)"

# Not confidently parsed -> FAIL-OPEN (protects all other tasks).
if [ -z "$task_id" ]; then
  exit 0
fi
case "$task_id" in
  ''|*[!0-9-]*) exit 0 ;;   # defensive: anything non-integer slips through -> open
esac

# --- Step 3: scope. Only the target task is ever gated. --------------------
if [ "$task_id" != "$TASK_ID_TARGET" ]; then
  exit 0
fi

# --- Step 4: target task. DB must be readable; query for a genuine sentinel.-
# Query returns the literal string "PROVEN" iff at least one note OR finding row
# carries EXACTLY ONE sentinel (positive XOR terminal). Exit status 0 means the
# query ran. Any non-zero -> treat as DB error -> fail closed (step 6).
sql="
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM notes
  WHERE task_id=${TASK_ID_TARGET}
    AND ( (message LIKE '%[WARMUP-PROOF-VERIFIED]%')
          <> (message LIKE '%[WARMUP-VERIFY-TERMINAL-NEGATIVE]%') )
  UNION ALL
  SELECT 1 FROM findings
  WHERE task_id=${TASK_ID_TARGET}
    AND ( (summary LIKE '%[WARMUP-PROOF-VERIFIED]%')
          <> (summary LIKE '%[WARMUP-VERIFY-TERMINAL-NEGATIVE]%') )
) THEN 'PROVEN' ELSE 'UNPROVEN' END;
"

# Readability precheck: file must exist and be a non-empty readable sqlite file.
if [ ! -r "$DB" ]; then
  echo "[WARMUP-GATE] Task #${TASK_ID_TARGET} cannot be completed: proof DB not readable at '${DB}'. Failing CLOSED for this task only. (All other tasks are unaffected.)" >&2
  exit 2
fi

result="$(sqlite3 "$DB" "$sql" 2>/dev/null)"
rc=$?

if [ "$rc" -ne 0 ]; then
  # DB query errored (corrupt / locked / schema drift) -> fail CLOSED, target only.
  echo "[WARMUP-GATE] Task #${TASK_ID_TARGET} cannot be completed: proof-DB query failed (rc=${rc}). Failing CLOSED for this task only." >&2
  exit 2
fi

if [ "$result" = "PROVEN" ]; then
  # Step 4: a genuine sentinel exists -> ALLOW completion.
  exit 0
fi

# --- Step 5: target task, DB readable, NO genuine sentinel -> BLOCK. --------
echo "[WARMUP-GATE] Task #${TASK_ID_TARGET} cannot be completed: no recorded warmup proof. Record [WARMUP-PROOF-VERIFIED] (screenshot/API + 2 independent agent verdicts + codex verdict = warmup ACTIVE) OR, after the 4-loop max, the honest [WARMUP-VERIFY-TERMINAL-NEGATIVE] with the exact blocker. Record exactly ONE sentinel as a standalone note/finding (a note quoting BOTH sentinels is read as the contract restatement, not proof). See task #${TASK_ID_TARGET} contract." >&2
exit 2
