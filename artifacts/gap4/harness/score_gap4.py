#!/usr/bin/env python3
"""GAP-4 scorer (#10060821). Computes recall+PRECISION metrics per arm x k x stratum
from the sweep raw_runs.json (real recallAugmented top-10 outputs).

METRIC DEFINITIONS (published for objective grading):
  gold_rank(q,arm)  = min position (1-based) of any q.gold_ids in the arm's top-10, else None.
  recall@10         = mean_w[ 1 if gold_rank<=10 else 0 ]                 (gold in top-10)
  recall@3          = mean_w[ 1 if gold_rank<=3  else 0 ]
  MRR@3             = mean_w[ 1/gold_rank if gold_rank<=3 else 0 ]
  -- precision (needs labeled known-irrelevant ids) --
  fp_dist(q,arm)    = count of q.distractor_ids present in top-10        (labeled hard negatives)
  FPR@10_adv        = mean over adversarial queries of fp_dist/10        (frac of top-10 that are known distractors; LOWER better)
  precision@10_adv  = mean over adversarial queries of goldHits/(goldHits+fp_dist)  (purity among JUDGED items; undefined->skipped)
  fp_debrief(q,arm) = count of the 28 Session-Debrief aggregate ids in top-10 (canonical query-independent irrelevant class)
  debriefFPR@10     = mean over ALL queries of fp_debrief/10             (global precision probe; LOWER better)
weights: Kiera's 545-dual queries carry weight 0.5 (SP-A08 + SP-B09) so memory 545 contributes 1.0.
"""
import json, sys
from collections import defaultdict, OrderedDict

RUNS = "/Users/coachstokes/.claude/mcp-servers/task-board/artifacts/gap4/raw_runs.json"
OUT_JSON = "/Users/coachstokes/.claude/mcp-servers/task-board/artifacts/gap4/results.json"
OUT_PQ = "/Users/coachstokes/.claude/mcp-servers/task-board/artifacts/gap4/per_query.json"

DEBRIEF_IDS = set([561,824,927,984,1050,1602,1649,1897,1916,1982,2005,2029,2233,2253,2265,2286,2311,2323,2339,2407,2431,2441,2455,2569,2580,2600,2616,2644])

data = json.load(open(RUNS))
runs = data["results"]
CONFIG_ORDER = [p["config"] for p in data["proofs"]]
STRATA = ["semantic-paraphrase", "keyword-exact", "brand-bearing", "adversarial-distractor"]

def gold_rank(top10, golds):
    ranks = [top10.index(g)+1 for g in golds if g in top10]
    return min(ranks) if ranks else None

# index runs by (config, qid)
by = {(r["config"], r["qid"]): r for r in runs}
qids = OrderedDict((r["qid"], r) for r in runs)  # first occurrence carries stratum/gold/dist/weight

def wmean(pairs):  # pairs: list of (value, weight)
    sw = sum(w for _, w in pairs)
    return (sum(v*w for v, w in pairs) / sw) if sw else 0.0

# ---- per-query records (one row per qid, ranks under each config) ----
per_query = []
for qid, meta in qids.items():
    row = {"qid": qid, "stratum": meta["stratum"], "gold_ids": meta["gold_ids"],
           "distractor_ids": meta["distractor_ids"], "weight": meta["weight"],
           "recall_agent": meta["recall_agent"], "ranks": {}, "fp_dist": {}, "fp_debrief": {}}
    for cfg in CONFIG_ORDER:
        r = by[(cfg, qid)]
        gr = gold_rank(r["top10"], meta["gold_ids"])
        row["ranks"][cfg] = gr
        row["fp_dist"][cfg] = sum(1 for d in meta["distractor_ids"] if d in r["top10"])
        row["fp_debrief"][cfg] = sum(1 for d in r["top10"] if d in DEBRIEF_IDS)
    per_query.append(row)

def subset(stratum=None):
    return [r for r in per_query if (stratum is None or r["stratum"] == stratum)]

