# Anthropic `/rsa` Marketing Pattern — Worked Example

Walks Austin Lau's `/rsa` slash command (Google Ads Responsive Search Ad generator) through the 5-point orchestrator contract. Use this as the canonical reference when filling in your own orchestrator's SKILL.md.

**Sources:**
- Austin Lau blog: https://claude.com/blog/how-anthropic-uses-claude-marketing
- "How Anthropic teams use Claude Code" PDF, pp. 15–16 (sub-agent split: `headline-agent` + `description-agent`)
- Anthropic marketing plugin (`anthropics/knowledge-work-plugins/marketing`): canonical skill vocabulary `content-creation`, `brand-voice`, `competitive-analysis`, `performance-analytics`, `campaign-planning`

**Provenance note (Sadie's #765 finding):** ONLY Growth Marketing (Austin Lau's seat) has Anthropic-published architectural detail. The other-role decompositions implied below — Customer Marketer, Influencer Marketer, Product Marketer, Partner Marketer — are derivative/extrapolated from this single data point. They are NOT Anthropic-blessed; treat them as "Anthropic-style" rather than "per Anthropic spec."

---

## Point 1: Architecture

`/rsa` is an orchestrator that fans out to two specialized sub-agents and three Agent Skills.

- **`headline-agent`** (Opus): generates 15 RSA headline variants per campaign. Sole responsibility: headline copywriting.
- **`description-agent`** (Opus): generates 4 RSA description variants per campaign. Sole responsibility: description copywriting.
- Skills invoked by both: `brand-voice` (tone enforcement), `content-creation` (general copywriting craft), and a Google Ads RSA best-practices skill (Austin's custom).

PDF p. 16 quote: *"Break complex workflows into specialized sub-agents… create separate agents for specific tasks (like their headline agent vs. description agent). This makes debugging easier and improves output quality."* That's the explicit Anthropic justification for the split.

**Derived (non-Anthropic-blessed) extension:** the same fan-out shape would map to a Customer-Marketer `/case-study` orchestrator (case-study-draft-agent + customer-quote-agent) or an Influencer-Marketer `/script` orchestrator (hook-agent + body-agent + cta-agent). Anthropic has not published these.

## Point 2: Inputs

`/rsa` requires three inputs upfront before any sub-agent fires:
- `campaign_data`: the Google Ads campaign metadata (target audience, ad group, geo).
- `existing_copy`: prior-iteration RSA assets (for continuity and de-duplication).
- `target_keywords`: list of keywords the RSA must rank for.

Blog quote: *"Claude Code asks for campaign data, existing copy, and keywords, then cross-references inputs against Agent Skills created for Anthropic's brand tone and voice, product accuracy, and Google Ads RSA best practices."*

Validation: `/rsa` fails fast if `target_keywords` is empty (no headlines to target) or if `campaign_data` lacks an ad group ID (downstream Meta Ads MCP write would fail).

**For your orchestrator:** mirror this — list inputs, mark required/optional, name the source (user prompt, file path, MCP connector), and describe the failure mode for missing data.

## Point 3: Handoffs

Each `/rsa` sub-agent writes a structured artifact to a known path:
- `headline-agent` writes `.rsa/<campaign>/headlines.json` (15 entries: text, char_count, keyword_match_score).
- `description-agent` writes `.rsa/<campaign>/descriptions.json` (4 entries: text, char_count).
- The `brand-voice` skill reads both JSONs, scores each variant against the brand-voice doc, and writes `.rsa/<campaign>/brand-scores.json`.
- The orchestrator's join step reads all three JSONs, filters by score threshold, and assembles the final RSA bundle.

Skill cross-references (verbatim from Anthropic's marketing plugin vocabulary):
- `brand-voice` — tone/voice scoring
- `content-creation` — general copywriting craft
- `competitive-analysis` — used in adjacent `/competitive-brief` orchestrator
- `performance-analytics` — used post-launch in `/performance-report`
- `campaign-planning` — used by sister `/campaign-plan` orchestrator

**For your orchestrator:** specify the file path, the JSON schema, and the read/write agents per artifact. Reuse the Anthropic skill names verbatim where they fit; do not invent parallel names.

## Point 4: HITL (Human-in-the-Loop)

`/rsa` gates the user BEFORE pushing copy to Meta Ads or Google Ads. The flow:
1. Sub-agents run and produce headline + description JSONs.
2. Orchestrator assembles a single review artifact: ranked variants with brand scores.
3. User sees the bundle, approves a subset (or rejects and asks for regeneration).
4. ONLY on approval does the Meta Ads MCP write fire.

Cowork principle: *"Before Claude acts, it shows you the plan and waits for your approval. Redirect, refine, or take a different approach at any step."*

Read-only side-effects (writing scratch JSONs to `.rsa/`) do not need a gate. The external publish does.

**For your orchestrator:** identify every external write (publish, send, push, charge) and gate it. Identify the approval surface (Telegram reply, terminal `y/N`, sprint contract).

## Point 5: Visual Results

`/rsa` returns a finished bundle, not a step-by-step transcript:
- A markdown table of approved RSA variants (headlines + descriptions, with scores).
- A one-line PASS summary above the table: `PASS — 12/15 headlines + 4/4 descriptions cleared brand threshold ≥ 0.8`.
- Sub-agent intermediate JSONs stay in `.rsa/<campaign>/` for audit; they don't show up in the chat.

Cowork: *"finished work instead of step-by-step updates: a formatted spreadsheet, a memo, a briefing doc."*

**For your orchestrator:** define the deliverable's exact format. Lead with a triage line (PASS/PARTIAL/FAILED + headline metric). Suppress intermediate chatter; log to sidecar.

---

## Mapping to non-Growth marketing roles (DERIVED, not Anthropic-blessed)

Per Sadie's #765 research: Anthropic has published per-agent decomposition for Growth Marketing only. The four other marketing roles have one-line outcome metrics in the blog but no architectural detail. If you author orchestrators for Customer / Influencer / Product / Partner Marketer workflows, treat the structure as derivative — reuse the 5-point contract and the Anthropic skill vocabulary, but do not claim Anthropic prescribes the specific sub-agent split. Flag that derivation in your skill's frontmatter description.
