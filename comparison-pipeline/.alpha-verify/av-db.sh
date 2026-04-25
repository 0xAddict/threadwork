#!/bin/bash
# Alpha-Verify DB Helper
# Usage: av-db.sh <command> [args...]
# Following beads-tracker.sh pattern: agents interact with SQLite via bash commands

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${SCRIPT_DIR}/alpha-verify.db"
SCHEMA_PATH="${SCRIPT_DIR}/schema.sql"

# Ensure DB exists and schema is applied
ensure_db() {
    if [[ ! -f "$DB_PATH" ]]; then
        sqlite3 "$DB_PATH" < "$SCHEMA_PATH"
    fi
}

# Escape single quotes for SQL
sql_escape() {
    echo "${1//\'/\'\'}"
}

cmd_init() {
    local run_id="$1"
    local _def='{}'
    local config_json="${2:-$_def}"
    ensure_db
    local escaped_config
    escaped_config=$(sql_escape "$config_json")
    sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO runs (run_id, status, config) VALUES ('${run_id}', 'init', '${escaped_config}');"
    echo "OK: Run ${run_id} initialized"
}

cmd_status() {
    local run_id="$1"
    local new_status="$2"
    ensure_db
    sqlite3 "$DB_PATH" "UPDATE runs SET status = '${new_status}', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE run_id = '${run_id}';"
    echo "OK: Run ${run_id} status → ${new_status}"
}

