#!/usr/bin/env bash
# =============================================================================
# inhibit-expiry-reminder.sh — Nightly scanner for expiring inhibit rules
#
# Sprint 1 / DEL-1 / C0.11 — Scans inhibit_rules.json for rules with expires_at
# within 7 days OR already expired, and sends a Telegram reminder (NOT stderr).
# (DD13 mitigation: expiry notification must reach the operator, not go to a log file)
#
# Run via launchd nightly (com.threadwork.inhibit-expiry-reminder)
# =============================================================================

set -uo pipefail

RULES_FILE="${INHIBIT_RULES_FILE:-$HOME/.claude/mcp-servers/task-board/inhibit_rules.json}"
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-1712539766}"
REMINDER_LOG="${REMINDER_LOG:-$HOME/Library/Logs/com.threadwork.inhibit-expiry-reminder.log}"
WARN_DAYS=7  # Warn this many days before expiry

# =============================================================================
# Logging
# =============================================================================

log() {
  local ts; ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '[%s] %s\n' "$ts" "$*" >> "$REMINDER_LOG" 2>/dev/null || true
  printf '[%s] %s\n' "$ts" "$*" >&2 || true
}

# =============================================================================
# Telegram send
# =============================================================================

send_telegram() {
  local text="$1"
  if [[ -z "${TELEGRAM_TOKEN:-}" ]]; then
    log "WARN: TELEGRAM_TOKEN not set"
    return 1
  fi
  curl -s -X POST \
    "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    > /dev/null 2>&1 || log "WARN: Telegram send failed"
}

# =============================================================================
# Check expires_at rules
# =============================================================================

check_expiry() {
  if [[ ! -f "$RULES_FILE" ]]; then
    log "Rules file not found: $RULES_FILE"
    return 0
  fi

  python3 - <<PYEOF
import json, datetime, sys

WARN_DAYS = $WARN_DAYS
now = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc)
warn_threshold = now + datetime.timedelta(days=WARN_DAYS)

try:
    rules = json.load(open('$RULES_FILE'))
except Exception as e:
    print(f'ERROR: Cannot parse rules file: {e}', file=sys.stderr)
    sys.exit(1)

expiring_soon = []
already_expired = []

for rule in rules:
    expires_at = rule.get('expires_at')
    if not expires_at:
        continue
    try:
        exp = datetime.datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
    except Exception:
        continue
    if exp < now:
        already_expired.append((rule.get('id', '?'), expires_at))
    elif exp <= warn_threshold:
        days_left = (exp - now).days
        expiring_soon.append((rule.get('id', '?'), expires_at, days_left))

if expiring_soon:
    print('EXPIRING_SOON:' + '|'.join(f'{r[0]}:{r[1]}:{r[2]}d' for r in expiring_soon))
if already_expired:
    print('ALREADY_EXPIRED:' + '|'.join(f'{r[0]}:{r[1]}' for r in already_expired))
if not expiring_soon and not already_expired:
    print('ALL_OK')
PYEOF
}

# =============================================================================
# Main
# =============================================================================

main() {
  log "inhibit-expiry-reminder started"

  local output
  output="$(check_expiry 2>&1)"
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    log "ERROR: Failed to check expiry: $output"
    return 1
  fi

  local has_alerts=0

  while IFS= read -r line; do
    if [[ "$line" == "ALL_OK" ]]; then
      log "All inhibit rules expiry check passed — no rules expiring within ${WARN_DAYS} days"
      continue
    fi

    if [[ "$line" == EXPIRING_SOON:* ]]; then
      has_alerts=1
      local rules_str="${line#EXPIRING_SOON:}"
      log "WARN: Rules expiring soon: $rules_str"
      send_telegram "[INHIBIT EXPIRY WARNING] Rules expiring within ${WARN_DAYS} days:
${rules_str//|/\\n}

Edit rules: inhibit-cli list / inhibit-cli add"
    fi

    if [[ "$line" == ALREADY_EXPIRED:* ]]; then
      has_alerts=1
      local rules_str="${line#ALREADY_EXPIRED:}"
      log "WARN: Rules already expired: $rules_str"
      send_telegram "[INHIBIT EXPIRY ALERT] Rules are PAST expiry date:
${rules_str//|/\\n}

These rules are being skipped. Remove or extend them: inhibit-cli remove --id <id>"
    fi
  done <<< "$output"

  if [[ $has_alerts -eq 0 ]] && [[ "$output" != *"ALL_OK"* ]]; then
    log "No expiry information found (may be no rules with expires_at)"
  fi

  log "inhibit-expiry-reminder complete"
}

# Allow sourcing for tests
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
