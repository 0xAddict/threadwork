#!/usr/bin/env python3
"""
P3 measure-first STAGE-2a — scorer (#10060825). DETERMINISTIC, no LLM, no network.

Answers the LOCKED question: on a real threadwork delegation sample, does a CURATED
(recall-selected, capped) delegation brief improve delegatee outcomes vs THIN
(free-text description only, status quo) and FULL-DUMP (delegator's full context)?

Outcome proxy = needed-fact COVERAGE (recall), PRECISION (signal vs noise), TOKEN COST.

GROUND TRUTH (needed facts G) is derived from the completed task's RESULT, which is
an INDEPENDENT signal from the recall query (the DESCRIPTION). recall() selects
against the description; G is grounded against the result. The two are computed from
different texts, so CURATED is NOT trivially constructed to contain G.

All metric definitions, weights, thresholds are published below and swept for
sensitivity. Mirrors GAP-4 objective-grading discipline.

Usage: python3 score_p3.py <sample.json> <memdump.json> <out_results.json> <out_per_instance.json>
"""
import sys, json, re, math
from collections import defaultdict

SAMPLE, MEMDUMP, OUT_RESULTS, OUT_PER = sys.argv[1:5]

# ---- tokenizer: \w+ keeps identifiers whole (taskboard_dense_recall, sha 99db206,
# task ids 10060816) while splitting on punctuation. Distinctive-term friendly. ----
_TOK = re.compile(r'[a-z0-9_]+')
# Minimal standard English stopword set (function words only — NO domain stoplist,
# so we don't hand-bias which threadwork terms count; IDF down-weights common terms).
STOP = set("""a an the and or but if then else of to in on at by for with from into over under
as is are was were be been being do does did doing have has had having i you he she it we they
this that these those there here it's its their his her your our my me him them us not no nor so
than too very can will just don't should now what which who whom when where why how all any both
each few more most other some such only own same s t up out off down about above below again
""".split())

def toks(text):
    return [w for w in _TOK.findall((text or '').lower()) if w not in STOP and len(w) > 1]

def tokset(text):
    return set(toks(text))

sample = json.load(open(SAMPLE))
memdump = {int(k): v for k, v in json.load(open(MEMDUMP)).items()}

# ---- IDF over the memory corpus (the document collection of delegator facts) ----
N_DOCS = len(memdump)
df = defaultdict(int)
mem_tokset = {}
for mid, m in memdump.items():
    ts = tokset(m['content'])
    mem_tokset[mid] = ts
    for t in ts:
        df[t] += 1
def idf(t):
    return math.log((N_DOCS + 1) / (df.get(t, 0) + 1)) + 1.0
# "high-IDF / distinctive" = token appears in <= 5% of the corpus (rare specific entity)
HIGH_IDF_DF = max(1, int(0.05 * N_DOCS))   # df threshold for "distinctive"
def is_distinctive(t):
    return df.get(t, N_DOCS) <= HIGH_IDF_DF

def salience(ts):
    return sum(idf(t) for t in ts)

def grounding_score(mem_ts, text_ts):
    """Salience-weighted fraction of THIS memory's distinctive content echoed in text.
    = sum idf(shared) / sum idf(mem).  In [0,1]. 1.0 when mem_ts ⊆ text_ts (verbatim)."""
    denom = salience(mem_ts)
    if denom <= 0:
        return 0.0
    shared = mem_ts & text_ts
    return salience(shared) / denom

def covered(mem_ts, text_ts, tau):
    """A needed fact is delivered by a condition's text if salience-grounded >= tau
    AND shares >=1 distinctive term (so generic-vocab overlap alone never 'covers')."""
    shared = mem_ts & text_ts
    if not any(is_distinctive(t) for t in shared):
        return False
    return grounding_score(mem_ts, text_ts) >= tau

def est_tokens(chars):
    return math.ceil(chars / 4)  # standard ~4 chars/token heuristic (deterministic)

