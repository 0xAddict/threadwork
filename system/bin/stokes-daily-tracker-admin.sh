#!/bin/bash
# stokes-daily-tracker-admin.sh — Snoopy admin bypass for locked daily_entries rows
#
# Usage:
#   stokes-daily-tracker-admin.sh --date YYYY-MM-DD --field <self_report|kairos_summary|tiptap_summary|verdict> --new-value "..."
#
# Inside a transaction:
#   1. DROP TRIGGER lock_daily_entries_update
#   2. DROP TRIGGER lock_daily_entries_delete
#   3. UPDATE the specified field on the matching row
#   4. Recreate both triggers
#   5. Log admin action to admin_actions table and admin.log

set -euo pipefail

DB="$HOME/.claude/state/stokes-daily-tracker/journal.db"
ADMIN_LOG="$HOME/.claude/state/stokes-daily-tracker/admin.log"
TS=$(date -u +%FT%TZ)

log() {
  echo "[$TS] $*" | tee -a "$ADMIN_LOG"
}

usage() {
  echo "Usage: $0 --date YYYY-MM-DD --field <self_report|kairos_summary|tiptap_summary|verdict> --new-value \"...\""
  exit 1
}

# ── Parse args ──────────────────────────────────────────────────────────────
TARGET_DATE=""
FIELD=""
NEW_VALUE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --date)     TARGET_DATE="$2"; shift 2 ;;
    --field)    FIELD="$2";       shift 2 ;;
    --new-value) NEW_VALUE="$2";  shift 2 ;;
    *) usage ;;
  esac
done

[ -z "$TARGET_DATE" ] && { log "ERROR: --date required"; usage; }
[ -z "$FIELD" ]       && { log "ERROR: --field required"; usage; }
[ -z "$NEW_VALUE" ]   && { log "ERROR: --new-value required"; usage; }

# Validate field name
case "$FIELD" in
  self_report|kairos_summary|tiptap_summary|verdict) ;;
  *) log "ERROR: invalid field '$FIELD'. Must be one of: self_report kairos_summary tiptap_summary verdict"; exit 1 ;;
esac

# Validate date format
if ! echo "$TARGET_DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  log "ERROR: invalid date format '$TARGET_DATE'. Expected YYYY-MM-DD"
  exit 1
fi

if [ ! -f "$DB" ]; then
  log "ERROR: database not found at $DB"
  exit 1
fi

log "admin bypass: date=$TARGET_DATE field=$FIELD"

# Check the row exists
ROW_EXISTS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM daily_entries WHERE date='$TARGET_DATE';" 2>/dev/null || echo 0)
if [ "$ROW_EXISTS" -eq 0 ]; then
  log "ERROR: no daily_entries row found for date=$TARGET_DATE"
  exit 1
fi

# Get old value for audit trail
OLD_VALUE=$(sqlite3 "$DB" "SELECT $FIELD FROM daily_entries WHERE date='$TARGET_DATE';" 2>/dev/null || echo "")
log "old value (first 200 chars): ${OLD_VALUE:0:200}"

# Escape values for SQLite
ESCAPED_NEW=$(echo "$NEW_VALUE" | sed "s/'/''/g")
ESCAPED_OLD=$(echo "$OLD_VALUE" | sed "s/'/''/g")

# ── Execute inside transaction ────────────────────────────────────────────────
log "executing DROP TRIGGER + UPDATE + CREATE TRIGGER transaction..."

sqlite3 "$DB" <<SQL
BEGIN TRANSACTION;

-- 1. DROP lock triggers to allow modification
DROP TRIGGER IF EXISTS lock_daily_entries_update;
DROP TRIGGER IF EXISTS lock_daily_entries_delete;

-- 2. UPDATE the specified field
UPDATE daily_entries
   SET $FIELD = '$ESCAPED_NEW'
 WHERE date = '$TARGET_DATE';

-- 3. Recreate BEFORE UPDATE trigger
CREATE TRIGGER lock_daily_entries_update
  BEFORE UPDATE ON daily_entries
  FOR EACH ROW
  WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'daily_entries row is locked');
END;

-- 4. Recreate BEFORE DELETE trigger
CREATE TRIGGER lock_daily_entries_delete
  BEFORE DELETE ON daily_entries
  FOR EACH ROW
  WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'daily_entries row is locked');
END;

-- 5. Log admin action
INSERT INTO admin_actions(ts, action, target_date, field, old_value, new_value, operator)
VALUES (datetime('now'), 'admin_field_update', '$TARGET_DATE', '$FIELD', '$ESCAPED_OLD', '$ESCAPED_NEW', 'snoopy-admin');

COMMIT;
SQL

# Verify triggers recreated
TRIGGER_COUNT=$(sqlite3 "$DB" \
  "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='daily_entries';" 2>/dev/null || echo 0)

if [ "$TRIGGER_COUNT" -ge 2 ]; then
  log "SUCCESS: field=$FIELD updated for date=$TARGET_DATE; triggers recreated ($TRIGGER_COUNT present)"
else
  log "WARNING: update succeeded but trigger count=$TRIGGER_COUNT (expected 2)"
fi

# Also log to admin.log (plain text)
{
  echo "=== ADMIN BYPASS ==="
  echo "TS: $TS"
  echo "Target date: $TARGET_DATE"
  echo "Field: $FIELD"
  echo "Old value: ${OLD_VALUE:0:200}"
  echo "New value: ${NEW_VALUE:0:200}"
  echo "Triggers after: $TRIGGER_COUNT"
  echo ""
} >> "$ADMIN_LOG"

log "admin bypass complete"
exit 0
