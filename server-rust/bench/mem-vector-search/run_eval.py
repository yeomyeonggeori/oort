#!/usr/bin/env python3
"""MEM-M3 (#3173) 평가 러너. 격리 PG(pgvector/pgvector:pg18, 컨테이너 3173-pg)에서
  1) 키워드 현행(mem_search_items_core 의 낱말·조사·word_similarity 로직 이식)  2) M0 bigram(후보 1)
  3) 벡터(모델별 정확 코사인, numpy)  4) RRF(k=60) 융합  의 recall@10/MRR 을 질의 종류별로 재고,
  pgvector HNSW 크기·질의 지연(1k/10k/50k)과 필터 질의 재현율을 잰다. 끝나면 `docker rm -f -v`.

입력(스크래치, 레포 밖): --docs docs_all.jsonl(M0 코퍼스 900 + 잡음), --emb <dir>/<model>.{docs,queries}.f32
사용: ~/.cache/momo-scratch/3173/venv/bin/python run_eval.py --docs ... --emb ... --models e5-small,minilm > results.json
"""
import argparse, collections, json, os, re, statistics, subprocess, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
M0 = os.path.join(HERE, "..", "kr-keyword-search", "fixtures")
NAME = "3173-pg"
IMAGE = "pgvector/pgvector:pg18"
POOLS = [900, 10900, 50900]          # 질의 대상 크기: 900=M0 코퍼스만, 10.9k/50.9k=잡음 추가
RRF_K = 60

def sh(cmd):
    return subprocess.run(cmd, check=True, text=True, capture_output=True).stdout

