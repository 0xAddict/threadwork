#!/usr/bin/env bash
# heartbeat-v2-flag.sh — toggle feature flag heartbeat_v2_enabled
#
# Usage:
#   heartbeat-v2-flag.sh enable  [DB_PATH]   — set enabled=1
#   heartbeat-v2-flag.sh disable [DB_PATH]   — set enabled=0
#   heartbeat-v2-flag.sh status  [DB_PATH]   — print current value
#
# DB_PATH defaults to ~/.claude/mcp-servers/task-board/tasks.db

set -euo pipefail

ACTION="${1:-status}"
DB_PATH="${2:-$HOME/.claude/mcp-servers/task-board/tasks.db}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found: $DB_PATH" >&2
  exit 1
fi

case "$ACTION" in
  enable)
    sqlite3 "$DB_PATH" \
      "UPDATE feature_flags SET enabled=1 WHERE flag_name='heartbeat_v2_enabled';"
    val=$(sqlite3 "$DB_PATH" \
      "SELECT enabled FROM feature_flags WHERE flag_name='heartbeat_v2_enabled';")
    echo "heartbeat_v2_enabled=$val"
    ;;
  disable)
    sqlite3 "$DB_PATH" \
      "UPDATE feature_flags SET enabled=0 WHERE flag_name='heartbeat_v2_enabled';"
    val=$(sqlite3 "$DB_PATH" \
      "SELECT enabled FROM feature_flags WHERE flag_name='heartbeat_v2_enabled';")
    echo "heartbeat_v2_enabled=$val"
    ;;
  status)
    val=$(sqlite3 "$DB_PATH" \
      "SELECT COALESCE(enabled,'NOT FOUND') FROM feature_flags WHERE flag_name='heartbeat_v2_enabled';" \
      2>/dev/null || echo "ERROR")
    echo "heartbeat_v2_enabled=$val"
    ;;
  *)
    echo "Usage: $0 [enable|disable|status] [DB_PATH]" >&2
    exit 1
    ;;
esac
