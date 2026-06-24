#!/usr/bin/env bash
# threadwork pre-work tool-ownership check (UserPromptSubmit, FULL TEAM). FAIL-OPEN.
# Reminds every agent to confirm which tools/MCPs/skills it actually has — and who
# owns them — before starting work. Always exit 0; never blocks.
set +e
echo "[PRE-WORK CHECK] Before starting: confirm WHICH tools/MCPs/skills you actually have for THIS task, and WHO OWNS them. Ownership: Boss ALONE holds platform-admin, financial, and access-control permissions (Netlify / Supabase / GitHub / Shopify CLI, purchases, collaborator & permission management); steve / sadie / kiera do NOT. Scout your tools + skills (ToolSearch + the skill list) before executing — never assume a tool exists or that you own it."
exit 0
