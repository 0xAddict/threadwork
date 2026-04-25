#!/bin/bash
# Alpha-Verify Session Manager
# Manages session.json lifecycle for stop hook coordination
# Following impl-session.sh pattern

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_FILE="${SCRIPT_DIR}/session.json"

# Generate run ID: AV_{date}_{time}_{short_commit}
generate_run_id() {
    local date_part time_part commit_part
    date_part=$(date -u +%Y%m%d)
    time_part=$(date -u +%H%M)
    commit_part=$(git rev-parse --short HEAD 2>/dev/null || echo "nocommit")
    echo "AV_${date_part}_${time_part}_${commit_part}"
}

cmd_start() {
    local max_iterations="${1:-20}"
    local default_config='{}'
    local config_json="${2:-$default_config}"
    local run_id
    run_id=$(generate_run_id)
    local started_at
    started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    jq -n \
        --arg run_id "$run_id" \
        --argjson max_iter "$max_iterations" \
        --arg started "$started_at" \
        --argjson config "$config_json" \
        '{
            run_id: $run_id,
            status: "running",
            current_iteration: 1,
            max_iterations: $max_iter,
            current_phase: "init",
            agreement_score: null,
            attempts: [],
            started_at: $started,
            config: $config
        }' > "$SESSION_FILE"

    echo "${run_id}"
}

cmd_phase() {
    local phase_name="$1"
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "ERROR: No active session" >&2
        exit 1
    fi

    local tmp
    tmp=$(mktemp)
    jq --arg phase "$phase_name" '.current_phase = $phase' "$SESSION_FILE" > "$tmp" && mv "$tmp" "$SESSION_FILE"
    echo "OK: Phase → ${phase_name}"
}

cmd_attempt() {
    local score="$1"
    local verdict="$2"
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "ERROR: No active session" >&2
        exit 1
    fi

    local current_iteration
    current_iteration=$(jq -r '.current_iteration' "$SESSION_FILE")

    local tmp
    tmp=$(mktemp)
    jq --argjson score "$score" \
       --arg verdict "$verdict" \
       --argjson attempt "$current_iteration" \
       '.attempts += [{"attempt": $attempt, "score": $score, "verdict": $verdict}] | .agreement_score = $score' \
       "$SESSION_FILE" > "$tmp" && mv "$tmp" "$SESSION_FILE"

    echo "OK: Attempt ${current_iteration} recorded (score=${score}, verdict=${verdict})"
}

cmd_iterate() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "ERROR: No active session" >&2
        exit 1
    fi

    local tmp
    tmp=$(mktemp)
    jq '.current_iteration += 1' "$SESSION_FILE" > "$tmp" && mv "$tmp" "$SESSION_FILE"

    local new_iter
    new_iter=$(jq -r '.current_iteration' "$SESSION_FILE")
    echo "OK: Iteration → ${new_iter}"
}

cmd_status() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo '{"status": "no_session"}'
        return
    fi
    cat "$SESSION_FILE"
}

cmd_end() {
    local final_status="$1"
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "ERROR: No active session" >&2
        exit 1
    fi

    local tmp
    tmp=$(mktemp)
    jq --arg status "$final_status" '.status = $status' "$SESSION_FILE" > "$tmp" && mv "$tmp" "$SESSION_FILE"

    echo "OK: Session ended with status=${final_status}"
}

cmd_force_exit() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "OK: No session to force-exit"
        return
    fi

    local tmp
    tmp=$(mktemp)
    jq '.status = "force_exit"' "$SESSION_FILE" > "$tmp" && mv "$tmp" "$SESSION_FILE"

    echo "OK: Session force-exited. Stop hook will allow exit."
}

cmd_run_id() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "ERROR: No active session" >&2
        exit 1
    fi
    jq -r '.run_id' "$SESSION_FILE"
}

# ============================================================
# Command dispatch
# ============================================================

case "${1:-help}" in
    start)      _av_cfg="${3:-"{}"}"; cmd_start "${2:-20}" "$_av_cfg" ;;
    phase)      cmd_phase "$2" ;;
    attempt)    cmd_attempt "$2" "$3" ;;
    iterate)    cmd_iterate ;;
    status)     cmd_status ;;
    end)        cmd_end "$2" ;;
    force-exit) cmd_force_exit ;;
    run-id)     cmd_run_id ;;
    help)
        echo "Alpha-Verify Session Manager"
        echo "Usage: av-session.sh <command> [args...]"
        echo ""
        echo "Commands:"
        echo "  start [max_iterations] [config_json]  Create session, return run_id"
        echo "  phase <phase_name>                     Update current phase"
        echo "  attempt <score> <verdict>              Record attempt result"
        echo "  iterate                                Increment iteration counter"
        echo "  status                                 Print current session state"
        echo "  end <final_status>                     Mark session complete"
        echo "  force-exit                             Force allow exit (bypass stop hook)"
        echo "  run-id                                 Print current run_id"
        ;;
    *)
        echo "ERROR: Unknown command '${1}'. Run 'av-session.sh help' for usage." >&2
        exit 1
        ;;
esac
