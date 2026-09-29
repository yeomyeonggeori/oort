#!/usr/bin/env python3
"""results.json → 문서용 마크다운 표. 사용: python report.py results.json"""
import json, sys
d = json.load(open(sys.argv[1]))
M0K = ["josa", "two_syllable", "spacing", "english", "typo"]
DEFK = ["synonym", "translit", "abbrev", "question"]
cnt = d["queries"]
def agg(m, kinds, key="recall@10"):
    n = sum(cnt[k] for k in kinds)
    return sum(m["by_kind"][k][key] * cnt[k] for k in kinds) / n
def line(name, m):
    cells = [f"{m['by_kind'][k]['recall@10']:.2f}" for k in M0K + DEFK]
    return f"| {name} | {m['recall@10']:.3f} / {m['mrr']:.3f} | {agg(m, M0K):.2f} | {agg(m, DEFK):.2f} | " + " | ".join(cells) + " |"
hdr = "| 후보 | 전체(96) recall@10 / MRR | M0 5종(50) | 결손 4종(46) | " + " | ".join(M0K + DEFK) + " |\n|" + "---|" * (4 + len(M0K + DEFK))
for pool in d["quality"]:
    print(f"\n### pool={pool}\n\n{hdr}")
    for n, m in d["quality"][pool].items(): print(line(n, m))
    for mod, mo in d["models"].items():
        for n, m in mo["quality"][pool].items(): print(line(f"{mod} {n}", m))
print("\n### word_hit@10 (결손 4종, 상위 10 중 개념 낱말 A 또는 B를 담은 비율)\n")
for pool in d["quality"]:
    print(f"pool={pool}")
    for mod, mo in d["models"].items():
        m = mo["quality"][pool]["vector"]
        print(f"- {mod} vector: " + ", ".join(f"{k} {m['by_kind'][k]['word_hit@10']:.2f}" for k in DEFK))
    for n in ("kw_current", "kw_bigram"):
        m = d["quality"][pool][n]
        print(f"- {n}: " + ", ".join(f"{k} {m['by_kind'][k]['word_hit@10']:.2f}" for k in DEFK))