CURATED_NS = [3, 5, 8, 12]
TAUS = [0.10, 0.15, 0.20, 0.25]
TAU_PRIMARY = 0.15

def analyze(tau):
    rows = []
    for inst in sample:
        desc_ts = tokset(inst['description'])
        res_ts = tokset(inst['result'])
        pool = [mid for mid in inst['pit_pool_ids'] if mid in memdump]
        recall_order = [mid for mid in inst['recall_order'] if mid in memdump]
        # ---- G = needed facts: pool memories grounded in the RESULT (independent of desc) ----
        G = set()
        for mid in pool:
            if covered(mem_tokset[mid], res_ts, tau):
                G.add(mid)
        nG = len(G)
        # ---- coverage per condition (fraction of G delivered) ----
        # THIN text = description tokens
        thin_cov = sum(1 for g in G if covered(mem_tokset[g], desc_ts, tau)) / nG if nG else None
        # CURATED@N text = description ∪ tokens(top-N recalled memories)
        cur_cov = {}
        cur_prec = {}
        cur_tok = {}
        for Ncap in CURATED_NS:
            topN = recall_order[:Ncap]
            cur_text_ts = set(desc_ts)
            for mid in topN:
                cur_text_ts |= mem_tokset[mid]
            cur_cov[Ncap] = (sum(1 for g in G if covered(mem_tokset[g], cur_text_ts, tau)) / nG) if nG else None
            cur_prec[Ncap] = (len(set(topN) & G) / len(topN)) if topN else None
            cur_tok[Ncap] = est_tokens(len(inst['description'])) + sum(est_tokens(memdump[mid]['len']) for mid in topN)
        # FULL-DUMP text = description ∪ all pool → covers all G by construction = 1.0
        full_cov = 1.0 if nG else None
        full_prec = (nG / len(pool)) if pool else None
        full_tok = est_tokens(len(inst['description'])) + sum(est_tokens(memdump[mid]['len']) for mid in pool)
        thin_tok = est_tokens(len(inst['description']))
        rows.append(dict(task_id=inst['task_id'], to_agent=inst['to_agent'], nG=nG,
                         pool=len(pool), recall_n=len(recall_order),
                         thin_cov=thin_cov, cur_cov=cur_cov, full_cov=full_cov,
                         cur_prec=cur_prec, full_prec=full_prec,
                         thin_tok=thin_tok, cur_tok=cur_tok, full_tok=full_tok))
    return rows

def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None

def median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs: return None
    n = len(xs); m = n // 2
    return xs[m] if n % 2 else (xs[m-1] + xs[m]) / 2

results = {'meta': {}, 'sensitivity_tau': {}, 'primary': {}}
results['meta'] = dict(
    n_instances=len(sample), n_docs=N_DOCS, high_idf_df_threshold=HIGH_IDF_DF,
    curated_Ns=CURATED_NS, taus=TAUS, tau_primary=TAU_PRIMARY,
    token_heuristic='ceil(chars/4)',
    notes='G grounded vs RESULT; recall selects vs DESCRIPTION (independent signals). '
          'coverage=fraction of needed facts delivered; precision=fraction of surfaced '
          'memories that are needed; tokens=est brief size.')

