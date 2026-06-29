#!/usr/bin/env python3
"""
P3 measure-first — INDEPENDENT verifier (#10060825). DETERMINISTIC.

Re-derives the headline coverage/precision verdict with a STRUCTURALLY DIFFERENT
ground-truth operationalization than score_p3.py:
  - score_p3.py: G = salience-weighted (IDF) grounding RATIO vs result >= tau.
  - verify_p3.py: G' = COUNT of >=2 shared DISTINCTIVE (df<=5%) tokens vs result.
    No IDF ratio, no tau threshold, no normalization-by-memory-salience.

If curated >> thin survives this different metric, the verdict is robust to the
grounding operationalization, not an artifact of one formula. Recomputes from the
SAME raw sample/memdump (the recall ids are the shipped-path output, not re-derived).

Usage: python3 verify_p3.py <sample.json> <memdump.json>
"""
import sys, json, re
from collections import defaultdict

SAMPLE, MEMDUMP = sys.argv[1:3]
_TOK = re.compile(r'[a-z0-9_]+')
STOP = set("""a an the and or but if then else of to in on at by for with from into over under
as is are was were be been being do does did doing have has had having i you he she it we they
this that these those there here it's its their his her your our my me him them us not no nor so
than too very can will just don't should now what which who whom when where why how all any both
each few more most other some such only own same s t up out off down about above below again""".split())
def tokset(t): return {w for w in _TOK.findall((t or '').lower()) if w not in STOP and len(w) > 1}

sample = json.load(open(SAMPLE))
memdump = {int(k): v for k, v in json.load(open(MEMDUMP)).items()}
N = len(memdump)
df = defaultdict(int); mts = {}
for mid, m in memdump.items():
    ts = tokset(m['content']); mts[mid] = ts
    for t in ts: df[t] += 1
DISTINCT_DF = max(1, int(0.05 * N))
def distinct(ts): return {t for t in ts if df.get(t, N) <= DISTINCT_DF}

MIN_SHARED = 2  # >=2 shared distinctive terms = "grounded"
NS = [3, 5, 8, 12]
def shared_distinct(a_ts, b_ts): return len(distinct(a_ts) & distinct(b_ts))

rows = []
for inst in sample:
    desc = tokset(inst['description']); res = tokset(inst['result'])
    pool = [m for m in inst['pit_pool_ids'] if m in memdump]
    rec = [m for m in inst['recall_order'] if m in memdump]
    G = {m for m in pool if shared_distinct(mts[m], res) >= MIN_SHARED}
    nG = len(G)
    if nG == 0:
        rows.append(dict(nG=0)); continue
    thin = sum(1 for g in G if shared_distinct(mts[g], desc) >= MIN_SHARED) / nG
    cur = {}; prec = {}
    for n in NS:
        topN = rec[:n]
        cur[n] = sum(1 for g in G if (g in set(topN)) or shared_distinct(mts[g], desc) >= MIN_SHARED) / nG
        prec[n] = (len(set(topN) & G) / len(topN)) if topN else None
    full_prec = nG / len(pool) if pool else None
    rows.append(dict(nG=nG, thin=thin, cur=cur, prec=prec, full_prec=full_prec))

inf = [r for r in rows if r['nG'] > 0]
def mn(xs): xs=[x for x in xs if x is not None]; return sum(xs)/len(xs) if xs else None
print(f"INDEPENDENT VERIFY (distinct-token-count metric, MIN_SHARED={MIN_SHARED}, distinct_df<={DISTINCT_DF})")
print(f"  informative={len(inf)} (|G'|=0: {len(rows)-len(inf)}), mean|G'|={mn([r['nG'] for r in inf]):.2f}")
print(f"  COVERAGE  thin={mn([r['thin'] for r in inf]):.3f}  " + "  ".join(f"cur@{n}={mn([r['cur'][n] for r in inf]):.3f}" for n in NS) + "  full=1.000")
print(f"  PRECISION " + "  ".join(f"cur@{n}={mn([r['prec'][n] for r in inf]):.3f}" for n in NS) + f"  full={mn([r['full_prec'] for r in inf]):.3f}")
print(f"  DELTA curated@5 - thin = {mn([r['cur'][5] for r in inf]) - mn([r['thin'] for r in inf]):+.3f} coverage")