def psql(sql, tsv=False):
    args = ["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    if tsv: args += ["-At", "-F", "\t"]
    r = subprocess.run(args, input=sql, text=True, capture_output=True)
    if r.returncode: sys.exit(f"psql failed: {r.stderr}\n{sql[:400]}")
    return r.stdout

def q1(s): return "'" + s.replace("'", "''") + "'"

# ---- M0 bigram (kr-keyword-search/src/main.rs `bigram(join_spaces=false)` 의 Python 이식) -----------
def is_hangul(c): return "가" <= c <= "힣"
def bigram(text):
    out = []
    for word in text.split():
        cs, i = list(word), 0
        while i < len(cs):
            if is_hangul(cs[i]):
                j = i
                while j < len(cs) and is_hangul(cs[j]): j += 1
                run = cs[i:j]
                if len(run) == 1: out.append(run[0])
                else:
                    if len(run) > 2: out.append("".join(run))
                    out += ["".join(run[k:k + 2]) for k in range(len(run) - 1)]
                i = j
            elif cs[i].isalnum():
                j = i
                while j < len(cs) and cs[j].isalnum() and not is_hangul(cs[j]): j += 1
                out.append("".join(cs[i:j]).lower()); i = j
            else: i += 1
    return out

# ---- 현행 키워드: server/Migrations/104_mem_item.sql mem_search_items_core 의 후보·점수 로직 이식 ------
KW_FN = r"""
create or replace function kw_cur(p_query text, p_pool int, p_lim int) returns setof text
language plpgsql stable set pg_trgm.word_similarity_threshold = '0.5' as $$
declare v_raw text[]; v_stem text[]; v_all text[];
begin
  select array_agg(t.raw order by t.ord), array_agg(t.stem order by t.ord) into v_raw, v_stem
  from (select w.raw, w.ord,
          case when char_length(w.raw) >= 3 then regexp_replace(w.raw,
            '(에서|에게|으로|이랑|까지|부터|처럼|보다|이나|에는|은|는|이|가|을|를|의|도|만|와|과|로|에)$', '')
          else w.raw end as stem
        from (select distinct on (s.w) s.w as raw, s.ord
                from regexp_split_to_table(lower(left(coalesce(p_query,''),200)),
                     '[[:space:],.;:!?()"''`\[\]{}<>]+') with ordinality as s(w, ord)
               where char_length(s.w) >= 2 order by s.w, s.ord) w
        order by w.ord limit 8) t;
  if v_raw is null then return; end if;
  select array_agg(case when char_length(x.st) >= 2 then x.st else x.rw end order by x.n) into v_stem
    from unnest(v_raw, v_stem) with ordinality as x(rw, st, n);
  select array_agg(distinct z.w) into v_all from (select unnest(v_raw) as w union select unnest(v_stem)) z;
  return query
    select i.id from items i
    cross join lateral (select sum(greatest(word_similarity(t.rw, i.body), word_similarity(t.st, i.body))) as s
                          from unnest(v_raw, v_stem) as t(rw, st)) sc
    where i.seq < p_pool and exists (select 1 from unnest(v_all) w where w <% i.body)
    order by sc.s desc, i.id limit p_lim;
end $$;
"""

def rrf(lists, k=RRF_K, n=10, w=None):
    sc = collections.defaultdict(float)
    for li, l in enumerate(lists):
        for r, d in enumerate(l, 1): sc[d] += (w[li] if w else 1.0) / (k + r)
    return [d for d, _ in sorted(sc.items(), key=lambda x: (-x[1], x[0]))[:n]]

TEXT = {}   # doc id -> text (word_hit 용)

def word_hit(top, q):
    """상위 10 중 개념 낱말 A 또는 B(원래 표기)를 담은 문서 비율. 짝 전체를 못 맞춰도 「의미상 가까운 문서」를 가져왔는지 본다.
    결손 질의(orig 있음)에만 정의된다."""
    return sum(1 for d in top if any(w in TEXT[d] for w in q["orig"])) / 10.0

def metrics(res, queries):
    rec, rr, per, perrr = [], [], collections.defaultdict(list), collections.defaultdict(list)
    wh = collections.defaultdict(list)
    for q in queries:
        if "orig" in q: wh[q["kind"]].append(word_hit(res.get(q["id"], [])[:10], q))
        rel = set(q["relevant"]); top = res.get(q["id"], [])[:10]
        r = len(rel & set(top)) / min(10, len(rel))
        first = next((i for i, d in enumerate(top, 1) if d in rel), None)
        m = 1 / first if first else 0.0
        rec.append(r); rr.append(m); per[q["kind"]].append(r); perrr[q["kind"]].append(m)
    f = lambda v: round(sum(v) / len(v), 3)
    return {"recall@10": f(rec), "mrr": f(rr),
            "by_kind": {k: {"recall@10": f(v), "mrr": f(perrr[k]), **({"word_hit@10": f(wh[k])} if k in wh else {})} for k, v in per.items()}}

def read_f32(path, dim):
    a = np.fromfile(path, dtype="<f4").reshape(-1, dim)
    return a / np.linalg.norm(a, axis=1, keepdims=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", required=True); ap.add_argument("--emb", required=True)
    ap.add_argument("--models", default="e5-small,minilm"); ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--probe-emb", default=None, help="probe 임베딩 디렉터리(<model>.docs.f32/.queries.f32)")
    ap.add_argument("--keep", action="store_true"); ap.add_argument("--skip-ann", action="store_true")
    a = ap.parse_args()
    docs = [json.loads(l) for l in open(a.docs, encoding="utf-8")]
    q0 = json.load(open(f"{M0}/queries.json", encoding="utf-8"))
    q1_ = json.load(open(f"{HERE}/fixtures/queries_deficit.json", encoding="utf-8"))
    queries = q0 + q1_
    ids = [d["id"] for d in docs]
    TEXT.update({d["id"]: d["text"] for d in docs})
    # 측정기 점검(실패할 수 있는 가드): 오라클 1.0, 빈 결과 0.0, 정답 id 는 코퍼스에 존재
    assert metrics({q["id"]: q["relevant"][:10] for q in queries}, queries)["recall@10"] == 1.0
    assert metrics({}, queries)["recall@10"] == 0.0
    assert all(r in set(ids[:900]) for q in queries for r in q["relevant"]) and len(queries) == 96
    kinds_order = ["josa", "two_syllable", "spacing", "english", "typo", "synonym", "translit", "abbrev", "question"]

    subprocess.run(["docker", "rm", "-f", "-v", NAME], capture_output=True)
    sh(["docker", "run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=x", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "--shm-size=2g",
        IMAGE, "-c", "fsync=off", "-c", "max_wal_size=4GB", "-c", "shared_buffers=1GB", "-c", "maintenance_work_mem=1GB"])
    out = {"queries": {k: sum(1 for q in queries if q["kind"] == k) for k in kinds_order}, "pools": POOLS}
    try:
        for _ in range(60):
            if subprocess.run(["docker", "exec", NAME, "pg_isready", "-U", "postgres"], capture_output=True).returncode == 0:
                time.sleep(1); break
            time.sleep(1)
        psql("create extension pg_trgm; create extension vector;")
        out["pg"] = psql("select version()", tsv=True).strip()
        out["pgvector"] = psql("select extversion from pg_extension where extname='vector'", tsv=True).strip()
        psql("create table items(seq int primary key, id text unique not null, body text not null, ws int not null);"
             "create table bg(seq int primary key, tsv text not null);")
        def copy(table, rows):
            body = "".join("\t".join(str(c).replace("\t", " ").replace("\\", " ") for c in r) + "\n" for r in rows)
            psql(f"copy {table} from stdin;\n{body}\\.\n")
        copy("items", [(i, d["id"], d["text"], i % 50) for i, d in enumerate(docs)])
        psql("create index items_trgm on items using gin (body gin_trgm_ops);")
        copy("bg", [(i, " ".join(bigram(d["text"]))) for i, d in enumerate(docs)])
        # bg.tsv 는 공백 구분 토큰 문자열로 적재했으므로 tsvector 로 변환한다
        psql("create table bg2 as select seq, to_tsvector('simple', tsv::text) as tsv from bg; create index bg2_gin on bg2 using gin(tsv); analyze bg2;")
        psql(KW_FN); psql("analyze items")

        # --- 키워드 결과(상위 50 후보, 융합용) ---
        kw = {}
        for pool in POOLS:
            cur, bgm = {}, {}
            t0 = time.time()
            sql = "\n".join(f"select {q1(q['id'])}, kw_cur({q1(q['text'])}, {pool}, 50);" for q in queries)
            for line in psql(sql, tsv=True).splitlines():
                qid, d = line.split("\t"); cur.setdefault(qid, []).append(d)
            sql = []
            for q in queries:
                toks = sorted(set(bigram(q["text"])))
                tq = " | ".join("'" + t.replace("'", "''") + "'" for t in toks)
                sql.append(f"select {q1(q['id'])}, i.id from bg2 b join items i using(seq), to_tsquery('simple', {q1(tq)}) qq "
                           f"where b.seq < {pool} and b.tsv @@ qq order by ts_rank_cd(b.tsv, qq) desc, i.id limit 50;")
            for line in psql("\n".join(sql), tsv=True).splitlines():
                qid, d = line.split("\t"); bgm.setdefault(qid, []).append(d)
            kw[pool] = {"kw_current": cur, "kw_bigram": bgm}
        # --- 키워드 지연(현행 함수, 워크스페이스 필터 없음) ---
        out["kw_current_latency_ms"] = {}
        for pool in POOLS:
            body = "\\timing on\n" + "\n".join(f"select count(*) from kw_cur({q1(q['text'])}, {pool}, 10);" for q in queries for _ in range(a.reps))
            r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-At"], input=body, text=True, capture_output=True)
            ts = sorted(float(x) for x in re.findall(r"Time: ([\d.]+) ms", r.stdout))
            out["kw_current_latency_ms"][pool] = {"p50": round(statistics.median(ts), 2), "p95": round(ts[int(len(ts) * .95) - 1], 2), "n": len(ts)}

        # --- 손글씨 점검(probe): 12 항목 × 바꿔 말한 질의 12. 지표가 아니라 합성 코퍼스 한계를 가늠하는 용도 ---
        probe = json.load(open(f"{HERE}/fixtures/probe.json", encoding="utf-8"))
        pitems, pqs = probe["items"], probe["queries"]
        copy("items", [(1000000 + i, it["id"], it["text"], 0) for i, it in enumerate(pitems)])
        pkw = {}
        for q in pqs:
            rows = psql(f"select kw_cur({q1(q['text'])}, 2000000, 50);", tsv=True).split()
            pkw[q["id"]] = [r for r in rows if r.startswith("p") and not r.startswith("d")]
        def prank(lst, target):
            return lst.index(target) + 1 if target in lst else None
        def pstats(rank_by_q):
            rs = [rank_by_q[q["id"]] for q in pqs]
            return {"top1": sum(1 for r in rs if r == 1), "top3": sum(1 for r in rs if r and r <= 3),
                    "found": sum(1 for r in rs if r), "mrr": round(sum(1 / r for r in rs if r) / len(rs), 3), "ranks": rs}
        out["probe"] = {"kw_current": pstats({q["id"]: prank(pkw[q["id"]], q["target"]) for q in pqs})}

        out["quality"] = {}
        for pool in POOLS:
            out["quality"][pool] = {name: metrics({k: v[:10] for k, v in res.items()}, queries) for name, res in kw[pool].items()}
        # --- 벡터 ---
        out["models"] = {}
        for m in a.models.split(","):
            meta = json.load(open(f"{a.emb}/{m}.meta.json"))
            dim = meta["dim"]
            D = read_f32(f"{a.emb}/{m}.docs.f32", dim); Q = read_f32(f"{a.emb}/{m}.queries.f32", dim)
            assert D.shape[0] == len(docs) and Q.shape[0] == len(queries), (D.shape, Q.shape)
            mo = {"meta": meta, "quality": {}}
            for pool in POOLS:
                S = Q @ D[:pool].T
                top = np.argsort(-S, axis=1)[:, :50]
                vec = {q["id"]: [ids[j] for j in top[i]] for i, q in enumerate(queries)}
                res = {"vector": {k: v[:10] for k, v in vec.items()}}
                for kname in ("kw_current", "kw_bigram"):
                    res[f"rrf(vector+{kname})"] = {q["id"]: rrf([vec[q["id"]], kw[pool][kname].get(q["id"], [])]) for q in queries}
                res["rrf_w(vector*1+kw_current*2)"] = {q["id"]: rrf([vec[q["id"]], kw[pool]["kw_current"].get(q["id"], [])], w=[1, 2]) for q in queries}
                res["rrf(vector+kw_current+kw_bigram)"] = {q["id"]: rrf([vec[q["id"]], kw[pool]["kw_current"].get(q["id"], []), kw[pool]["kw_bigram"].get(q["id"], [])]) for q in queries}
                mo["quality"][pool] = {n: metrics(r, queries) for n, r in res.items()}
            out["models"][m] = mo
            if a.probe_emb:
                PD = read_f32(f"{a.probe_emb}/{m}.docs.f32", dim); PQ = read_f32(f"{a.probe_emb}/{m}.queries.f32", dim)
                pids = [it["id"] for it in pitems]
                pvec = {q["id"]: [pids[j] for j in np.argsort(-(PQ[i] @ PD.T))] for i, q in enumerate(pqs)}
                mo["probe"] = {"vector": pstats({q["id"]: prank(pvec[q["id"]], q["target"]) for q in pqs}),
                               "rrf(vector+kw_current)": pstats({q["id"]: prank(rrf([pvec[q["id"]], pkw[q["id"]]], n=12), q["target"]) for q in pqs})}
            print(f"[quality] {m}: vec small={mo['quality'][900]['vector']['recall@10']}", file=sys.stderr)
            if a.skip_ann: continue
            # --- pgvector HNSW: 크기·지연·ANN 재현율 (1k/10k/50k) ---
            mo["hnsw"] = {}
            for n in (1000, 10000, 50000):
                psql(f"drop table if exists v; create table v(seq int primary key, ws int not null, e vector({dim}));")
                copy("v", [(i, i % 50, "[" + ",".join(f"{x:.6f}" for x in D[i]) + "]") for i in range(n)])
                t0 = time.time()
                psql("create index v_hnsw on v using hnsw (e vector_cosine_ops) with (m=16, ef_construction=64);")
                build_s = time.time() - t0
                psql("analyze v")
                sz = psql("select pg_relation_size('v_hnsw'), pg_table_size('v')", tsv=True).strip().split("\t")
                qlits = ["[" + ",".join(f"{x:.6f}" for x in Q[i]) + "]" for i in range(len(queries))]
                # 지연: 인덱스 사용 top-10, ef_search=40(기본)
                body = "\\timing on\nset hnsw.ef_search=40;\n" + "\n".join(
                    f"select seq from v order by e <=> '{ql}' limit 10;" for ql in qlits for _ in range(a.reps))
                r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-At"], input=body, text=True, capture_output=True)
                ts = sorted(float(x) for x in re.findall(r"Time: ([\d.]+) ms", r.stdout))
                # ANN 재현율: 인덱스 결과 vs 정확 top-10
                got = psql("set hnsw.ef_search=40;\n" + "\n".join(
                    f"select {i}, seq from v order by e <=> '{ql}' limit 10;" for i, ql in enumerate(qlits)), tsv=True)
                ann = collections.defaultdict(set)
                for line in got.splitlines():
                    if "\t" in line:
                        i, s = line.split("\t"); ann[int(i)].add(int(s))
                exact = np.argsort(-(Q @ D[:n].T), axis=1)[:, :10]
                ann_rec = float(np.mean([len(ann[i] & set(exact[i].tolist())) / 10 for i in range(len(queries))]))
                # 필터(ws = 1/50, 워크스페이스 분할 모사) 재현율: 기본 vs 반복 스캔
                filt = {}
                for label, pre in (("plain", ""), ("iterative_relaxed", "set hnsw.iterative_scan=relaxed_order;")):
                    got = psql("set hnsw.ef_search=40;" + pre + "\n" + "\n".join(
                        f"select {i}, seq from v where ws = {i % 50} order by e <=> '{ql}' limit 10;" for i, ql in enumerate(qlits[:50])), tsv=True)
                    g = collections.defaultdict(set)
                    for line in got.splitlines():
                        if "\t" in line:
                            i, s = line.split("\t"); g[int(i)].add(int(s))
                    rec = []
                    for i in range(50):
                        mask = np.array([(j % 50) == (i % 50) for j in range(n)])
                        sc = np.where(mask, Q[i] @ D[:n].T, -9)
                        ex = set(np.argsort(-sc)[:10].tolist()); ex = {j for j in ex if mask[j]}
                        rec.append(len(g[i] & ex) / max(1, len(ex)))
                    plan = psql("set hnsw.ef_search=40;" + pre + f"\nexplain select seq from v where ws = 7 order by e <=> '{qlits[7]}' limit 10;", tsv=True)
                    body = "\\timing on\nset hnsw.ef_search=40;" + pre + "\n" + "\n".join(
                        f"select seq from v where ws = {i % 50} order by e <=> '{ql}' limit 10;" for i, ql in enumerate(qlits[:50]) for _ in range(a.reps))
                    r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-At"], input=body, text=True, capture_output=True)
                    fts = sorted(float(x) for x in re.findall(r"Time: ([\d.]+) ms", r.stdout))
                    filt[label] = {"recall": round(float(np.mean(rec)), 3), "mean_rows_returned": round(float(np.mean([len(g[i]) for i in range(50)])), 2),
                                   "uses_hnsw_index": "v_hnsw" in plan, "latency_ms_p50": round(statistics.median(fts), 2), "latency_ms_p95": round(fts[int(len(fts) * .95) - 1], 2)}
                mo["hnsw"][n] = {"build_s": round(build_s, 1), "index_bytes": int(sz[0]), "heap_bytes": int(sz[1]),
                                 "latency_ms": {"p50": round(statistics.median(ts), 2), "p95": round(ts[int(len(ts) * .95) - 1], 2), "n": len(ts)},
                                 "ann_recall@10": round(ann_rec, 3), "filtered_ws_1_of_50": filt}
                print(f"[hnsw] {m} n={n} {mo['hnsw'][n]}", file=sys.stderr)
        print(json.dumps(out, ensure_ascii=False, indent=1))
    finally:
        if not a.keep:
            subprocess.run(["docker", "rm", "-f", "-v", NAME], capture_output=True)

if __name__ == "__main__":
    main()