for tau in TAUS:
    rows = analyze(tau)
    informative = [r for r in rows if r['nG'] > 0]
    agg = dict(
        n_informative=len(informative),
        n_zeroG=len(rows) - len(informative),
        mean_nG=mean([r['nG'] for r in informative]),
        thin_cov_mean=mean([r['thin_cov'] for r in informative]),
        full_cov_mean=mean([r['full_cov'] for r in informative]),
        cur_cov_mean={n: mean([r['cur_cov'][n] for r in informative]) for n in CURATED_NS},
        cur_prec_mean={n: mean([r['cur_prec'][n] for r in informative]) for n in CURATED_NS},
        full_prec_mean=mean([r['full_prec'] for r in informative]),
        thin_tok_mean=mean([r['thin_tok'] for r in informative]),
        cur_tok_mean={n: mean([r['cur_tok'][n] for r in informative]) for n in CURATED_NS},
        full_tok_mean=mean([r['full_tok'] for r in informative]),
        full_tok_median=median([r['full_tok'] for r in informative]),
    )
    results['sensitivity_tau'][f'tau={tau}'] = agg
    if tau == TAU_PRIMARY:
        results['primary'] = agg
        # facts-delivered-per-1k-tokens (signal efficiency)
        eff = {}
        for n in CURATED_NS:
            eff[n] = mean([(r['cur_cov'][n] * r['nG']) / (r['cur_tok'][n] / 1000.0)
                           for r in informative if r['cur_tok'][n] > 0])
        eff_thin = mean([(r['thin_cov'] * r['nG']) / (r['thin_tok'] / 1000.0)
                         for r in informative if r['thin_tok'] > 0])
        eff_full = mean([(1.0 * r['nG']) / (r['full_tok'] / 1000.0)
                         for r in informative if r['full_tok'] > 0])
        results['primary']['facts_per_1k_tokens'] = dict(thin=eff_thin, curated=eff, full=eff_full)
        # per-instance dump at primary tau
        json.dump(rows, open(OUT_PER, 'w'), indent=2)

json.dump(results, open(OUT_RESULTS, 'w'), indent=2)

# ---- console summary ----
p = results['primary']
print(f"=== P3 measure-first (tau={TAU_PRIMARY}) — {p['n_informative']} informative instances "
      f"({p['n_zeroG']} with |G|=0), mean |G|={p['mean_nG']:.2f} ===")
print(f"COVERAGE (needed-fact recall):  THIN={p['thin_cov_mean']:.3f}  "
      f"CURATED@5={p['cur_cov_mean'][5]:.3f}  CURATED@12={p['cur_cov_mean'][12]:.3f}  FULL=1.000")
print(f"  curated@N coverage: " + "  ".join(f"@{n}={p['cur_cov_mean'][n]:.3f}" for n in CURATED_NS))
print(f"PRECISION (signal/noise):  CURATED@5={p['cur_prec_mean'][5]:.3f}  "
      f"CURATED@12={p['cur_prec_mean'][12]:.3f}  FULL={p['full_prec_mean']:.3f}")
print(f"TOKENS (brief size):  THIN={p['thin_tok_mean']:.0f}  CURATED@5={p['cur_tok_mean'][5]:.0f}  "
      f"CURATED@12={p['cur_tok_mean'][12]:.0f}  FULL(mean)={p['full_tok_mean']:.0f}  FULL(median)={p['full_tok_median']:.0f}")
fk = p['facts_per_1k_tokens']
print(f"FACTS / 1k TOKENS:  THIN={fk['thin']:.2f}  CURATED@5={fk['curated'][5]:.2f}  FULL={fk['full']:.4f}")
print(f"DELTAS @tau={TAU_PRIMARY}:  curated@5 - thin = {p['cur_cov_mean'][5]-p['thin_cov_mean']:+.3f} coverage; "
      f"full - curated@5 = {1.0-p['cur_cov_mean'][5]:+.3f} coverage at "
      f"{p['full_tok_mean']/max(1,p['cur_tok_mean'][5]):.0f}x the tokens")
print("\n=== tau sensitivity (coverage thin / curated@5 / curated@12) ===")
for tau in TAUS:
    a = results['sensitivity_tau'][f'tau={tau}']
    print(f"  tau={tau}: thin={a['thin_cov_mean']:.3f}  cur@5={a['cur_cov_mean'][5]:.3f}  "
          f"cur@12={a['cur_cov_mean'][12]:.3f}  (n_inf={a['n_informative']}, meanG={a['mean_nG']:.2f})")
