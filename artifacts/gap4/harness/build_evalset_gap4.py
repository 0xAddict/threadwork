#!/usr/bin/env python3
"""Build the GAP-4 recall+PRECISION eval set (#10060821), versioned + deterministic.

4 strata (contract-labeled):
  - semantic-paraphrase : Kiera Stage-2a 36 low-overlap paraphrase queries + golds (frozen,
                          loaded verbatim from gap4b/evalset.json). Recall stress.
  - keyword-exact       : exact-keyword queries; gold must stay top-3 (keyword anchoring).
  - brand-bearing       : the 7 proper-noun-restored variants (Stage-2b realism gate flagged
                          scrubbing inflated the headline) — loaded verbatim from gap4b/evalset_brand.json.
  - adversarial-distractor : queries paired with KNOWN-IRRELEVANT hard-negative distractor IDs
                          (validated semantically-near via dense-neighbor mining on the live copy)
                          that must NOT surface in top-k. Precision / false-positive probe.

Distractor IDs were selected objectively: each is a non-gold memory that the dense channel ranks
NEAR the query (mined dense-rank shown), and each is manually confirmed to NOT answer the query.
Justifications are emitted alongside for independent audit.
"""
import json, sys

GAP4B = "/private/tmp/claude-501/-/772f3524-c142-4f84-84ef-00c4103a52aa/scratchpad/gap4b"
OUT = "/Users/coachstokes/.claude/mcp-servers/task-board/artifacts/gap4/evalset.json"

base = json.load(open(f"{GAP4B}/evalset.json"))
brand = json.load(open(f"{GAP4B}/evalset_brand.json"))
brand_by_qid = {b["qid"]: b for b in brand}

evalset = []

# ---- stratum 1: semantic-paraphrase (verbatim from Kiera Stage-2a) ----
for e in base:
    evalset.append({
        "qid": f"SP-{e['qid']}",
        "query": e["query"],
        "gold_ids": [e["gold_target_id"]],
        "recall_agent": e["recall_agent"],
        "stratum": "semantic-paraphrase",
        "weight": e["weight"],
        "distractor_ids": [],
        "source": f"kiera-stage2a:{e['qid']}",
        "overlap_bucket": e.get("overlap_bucket"),
    })

# ---- stratum 2: brand-bearing (the 7 proper-noun-restored variants) ----
BRAND_QIDS = ["A12", "B01", "B02", "B05", "B06", "B08", "B10"]  # the queries that differ base->brand
for qid in BRAND_QIDS:
    b = brand_by_qid[qid]
    evalset.append({
        "qid": f"BR-{qid}",
        "query": b["query"],
        "gold_ids": [b["gold_target_id"]],
        "recall_agent": b["recall_agent"],
        "stratum": "brand-bearing",
        "weight": 1.0,
        "distractor_ids": [],
        "source": f"kiera-stage2b-brand:{qid}",
        "overlap_bucket": b.get("overlap_bucket"),
    })

# ---- stratum 3: keyword-exact (exact-keyword controls; gold must stay top-3) ----
KEYWORD = [
    {"qid": "KW-camo", "gold_ids": [1382], "recall_agent": "shared",
     "query": "Camo SD SP-PAT-COMPETITOR campaign 435425421867687 PAUSED PERMANENTLY do not unpause"},
    {"qid": "KW-smartlead", "gold_ids": [2528], "recall_agent": "shared",
     "query": "smartlead-key-persisted SMARTLEAD_API_KEY ~/.claude/.env expired trial"},
    {"qid": "KW-amazon", "gold_ids": [1327], "recall_agent": "shared",
     "query": "Amazon Ads SP campaigns PROFILE 1592800217706640 vnd.spcampaign.v3 ENABLED write API"},
    {"qid": "KW-trello", "gold_ids": [1730], "recall_agent": "shared",
     "query": "Trello Agent Taskboard board_id 69fb292 attachment cap MCP claude_ai_tasks-MCP"},
    {"qid": "KW-tts", "gold_ids": [18], "recall_agent": "shared",
     "query": "ElevenLabs voice persona Telegram TTS Boss Steve Kiera Sadie"},
    {"qid": "KW-kairos", "gold_ids": [66], "recall_agent": "shared",
     "query": "Kairos Productivity Monitor kairos-monitor.sh daemon /Users/coachstokes/bin"},
    {"qid": "KW-gh", "gold_ids": [730], "recall_agent": "kiera",
     "query": "gh CLI .volta/bin/gh PATH two binaries broken type error"},
]
for k in KEYWORD:
    evalset.append({**k, "stratum": "keyword-exact", "weight": 1.0,
                    "distractor_ids": [], "source": "gap4-authored-keyword",
                    "overlap_bucket": "high"})

