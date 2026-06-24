#!/usr/bin/env bash
# Shared helpers for restart-cap bats tests

# Create a tracker file with the given values
create_tracker() {
  local dir="$1"
  local service="$2"
  local timestamps_json="$3"
  local max_r="${4:-5}"
  local max_t_sec="${5:-60}"
  local last_action="${6:-running}"
  local last_action_at="${7:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

  cat > "${dir}/${service}.json" <<EOF
{
  "service": "${service}",
  "restart_timestamps_unix": ${timestamps_json},
  "max_r": ${max_r},
  "max_t_sec": ${max_t_sec},
  "last_action": "${last_action}",
  "last_action_at": "${last_action_at}"
}
EOF
}

# Run startup check (TypeScript-based)
run_startup() {
  local tracker_dir="$1"
  local service="$2"
  local now_sec="${3:-$(date +%s)}"
  local max_r="${4:-5}"
  local max_t_sec="${5:-60}"

  RESTART_INTENSITY_MAX_R="$max_r" \
  RESTART_INTENSITY_MAX_T_SEC="$max_t_sec" \
  bun run "${TASK_BOARD_DIR}/scripts/restart-startup.ts" \
    --tracker-dir="$tracker_dir" \
    --service="$service" \
    --now="$now_sec" 2>&1
}

# Run sentinel single-pass check
run_sentinel_once() {
  local tracker_dir="$1"
  TRACKER_DIR_OVERRIDE="$tracker_dir" \
  bash "${HOME}/bin/restart-intensity-sentinel.sh" --check-once 2>&1
}

# TASK_BOARD_DIR for scripts
TASK_BOARD_DIR="${BATS_TEST_DIRNAME}/../.."