cmd_finding() {
    local run_id="$1"
    local agent="$2"
    local json="$3"
    ensure_db

    # Parse JSON fields using jq
    local attempt wave finding_type severity spec task_ref title description evidence confidence
    attempt=$(echo "$json" | jq -r '.attempt // 1')
    wave=$(echo "$json" | jq -r '.wave // "scan"')
    finding_type=$(echo "$json" | jq -r '.finding_type')
    severity=$(echo "$json" | jq -r '.severity // "medium"')
    spec=$(echo "$json" | jq -r '.spec // ""')
    task_ref=$(echo "$json" | jq -r '.task_ref // ""')
    title=$(echo "$json" | jq -r '.title')
    description=$(echo "$json" | jq -r '.description // ""')
    evidence=$(echo "$json" | jq -r '.evidence // "{}"')
    confidence=$(echo "$json" | jq -r '.confidence // 0.5')

    local escaped_title escaped_desc escaped_evidence escaped_spec escaped_taskref
    escaped_title=$(sql_escape "$title")
    escaped_desc=$(sql_escape "$description")
    escaped_evidence=$(sql_escape "$evidence")
    escaped_spec=$(sql_escape "$spec")
    escaped_taskref=$(sql_escape "$task_ref")

    local finding_id
    finding_id=$(sqlite3 "$DB_PATH" "
        INSERT INTO findings (run_id, attempt, wave, agent, finding_type, severity, spec, task_ref, title, description, evidence, confidence)
        VALUES ('${run_id}', ${attempt}, '${wave}', '${agent}', '${finding_type}', '${severity}', '${escaped_spec}', '${escaped_taskref}', '${escaped_title}', '${escaped_desc}', '${escaped_evidence}', ${confidence});
        SELECT last_insert_rowid();
    ")
    echo "${finding_id}"
}

cmd_summary() {
    local run_id="$1"
    local agent="$2"
    local json="$3"
    ensure_db

    local attempt wave total passed failed skipped confidence_avg notes
    attempt=$(echo "$json" | jq -r '.attempt // 1')
    wave=$(echo "$json" | jq -r '.wave // "scan"')
    total=$(echo "$json" | jq -r '.total_checked // 0')
    passed=$(echo "$json" | jq -r '.passed // 0')
    failed=$(echo "$json" | jq -r '.failed // 0')
    skipped=$(echo "$json" | jq -r '.skipped // 0')
    confidence_avg=$(echo "$json" | jq -r '.confidence_avg // 0.0')
    notes=$(echo "$json" | jq -r '.notes // ""')

    local escaped_notes
    escaped_notes=$(sql_escape "$notes")

    sqlite3 "$DB_PATH" "
        INSERT OR REPLACE INTO summaries (run_id, attempt, wave, agent, total_checked, passed, failed, skipped, confidence_avg, notes)
        VALUES ('${run_id}', ${attempt}, '${wave}', '${agent}', ${total}, ${passed}, ${failed}, ${skipped}, ${confidence_avg}, '${escaped_notes}');
    "
    echo "OK: Summary for ${agent} wave=${wave} recorded"
}

cmd_verify() {
    local run_id="$1"
    local verifier="$2"
    local json="$3"
    ensure_db

    local attempt finding_id agrees confidence evidence disagreement_reason
    attempt=$(echo "$json" | jq -r '.attempt // 1')
    finding_id=$(echo "$json" | jq -r '.finding_id')
    agrees=$(echo "$json" | jq -r '.agrees // 1')
    confidence=$(echo "$json" | jq -r '.confidence // 0.5')
    evidence=$(echo "$json" | jq -r '.evidence // "{}"')
    disagreement_reason=$(echo "$json" | jq -r '.disagreement_reason // ""')

    local escaped_evidence escaped_reason
    escaped_evidence=$(sql_escape "$evidence")
    escaped_reason=$(sql_escape "$disagreement_reason")

    sqlite3 "$DB_PATH" "
        INSERT OR REPLACE INTO verifications (run_id, attempt, verifier, finding_id, agrees, confidence, evidence, disagreement_reason)
        VALUES ('${run_id}', ${attempt}, '${verifier}', ${finding_id}, ${agrees}, ${confidence}, '${escaped_evidence}', '${escaped_reason}');
    "
    echo "OK: Verification by ${verifier} for finding #${finding_id} recorded"
}

cmd_compare() {
    local run_id="$1"
    local json="$2"
    ensure_db

    local attempt comparator total agreed disagreed score disagreements verdict notes
    attempt=$(echo "$json" | jq -r '.attempt // 1')
    comparator=$(echo "$json" | jq -r '.comparator')
    total=$(echo "$json" | jq -r '.total_findings // 0')
    agreed=$(echo "$json" | jq -r '.agreed_count // 0')
    disagreed=$(echo "$json" | jq -r '.disagreed_count // 0')
    score=$(echo "$json" | jq -r '.agreement_score // 0.0')
    disagreements=$(echo "$json" | jq -r '.disagreements // "[]"')
    verdict=$(echo "$json" | jq -r '.final_verdict // null')
    notes=$(echo "$json" | jq -r '.notes // ""')

    local escaped_disagreements escaped_notes
    escaped_disagreements=$(sql_escape "$disagreements")
    escaped_notes=$(sql_escape "$notes")

    local verdict_sql
    if [[ "$verdict" == "null" || -z "$verdict" ]]; then
        verdict_sql="NULL"
    else
        verdict_sql="'${verdict}'"
    fi

    sqlite3 "$DB_PATH" "
        INSERT INTO comparisons (run_id, attempt, comparator, total_findings, agreed_count, disagreed_count, agreement_score, disagreements, final_verdict, notes)
        VALUES ('${run_id}', ${attempt}, '${comparator}', ${total}, ${agreed}, ${disagreed}, ${score}, '${escaped_disagreements}', ${verdict_sql}, '${escaped_notes}');
    "
    echo "OK: Comparison by ${comparator} recorded (score=${score})"
}

cmd_inbox() {
    local run_id="$1"
    local agent="$2"
    ensure_db

    sqlite3 -json "$DB_PATH" "
        SELECT id, sender, message_type, subject, body, created_at
        FROM messages
        WHERE run_id = '${run_id}' AND recipient = '${agent}' AND is_read = 0
        ORDER BY created_at ASC;
    "
    # Mark as read
    sqlite3 "$DB_PATH" "
        UPDATE messages SET is_read = 1
        WHERE run_id = '${run_id}' AND recipient = '${agent}' AND is_read = 0;
    "
}

cmd_send() {
    local run_id="$1"
    local from="$2"
    local to="$3"
    local json="$4"
    ensure_db

    local message_type subject body
    message_type=$(echo "$json" | jq -r '.message_type // "status"')
    subject=$(echo "$json" | jq -r '.subject // ""')
    body=$(echo "$json" | jq -r '.body // ""')

    local escaped_subject escaped_body
    escaped_subject=$(sql_escape "$subject")
    escaped_body=$(sql_escape "$body")

    sqlite3 "$DB_PATH" "
        INSERT INTO messages (run_id, sender, recipient, message_type, subject, body)
        VALUES ('${run_id}', '${from}', '${to}', '${message_type}', '${escaped_subject}', '${escaped_body}');
    "
    echo "OK: Message sent from ${from} to ${to}"
}

cmd_dashboard() {
    local run_id="$1"
    ensure_db

    echo "=== Alpha-Verify Dashboard: ${run_id} ==="
    echo ""
    echo "--- Run Status ---"
    sqlite3 -header -column "$DB_PATH" "SELECT * FROM run_dashboard WHERE run_id = '${run_id}';"
    echo ""
    echo "--- Scanner Summaries (current attempt) ---"
    sqlite3 -header -column "$DB_PATH" "
        SELECT agent, wave, total_checked, passed, failed, skipped, confidence_avg
        FROM summaries
        WHERE run_id = '${run_id}' AND attempt = (SELECT attempt FROM runs WHERE run_id = '${run_id}')
        ORDER BY wave, agent;
    "
    echo ""
    echo "--- Disputed Findings ---"
    sqlite3 -header -column "$DB_PATH" "
        SELECT finding_id, scanner, severity, title, verifier, disagreement_reason
        FROM disputed_findings
        WHERE run_id = '${run_id}'
        LIMIT 20;
    "
    echo ""
    echo "--- Comparison Results ---"
    sqlite3 -header -column "$DB_PATH" "
        SELECT comparator, total_findings, agreed_count, disagreed_count, agreement_score, final_verdict
        FROM comparisons
        WHERE run_id = '${run_id}'
        ORDER BY attempt DESC, comparator;
    "
}

cmd_findings_for_agent() {
    local run_id="$1"
    local agent="$2"
    local attempt="${3:-}"
    ensure_db

    if [[ -z "$attempt" ]]; then
        attempt=$(sqlite3 "$DB_PATH" "SELECT attempt FROM runs WHERE run_id = '${run_id}';")
    fi

    sqlite3 -json "$DB_PATH" "
        SELECT id, finding_type, severity, spec, task_ref, title, description, evidence, confidence
        FROM findings
        WHERE run_id = '${run_id}' AND attempt = ${attempt} AND agent = '${agent}'
        ORDER BY id;
    "
}

cmd_all_findings() {
    local run_id="$1"
    local attempt="${2:-}"
    ensure_db

    if [[ -z "$attempt" ]]; then
        attempt=$(sqlite3 "$DB_PATH" "SELECT attempt FROM runs WHERE run_id = '${run_id}';")
    fi

    sqlite3 -json "$DB_PATH" "
        SELECT f.id, f.agent, f.finding_type, f.severity, f.spec, f.task_ref, f.title, f.description, f.evidence, f.confidence,
               v.verifier, v.agrees, v.confidence AS verifier_confidence, v.disagreement_reason
        FROM findings f
        LEFT JOIN verifications v ON v.finding_id = f.id AND v.run_id = f.run_id AND v.attempt = f.attempt
        WHERE f.run_id = '${run_id}' AND f.attempt = ${attempt}
        ORDER BY f.id;
    "
}

cmd_scanner_count() {
    local run_id="$1"
    local attempt="${2:-}"
    ensure_db

    if [[ -z "$attempt" ]]; then
        attempt=$(sqlite3 "$DB_PATH" "SELECT attempt FROM runs WHERE run_id = '${run_id}';")
    fi

    sqlite3 "$DB_PATH" "
        SELECT COUNT(DISTINCT agent) FROM summaries
        WHERE run_id = '${run_id}' AND attempt = ${attempt} AND wave = 'scan';
    "
}

cmd_verifier_count() {
    local run_id="$1"
    local attempt="${2:-}"
    ensure_db

    if [[ -z "$attempt" ]]; then
        attempt=$(sqlite3 "$DB_PATH" "SELECT attempt FROM runs WHERE run_id = '${run_id}';")
    fi

    sqlite3 "$DB_PATH" "
        SELECT COUNT(DISTINCT verifier) FROM verifications
        WHERE run_id = '${run_id}' AND attempt = ${attempt};
    "
}

# ============================================================
# Command dispatch
# ============================================================

case "${1:-help}" in
    init)           _av_def='{}'; cmd_init "$2" "${3:-$_av_def}" ;;
    status)         cmd_status "$2" "$3" ;;
    finding)        cmd_finding "$2" "$3" "$4" ;;
    summary)        cmd_summary "$2" "$3" "$4" ;;
    verify)         cmd_verify "$2" "$3" "$4" ;;
    compare)        cmd_compare "$2" "$3" ;;
    inbox)          cmd_inbox "$2" "$3" ;;
    send)           cmd_send "$2" "$3" "$4" "$5" ;;
    dashboard)      cmd_dashboard "$2" ;;
    findings-for)   cmd_findings_for_agent "$2" "$3" "${4:-}" ;;
    all-findings)   cmd_all_findings "$2" "${3:-}" ;;
    scanner-count)  cmd_scanner_count "$2" "${3:-}" ;;
    verifier-count) cmd_verifier_count "$2" "${3:-}" ;;
    help)
        echo "Alpha-Verify DB Helper"
        echo "Usage: av-db.sh <command> [args...]"
        echo ""
        echo "Commands:"
        echo "  init <run_id> [config_json]        Create run, init DB"
        echo "  status <run_id> <new_status>        Update run status"
        echo "  finding <run_id> <agent> <json>     Insert finding"
        echo "  summary <run_id> <agent> <json>     Insert summary"
        echo "  verify <run_id> <verifier> <json>   Insert verification"
        echo "  compare <run_id> <json>             Insert comparison"
        echo "  inbox <run_id> <agent>              Check & mark read messages"
        echo "  send <run_id> <from> <to> <json>    Send message"
        echo "  dashboard <run_id>                  Get run dashboard"
        echo "  findings-for <run_id> <agent> [attempt]  Get findings for agent"
        echo "  all-findings <run_id> [attempt]     Get all findings with verifications"
        echo "  scanner-count <run_id> [attempt]    Count scanners that reported"
        echo "  verifier-count <run_id> [attempt]   Count verifiers that reported"
        ;;
    *)
        echo "ERROR: Unknown command '${1}'. Run 'av-db.sh help' for usage." >&2
        exit 1
        ;;
esac