def metrics_for(rows, cfg):
    rk = [(r["ranks"][cfg], r["weight"]) for r in rows]
    rec10 = wmean([(1.0 if (x is not None and x <= 10) else 0.0, w) for x, w in rk])
    rec3 = wmean([(1.0 if (x is not None and x <= 3) else 0.0, w) for x, w in rk])
    mrr3 = wmean([((1.0/x) if (x is not None and x <= 3) else 0.0, w) for x, w in rk])
    deb = wmean([(r["fp_debrief"][cfg]/10.0, r["weight"]) for r in rows])
    out = {"n": len(rows), "eff_n": round(sum(r["weight"] for r in rows), 2),
           "recall@10": rec10, "recall@3": rec3, "MRR@3": mrr3, "debriefFPR@10": deb}
    # precision metrics only meaningful where distractor labels exist
    advrows = [r for r in rows if r["distractor_ids"]]
    if advrows:
        fpr = wmean([(r["fp_dist"][cfg]/10.0, r["weight"]) for r in advrows])
        # precision@10 among judged items (gold-hits + distractor-hits)
        prec_pairs = []
        for r in advrows:
            gh = 1 if (r["ranks"][cfg] is not None and r["ranks"][cfg] <= 10) else 0
            fh = r["fp_dist"][cfg]
            judged = gh + fh
            if judged > 0:
                prec_pairs.append((gh/judged, r["weight"]))
        out["FPR@10"] = fpr
        out["precision@10"] = wmean(prec_pairs) if prec_pairs else None
        out["mean_distractor_hits"] = wmean([(float(r["fp_dist"][cfg]), r["weight"]) for r in advrows])
    return out

results = {"metric_definitions": __doc__, "config_order": CONFIG_ORDER,
           "debrief_distractor_ids": sorted(DEBRIEF_IDS), "strata": {}, "overall": {}}
for cfg in CONFIG_ORDER:
    results["overall"][cfg] = metrics_for(per_query, cfg)
for s in STRATA:
    results["strata"][s] = {cfg: metrics_for(subset(s), cfg) for cfg in CONFIG_ORDER}

json.dump(results, open(OUT_JSON, "w"), indent=2, default=lambda o: None)
json.dump(per_query, open(OUT_PQ, "w"), indent=2)

# ---- console tables ----
def fmt(m, keys):
    return "".join(f"{(('%.3f'%m[k]) if isinstance(m.get(k),(int,float)) else str(m.get(k))):>13}" for k in keys)

print("="*120)
print("GAP-4 RESULTS — real recallAugmented path, deterministic, live-DB COW copy, per-(config,query) fresh clone")
print("="*120)

print("\n##### PER-STRATUM: recall@10 / recall@3 / MRR@3  #####")
for s in STRATA:
    rows = subset(s)
    print(f"\n--- {s}  (n={len(rows)}, eff_n={round(sum(r['weight'] for r in rows),2)}) ---")
    print(f"{'arm':<12}{'recall@10':>13}{'recall@3':>13}{'MRR@3':>13}{'debriefFPR':>13}")
    for cfg in CONFIG_ORDER:
        m = results["strata"][s][cfg]
        print(f"{cfg:<12}{m['recall@10']:>13.3f}{m['recall@3']:>13.3f}{m['MRR@3']:>13.3f}{m['debriefFPR@10']:>13.3f}")

print("\n##### ADVERSARIAL-DISTRACTOR PRECISION (FPR@10 / precision@10 / mean distractor-hits) #####")
print(f"{'arm':<12}{'recall@10':>12}{'MRR@3':>10}{'FPR@10':>10}{'precision@10':>14}{'meanDistHit':>13}")
for cfg in CONFIG_ORDER:
    m = results["strata"]["adversarial-distractor"][cfg]
    p = m.get("precision@10"); p = ("%.3f"%p) if isinstance(p,(int,float)) else "n/a"
    print(f"{cfg:<12}{m['recall@10']:>12.3f}{m['MRR@3']:>10.3f}{m['FPR@10']:>10.3f}{p:>14}{m['mean_distractor_hits']:>13.3f}")

print("\n##### RECALL-vs-PRECISION CURVE over RRF k (semantic+brand recall vs adversarial FPR & debriefFPR) #####")
recall_rows = subset("semantic-paraphrase") + subset("brand-bearing")
print(f"{'arm':<12}{'recall@10(sem+brand)':>22}{'MRR@3':>10}{'advFPR@10':>12}{'debriefFPR(all)':>17}")
for cfg in CONFIG_ORDER:
    rm = metrics_for(recall_rows, cfg)
    am = results["strata"]["adversarial-distractor"][cfg]
    ov = results["overall"][cfg]
    print(f"{cfg:<12}{rm['recall@10']:>22.3f}{rm['MRR@3']:>10.3f}{am['FPR@10']:>12.3f}{ov['debriefFPR@10']:>17.3f}")

print(f"\nwrote {OUT_JSON} + {OUT_PQ}")