# ---- stratum 4: adversarial-distractor (precision / FPR). distractor_ids = labeled hard negatives.
# Each distractor: (id, dense_rank_in_query, why_irrelevant) — mined + manually confirmed.
ADV = [
    {"qid": "ADV-domains", "gold_ids": [284], "recall_agent": "boss",
     "query": "which of our web addresses is the real storefront we push search rankings for, versus the one that only exists to send mail?",
     "distractors": [
        (1597, 2, "operational email-ROUTING fact (xavier@repthea.com ownership) — about an email address, not which Two8 DOMAIN is the SEO storefront vs mail-only"),
        (2303, 10, "Google Workspace topology fact — email/domain infra adjacent but does NOT state which domain is the primary SEO storefront vs mail-only"),
     ]},
    {"qid": "ADV-smartlead-cred", "gold_ids": [2528], "recall_agent": "shared",
     "query": "where is the API credential stored for our cold-outreach email sending platform, and does the lapsed subscription stop the API from working?",
     "distractors": [
        (1308, 1, "GMAIL credential digest-silence root cause — a DIFFERENT credential/system (Gmail), not the Smartlead cold-outreach API key"),
        (2536, 8, "infra-constraint: no LLM/model API key in Netlify — a different missing credential entirely"),
        (1675, 12, "generic credential-HYGIENE rule (don't echo passwords) — not where the Smartlead key is stored"),
     ]},
    {"qid": "ADV-campaign-off", "gold_ids": [1382], "recall_agent": "shared",
     "query": "which ad campaign is permanently switched off for good and must never be suggested to turn back on?",
     "distractors": [
        (1346, 4, "Two8 ads 'pending' two-table mental model — ad-domain adjacent, not the permanently-paused campaign"),
        (1344, 11, "May SP campaigns PARKED for human pickup (do not flag broken) — parked/transient, NOT 'permanently off forever'"),
        (1327, 14, "Amazon Ads write API ENABLE shapes — about ENABLING campaigns, the opposite of the permanently-off rule"),
     ]},
    {"qid": "ADV-gh-path", "gold_ids": [730], "recall_agent": "kiera",
     "query": "the genuine GitHub command-line tool keeps erroring with a type error — could a second conflicting install be shadowing it on the PATH?",
     "distractors": [
        (1295, 7, "two8-book dashboard repo paths/Netlify — a github REPO fact, not the gh-binary PATH-shadowing gotcha"),
        (718, 9, "two8-book canonical DEPLOY path — deploy/path adjacent, not the duplicate-gh-binary issue"),
        (2565, 12, "canonical threadwork repo path/remote — repo path fact, not the gh CLI shadowing"),
     ]},
    {"qid": "ADV-launchd-locale", "gold_ids": [2211], "recall_agent": "shared",
     "query": "my scheduled background job garbles text with odd spacing even though the exact same script parses fine when I run it by hand?",
     "distractors": [
        (340, 2, "watchdog/heartbeat rewrite decision — scheduled/daemon adjacent, not the launchd C-locale multibyte-whitespace cause"),
        (1303, 12, "Netlify Scheduled Functions silently throttled on free tier — a different scheduled-job problem and cause"),
     ]},
    {"qid": "ADV-team-email", "gold_ids": [2171], "recall_agent": "shared",
     "query": "what is the shared email inbox address the agent team sends and receives mail from?",
     "distractors": [
        (2474, 2, "shared TELEGRAM bot mapping — a shared-comms identity fact but Telegram, not the team EMAIL inbox"),
        (1597, 3, "xavier@repthea.com belongs to GweiSprayer ONLY — an email-ownership fact, explicitly NOT the team inbox"),
        (375, 5, "GweiSprayer's email for test sends/redirects — a person's email, not the team's shared inbox"),
     ]},
    {"qid": "ADV-no-llm-key", "gold_ids": [2536], "recall_agent": "shared",
     "query": "can the booking website call an LLM model server-side to generate briefs, or is there simply no model API key available to it?",
     "distractors": [
        (131, 2, "pre-call-brief role/workflow instruction — about who writes briefs, not whether a model API key exists for the site"),
        (14, 3, "two8-book booking system webhook-settings note — booking-site adjacent, does not address LLM/model API key availability"),
     ]},
]
for a in ADV:
    evalset.append({
        "qid": a["qid"], "query": a["query"], "gold_ids": a["gold_ids"],
        "recall_agent": a["recall_agent"], "stratum": "adversarial-distractor",
        "weight": 1.0,
        "distractor_ids": [d[0] for d in a["distractors"]],
        "distractor_justification": [
            {"id": d[0], "mined_dense_rank": d[1], "why_irrelevant": d[2]} for d in a["distractors"]],
        "source": "gap4-authored-adversarial",
        "overlap_bucket": "low",
    })

json.dump(evalset, open(OUT, "w"), indent=2)

from collections import Counter
strata = Counter(e["stratum"] for e in evalset)
print(f"wrote {OUT}")
print(f"total queries: {len(evalset)}")
print(f"strata: {dict(strata)}")
print(f"adversarial distractor ids (must NOT surface): "
      f"{sorted(set(d for e in evalset for d in e['distractor_ids']))}")
# sanity: PER-QUERY a distractor must never be that query's own gold (relevance is per-query;
# a memory MAY be a gold for one query and an irrelevant distractor for a different query).
for e in evalset:
    bad = set(e["gold_ids"]) & set(e["distractor_ids"])
    assert not bad, f"FATAL: {e['qid']} lists {bad} as both gold and distractor"
# informational: distractor ids that happen to be some OTHER query's gold (allowed, expected)
golds = set(g for e in evalset for g in e["gold_ids"])
dists = set(d for e in evalset for d in e["distractor_ids"])
print(f"distractor ids that are some OTHER query's gold (allowed): {sorted(golds & dists)}")
print("per-query gold/distractor disjointness: OK")
