#!/usr/bin/env bash
# threadwork sender-gate (UserPromptSubmit). FAIL-OPEN by design, HARD-BLOCK on match.
#
# For boss + snoopy ONLY: if a GENUINE direct inbound message originated from
# Coach Stokes's Telegram (user_id 7657065545), this hook HARD-BLOCKS the prompt
# by writing to stderr and exiting 2. In Claude Code a UserPromptSubmit hook that
# exits 2 stops the prompt from being processed and surfaces stderr to the agent,
# so boss/snoopy literally cannot execute Stokes's request in-session; the
# upstream router hands it off to a worker (steve / sadie / kiera). Gwei's TG
# (1712539766) and every other sender pass through untouched.
#
# CRITICAL: match ONLY the genuine inbound channel attribute  user_id="7657065545"
# (equals + double-quote, optional whitespace around =). A bare mention of the id
# in prose — e.g. escalation tasks/nudges that QUOTE  chat 7657065545  or
# user_id 7657065545  (no =") — must NOT block, or boss could never process an
# escalation that references him.
#
# Any error, wrong agent, empty/missing/malformed input, or non-match -> exit 0
# with no block, so a bug can NEVER brick boss/snoopy.
set +e
input="$(cat 2>/dev/null)"
agent="${AGENT_LABEL:-}"

# Scope: only the two orchestrator sessions. Everyone else is a no-op.
case "$agent" in
  boss|snoopy) : ;;
  *) exit 0 ;;
esac

# Coach Stokes TG id = 7657065545 (HARD-block + handoff). Gwei = 1712539766 (normal).
# Match the precise inbound attribute form  user_id="7657065545"  (allow optional
# whitespace around the =, but REQUIRE the opening double-quote). A quoted mention
# like  user_id 7657065545  has no =" and therefore will NOT match.
# 2026-07-11 fix (snoopy): UserPromptSubmit stdin is JSON, so the tag's quotes
# arrive escaped (user_id=\"7657065545\") and the bare ="… form never matched —
# the hard block was silently inert. Allow an optional backslash before each
# quote so both raw and JSON-encoded attribute forms match; prose mentions
# (no =" at all) still pass.
if printf '%s' "$input" | grep -Eq 'user_id[[:space:]]*=[[:space:]]*\\?"7657065545\\?"'; then
  echo "[SENDER-GATE/HARD] Direct message from Coach Stokes (TG 7657065545). Team policy: boss/snoopy do NOT execute Stokes's requests. This prompt is BLOCKED — the upstream router will route it to a worker (steve/sadie/kiera). Gwei TG 1712539766 is handled normally." >&2
  exit 2
fi
exit 0
