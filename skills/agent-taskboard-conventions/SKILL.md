---
name: agent-taskboard-conventions
description: Conventions for reading and writing the Agent Taskboard (Trello board id 69fb292ef38b61c3bb1be54d, accessed via the tasks-MCP). Use BEFORE any card_create / card_update on the Agent Taskboard. Covers lists/stages, the 4-dimension card encoding (brand label + action label + stage list + lane owner), brand label table, lane roster, approval flow, auto-rules, and the agent onboarding contract. Triggers when an agent is about to create, move, label, or edit a card on the Agent Taskboard.
---

# Agent Taskboard — Operating Conventions

Canonical source: the `[META] LEGEND — Agent Taskboard Operating Manual` card
(stable id `6a03632337f355a1baa45e41`, exposed to agents as
`TASKBOARD_LEGEND_CARD_ID`) in the META list of the Agent Taskboard
(board id `69fb292ef38b61c3bb1be54d`, https://trello.com/b/d6H5rEO9).

This skill is the locally-installed mirror of that manual. The LEGEND card is
authoritative — if conventions have evolved, re-read it via
`card_get` on `6a03632337f355a1baa45e41` (single round-trip) or
`card_search "LEGEND"`.

## Onboarding contract — do this BEFORE any board write

1. Re-read the LEGEND card (`card_get 6a03632337f355a1baa45e41`) — conventions
   may have changed since this mirror was installed.
2. Ensure every new/updated card carries:
   - a project **cover color**,
   - exactly one **brand label**,
   - exactly one **action label**,
   - a `[Lane]` **title prefix**,
   - a `**Owner: @<lane>**` **first description line**.
3. Append an audit comment on every edit: `edited by @<agent>`.

## Lists (workflow stage)

`META → BACKLOG → DRAFT → PLANNING → READY → IN PROGRESS → BLOCKED → REVIEW → DONE`

META is reserved for board infrastructure (LEGEND, Welcome, automation
registry). All real work flows BACKLOG → DONE. (Board also has
`POLICIES / DOCUMENTATION` and `RESOURCES` reference lists.)

## Card encoding — 4 dimensions

| Dimension | Where | Values |
|---|---|---|
| Brand / project | Label (also reflected in cover color) | ALPHA · SOAK · PIKA · PP · GASTOWN · OSTEO · LISTIT · TW · ADMIN · META |
| Action | Label | BUILD (red) · RESEARCH (yellow) · DECIDE (purple) · BLOCKED (black) · COMMS (sky) · ADMIN (lime) |
| Stage | List | see Lists above |
| Owner / lane | Title prefix `[Lane]` + first desc line `**Owner: @<lane>**` | @cal · @email · @revolut · @design · @finance · @marketing · @procurement · @cto · @meta |

- Card title format: `[Lane] Title text` — brand is on a **label**, NOT in the title.
- Description first line: `**Owner: @<lane>**`
- Required labels: one brand + one action = two minimum on every card. Harness
  sub-tags (ALPHASTORE, VATRECOVERY, Approved) stack on top when applicable.

## Brand labels

Exactly one brand label per card. Cross-brand: pick the primary, list the rest
in the description.

| Brand | Label | Color | Cover |
|---|---|---|---|
| Alpha Performance | ALPHA | orange | orange |
| SOAK | SOAK | green_dark | green |
| PikaPesu | PIKA | green | green |
| ProcessPulse | PP | blue | blue |
| GASTOWN | GASTOWN | blue | blue |
| OsteoFlow | OSTEO | sky | sky |
| ListIt | LISTIT | pink | pink |
| Threadworks / Personal | TW | purple | purple |
| Admin / Legal / Tax | ADMIN (re-uses lime action label) | lime | black |
| Board infrastructure | META | black | black |

Legacy lowercase labels (`pikapesu`, `threadwork`, `design`, `draft`) are
DEPRECATED — do not apply to new cards.

## Lane roster — domain definitions

| Lane | Tag | Owns |
|---|---|---|
| Calendar | @cal | Meeting scheduling, GCal / Apple Calendar sync, time blocking, reschedule logic, availability |
| Email | @email | Gmail drafting / triage / replies (Xavier, Hanna, Alpha, SOAK), follow-up sequences, inbox-zero |
| Revolut | @revolut | Revolut Business: payments, transfers, expense categorisation, cards, FX |
| Design | @design | Visual design (web/social/print), brand assets, mockups, image gen (NanoBanana), photo selection |
| Finance | @finance | Xero, Hubdoc, P&L, budgets, tax prep (FIN/UK/IRL), invoicing, reconciliation |
| Marketing | @marketing | Social posts (IG/X/LinkedIn/TikTok), ads, content calendars, growth campaigns, copywriting |
| Procurement | @procurement | Sourcing (Alibaba/local), vendor research, MOQ negotiation, samples, supply contracts, quotes |
| CTO | @cto | Engineering, infra, MCPs, agent fleet, code shipping, repos, deploys. Has a sub-team. |
| Meta | @meta | Board infrastructure only — not a lane for real work. |

Routing rule: match the card title/description against each lane's "Owns"
column. If ambiguous, default to @cto and ping Xavier in #morning-digest.

## Approval flow (Telegram-first)

1. Agent drafts → card in DRAFT + posts to lane TG channel with full draft +
   `[Approve] [Edit] [Skip]` buttons.
2. Approve → n8n moves card to DONE, agent executes, agent appends confirmation comment.
3. Edit → card to REVIEW with edit request appended, agent re-drafts in same TG thread.
4. Skip → card archived (`closed:true`) with audit comment "skipped by @<requester>".

## Auto-rules

- IN PROGRESS >7d untouched → owner agent TG nudge in lane channel.
- DRAFT / PLANNING >14d untouched → same nudge.
- BLOCKED >3d → escalation to #soak-needs-you.
- Manual card with no `Owner:` line → triage agent assigns owner within 1h.
- Card with no brand label → triage agent applies one within 1h.

## TG channel topology

- Per-lane: #cal #email #revolut #design #finance #marketing #procurement #cto
- Master urgent: #soak-needs-you (2–3 pings/week max)
- Morning digest: #morning-digest (07:00 Europe/Helsinki)

## Brand cover assets

Apply covers via URL attachment with `setCover=true` when an asset URL exists,
else fall back to the solid brand cover color. SOAK / PikaPesu asset:
`https://raw.githubusercontent.com/0xAddict/brand-assets/main/soak/icon-512.png`

---
_Installed mirror of the LEGEND card manual (card-content last updated 2026-05-14).
The Trello-attached SKILL.md download is auth-gated; this mirror was built from
the authoritative LEGEND card description, which the card states contains "the
full operating manual in one shot."_
