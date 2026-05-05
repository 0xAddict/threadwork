#!/usr/bin/env bash
# heartbeat-v2-monitor.sh — compare v1 vs v2 false-positive rates
#
# Usage:
#   heartbeat-v2-monitor.sh [V1_DB] [V2_DB] [WINDOW_MIN]
#
# V1_DB defaults to ~/bin/heartbeat.db
# V2_DB defaults to ~/bin/heartbeat-v2.db
# WINDOW_MIN defaults to 48*60 (48h)
#
# False-positive definition (spec §11 Q4):
#   An alert (STUCK/CRASHED) that fired on an agent which had an ALIVE/IDLE
#   entry in the SAME daemon's DB within the preceding 10 minutes.
#   (Indicates daemon flagged an agent that was demonstrably healthy moments before.)
#
# Outputs (parseable):
#   v1_fp=N
#   v2_fp=N
#   window_hours=N
#   v1_total_alerts=N
#   v2_total_alerts=N

set -uo pipefail

V1_DB="${1:-$HOME/bin/heartbeat.db}"
V2_DB="${2:-$HOME/bin/heartbeat-v2.db}"
WINDOW_MIN="${3:-$((48*60))}"
FP_LOOKBACK_MIN=10   # consider prev 10 min (covers 2 consecutive 5-min checks)

if [[ ! -f "$V1_DB" ]]; then
  echo "v1_fp=0"
  echo "v2_fp=0"
  echo "window_hours=$(( WINDOW_MIN / 60 ))"
  echo "v1_total_alerts=0"
  echo "v2_total_alerts=0"
  echo "NOTE: V1 DB not found: $V1_DB" >&2
  exit 0
fi

WINDOW_START="$(python3 -c "
from datetime import datetime,timezone,timedelta
print((datetime.now(timezone.utc)-timedelta(minutes=$WINDOW_MIN)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")"

# ─── V1 false positives ───────────────────────────────────────────────────────
# STUCK/CRASHED alert where the PREVIOUS heartbeat for same agent (within
# FP_LOOKBACK_MIN) was ALIVE or IDLE.

v1_fp=$(sqlite3 "$V1_DB" <<SQL
SELECT COUNT(*) FROM heartbeats alert
WHERE alert.status IN ('STUCK','CRASHED')
  AND alert.timestamp >= '$WINDOW_START'
  AND EXISTS (
    SELECT 1 FROM heartbeats prev
    WHERE prev.agent = alert.agent
      AND prev.status IN ('ALIVE','IDLE')
      AND prev.timestamp >= datetime(alert.timestamp, '-${FP_LOOKBACK_MIN} minutes')
      AND prev.timestamp <  alert.timestamp
  );
SQL
)

v1_total=$(sqlite3 "$V1_DB" <<SQL
SELECT COUNT(*) FROM heartbeats
WHERE status IN ('STUCK','CRASHED')
  AND timestamp >= '$WINDOW_START';
SQL
)

# ─── V2 false positives ───────────────────────────────────────────────────────

if [[ ! -f "$V2_DB" ]]; then
  v2_fp=0
  v2_total=0
else
  v2_fp=$(sqlite3 "$V2_DB" <<SQL
SELECT COUNT(*) FROM heartbeats_v2 alert
WHERE alert.external_status IN ('STUCK','CRASHED')
  AND alert.timestamp >= '$WINDOW_START'
  AND EXISTS (
    SELECT 1 FROM heartbeats_v2 prev
    WHERE prev.agent = alert.agent
      AND prev.external_status IN ('ALIVE','IDLE')
      AND prev.timestamp >= datetime(alert.timestamp, '-${FP_LOOKBACK_MIN} minutes')
      AND prev.timestamp <  alert.timestamp
  );
SQL
)

  v2_total=$(sqlite3 "$V2_DB" <<SQL
SELECT COUNT(*) FROM heartbeats_v2
WHERE external_status IN ('STUCK','CRASHED')
  AND timestamp >= '$WINDOW_START';
SQL
)
fi

# ─── Output ───────────────────────────────────────────────────────────────────

echo "v1_fp=${v1_fp:-0}"
echo "v2_fp=${v2_fp:-0}"
echo "window_hours=$(( WINDOW_MIN / 60 ))"
echo "v1_total_alerts=${v1_total:-0}"
echo "v2_total_alerts=${v2_total:-0}"

# Human-readable summary to stderr
{
  echo "=== Soak Monitoring Report ==="
  echo "Window: last $(( WINDOW_MIN / 60 )) hours"
  echo "V1 alerts: ${v1_total:-0}  false-positives: ${v1_fp:-0}"
  echo "V2 alerts: ${v2_total:-0}  false-positives: ${v2_fp:-0}"
  if (( ${v1_fp:-0} > 0 )); then
    pct=$(python3 -c "print(f'{${v2_fp:-0}/${v1_fp:-0}*100:.0f}%')" 2>/dev/null || echo "N/A")
    echo "V2 FP rate: $pct of V1 (pass threshold: <=50%)"
  else
    echo "V2 FP rate: N/A (v1 had 0 false positives)"
  fi
} >&2
