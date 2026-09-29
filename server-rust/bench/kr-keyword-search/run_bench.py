#!/usr/bin/env python3
"""MEM-M0 (#3159) 한국어 키워드 검색 스파이크 벤치. 격리 PG(pgvector/pgvector:pg18) 컨테이너를 띄워 후보별
recall@10·MRR·인덱스 크기·쓰기 비용·질의 지연을 잰다. 끝나면 컨테이너를 `docker rm -f -v`로 지운다.

  cargo build --release   (이 디렉터리)
  python3 gen_corpus.py --scale 100000
  python3 run_bench.py [--scale 100000] [--keep] > results.json
"""
import argparse, json, math, os, re, statistics, subprocess, sys, time, tempfile, collections

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "target/release/kr-keyword-search-bench")
NAME = "3159-krsearch-pg"
IMAGE = "pgvector/pgvector:pg18"

def sh(cmd, **kw):
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw).stdout

def psql(sql, tsv=False, timing=False):
    args = ["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    if tsv: args += ["-At", "-F", "\t"]
    r = subprocess.run(args, input=sql, text=True, capture_output=True)
    if r.returncode: sys.exit(f"psql failed: {r.stderr}\n{sql[:500]}")
    return r.stdout

def tokenize(mode, jsonl_path):
    r = subprocess.run([BIN, mode], stdin=open(jsonl_path, encoding="utf-8"), capture_output=True, text=True, check=True)
    m = re.search(r"tokenize_us_per_doc=([\d.]+)", r.stderr)
    return {j["id"]: j["tokens"] for j in map(json.loads, r.stdout.splitlines())}, float(m.group(1))

def q1(s):  # SQL 문자열 리터럴
    return "'" + s.replace("'", "''") + "'"

class BM25:
    """앱측 BM25 참고 구현(역색인). DB 순위 함수(ts_rank_cd)와 토큰화의 기여를 분리해 보기 위한 참고치."""
    def __init__(self, doc_tokens, k1=1.2, b=0.75):
        self.k1, self.b, self.N = k1, b, len(doc_tokens)
        self.len = {d: len(t) for d, t in doc_tokens.items()}
        self.avg = sum(self.len.values()) / self.N
        self.post = collections.defaultdict(list)
        for d, t in doc_tokens.items():
            for w, c in collections.Counter(t).items(): self.post[w].append((d, c))
    def top(self, qtoks, n=10):
        sc = collections.defaultdict(float)
        for w in set(qtoks):
            p = self.post.get(w)
            if not p: continue
            idf = math.log(1 + (self.N - len(p) + 0.5) / (len(p) + 0.5))
            for d, c in p:
                sc[d] += idf * c * (self.k1 + 1) / (c + self.k1 * (1 - self.b + self.b * self.len[d] / self.avg))
        return [d for d, _ in sorted(sc.items(), key=lambda x: (-x[1], x[0]))[:n]]

def metrics(results, queries):
    rec, rr, per = [], [], collections.defaultdict(list)
    for q in queries:
        rel = set(q["relevant"]); top = results.get(q["id"], [])[:10]
        r = len(rel & set(top)) / min(10, len(rel))
        first = next((i for i, d in enumerate(top, 1) if d in rel), None)
        rec.append(r); rr.append(1 / first if first else 0.0); per[q["kind"]].append(r)
    return {"recall@10": round(sum(rec) / len(rec), 3), "mrr": round(sum(rr) / len(rr), 3),
            "by_kind": {k: round(sum(v) / len(v), 2) for k, v in per.items()}}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=int, default=100000)
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    fx = os.path.join(HERE, "fixtures")
    queries = json.load(open(f"{fx}/queries.json", encoding="utf-8"))
    corpus = [json.loads(l) for l in open(f"{fx}/corpus.jsonl", encoding="utf-8")]
    scale = [json.loads(l) for l in open(f"{fx}/scale.jsonl", encoding="utf-8")][: a.scale]
    # 측정기 자체 점검(실패할 수 있는 가드): 정답을 그대로 내는 오라클은 1.0, 빈 결과는 0.0이어야 한다.
    assert metrics({q["id"]: q["relevant"][:10] for q in queries}, queries)["recall@10"] == 1.0
    assert metrics({}, queries)["recall@10"] == 0.0
    assert all(1 <= len(q["relevant"]) <= 10 for q in queries) and len(queries) == 50
    tmp = tempfile.mkdtemp(prefix="krbench-")
    all_docs = corpus + scale
    with open(f"{tmp}/docs.jsonl", "w", encoding="utf-8") as f:
        for d in all_docs: f.write(json.dumps({"id": d["id"], "text": d["text"]}, ensure_ascii=False) + "\n")
    with open(f"{tmp}/qs.jsonl", "w", encoding="utf-8") as f:
        for q in queries: f.write(json.dumps({"id": q["id"], "text": q["text"]}, ensure_ascii=False) + "\n")

    modes = ["bigram", "bigram_join", "lindera"]
    dtok, qtok, tokus = {}, {}, {}
    for m in modes:
        dtok[m], tokus[m] = tokenize(m, f"{tmp}/docs.jsonl")
        qtok[m], _ = tokenize(m, f"{tmp}/qs.jsonl")
        print(f"[tokenize] {m}: {tokus[m]} us/doc", file=sys.stderr)

    subprocess.run(["docker", "rm", "-f", "-v", NAME], capture_output=True)
    sh(["docker", "run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=x", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
        IMAGE, "-c", "fsync=off", "-c", "max_wal_size=4GB"])
    try:
        for _ in range(60):
            if subprocess.run(["docker", "exec", NAME, "pg_isready", "-U", "postgres"], capture_output=True).returncode == 0:
                time.sleep(1); break
            time.sleep(1)
        out = {"pg": psql("select version()", tsv=True).strip(), "docs": len(all_docs), "corpus_docs": len(corpus),
               "lc_ctype": psql("select datctype from pg_database where datname='postgres'", tsv=True).strip(), "tokenize_us_per_doc": tokus}
        psql("create extension pg_trgm; create extension vector;")
        out["trgm_sample"] = psql("select show_trgm('회의를')", tsv=True).strip()
        # 스테이징
        psql("create table stg(id text primary key, body text not null);"
             + "".join(f"create table stg_{m}(id text primary key, tokens text not null);" for m in modes))
        def copy(table, rows):
            body = "".join(f"{i}\t{t.replace(chr(9), ' ').replace(chr(92), ' ')}\n" for i, t in rows)
            psql(f"copy {table} from stdin;\n{body}\\.\n")
        copy("stg", [(d["id"], d["text"]) for d in all_docs])
        for m in modes: copy(f"stg_{m}", list(dtok[m].items()))
        # 후보 테이블 (색인을 먼저 만들고 INSERT 시간을 잰다 = 유지 비용 포함)
        cands = {
            "c0_simple_raw": ("tsv", "to_tsvector('simple', s.body)", None),
            "c1_bigram": ("tsv", "to_tsvector('simple', t.tokens)", "bigram"),
            "c1b_bigram_join": ("tsv", "to_tsvector('simple', t.tokens)", "bigram_join"),
            "c2_lindera": ("tsv", "to_tsvector('simple', t.tokens)", "lindera"),
            "c3_trgm": ("trgm", None, None),
        }
        out["cands"] = {}
        for cname, (kind, expr, mode) in cands.items():
            if kind == "tsv":
                psql(f"create table {cname}(id text primary key, tsv tsvector not null); create index {cname}_gin on {cname} using gin(tsv);")
                src = "stg s" + (f" join stg_{mode} t using(id)" if mode else "")
                t0 = time.time()
                psql(f"insert into {cname} select s.id, {expr} from {src};")
            else:
                psql(f"create table {cname}(id text primary key, body text not null); create index {cname}_gin on {cname} using gin(body gin_trgm_ops);")
                t0 = time.time()
                psql(f"insert into {cname} select id, body from stg;")
            wt = time.time() - t0
            psql(f"vacuum analyze {cname}")
            sz = psql(f"select pg_relation_size('{cname}_gin'), pg_table_size('{cname}')", tsv=True).strip().split("\t")
            out["cands"][cname] = {"insert_s": round(wt, 2), "insert_us_per_doc": round(wt * 1e6 / len(all_docs), 1),
                                   "gin_bytes": int(sz[0]), "table_bytes": int(sz[1])}
        # ILIKE 전체 구절 (현행 search.rs 방식) — c3 trgm 테이블의 인덱스를 그대로 씀
        def qsql(cname, q, where_small):
            qid, text = q["id"], q["text"]
            flt = "and id like 'd%'" if where_small else ""
            tt = text.split()
            if cname in ("c0_simple_raw",):
                tq = f"(select string_agg(quote_literal(l), ' | ') from (select lexeme l from unnest(to_tsvector('simple', {q1(text)}))) x)"
            elif cname.startswith("c1") or cname == "c2_lindera":
                m = {"c1_bigram": "bigram", "c1b_bigram_join": "bigram_join", "c2_lindera": "lindera"}[cname]
                toks = sorted(set(qtok[m][qid].split()))
                tq = q1(" | ".join("'" + t.replace("'", "''") + "'" for t in toks)) if toks else "null"
            if cname == "c3_trgm":
                conds = " or ".join(f"{q1(t)} <% body" for t in tt)
                sc = " + ".join(f"word_similarity({q1(t)}, body)" for t in tt)
                return f"select {q1(qid)}, id from c3_trgm where ({conds}) {flt} order by {sc} desc, id limit 10;"
            if cname == "ilike":
                lit = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                return f"select {q1(qid)}, id from c3_trgm where body ilike {q1('%' + lit + '%')} {flt} order by id limit 10;"
            return (f"select {q1(qid)}, id from {cname}, to_tsquery('simple', {tq}) qq where tsv @@ qq {flt} "
                    f"order by ts_rank_cd(tsv, qq) desc, id limit 10;")
        def run(cname, small, thr=None):
            pre = f"set pg_trgm.word_similarity_threshold={thr};\n" if thr else ""
            sql = pre + "\n".join(qsql(cname, q, small) for q in queries)
            res = collections.defaultdict(list)
            for line in psql(sql, tsv=True).splitlines():
                qid, d = line.split("\t"); res[qid].append(d)
            return res
        out["quality_small"], out["quality_scale"] = {}, {}
        variants = [(c, None) for c in cands if c != "c3_trgm"] + [("c3_trgm", 0.3), ("c3_trgm", 0.5), ("ilike", None)]
        def rrf(*lists, k=60):
            sc = collections.defaultdict(float)
            for l in lists:
                for r, d in enumerate(l, 1): sc[d] += 1 / (k + r)
            return [d for d, _ in sorted(sc.items(), key=lambda x: (-x[1], x[0]))[:10]]
        raw = {}
        for c, thr in variants:
            key = c if thr is None else f"{c}@{thr}"
            for scope, small in (("small", True), ("scale", False)):
                raw[(key, scope)] = run(c, small, thr)
                out[f"quality_{scope}"][key] = metrics(raw[(key, scope)], queries)
            print(f"[quality] {key}: small={out['quality_small'][key]['recall@10']} scale={out['quality_scale'][key]['recall@10']}", file=sys.stderr)
        # 융합(계획 §4.4 RRF k=60): 키워드 후보 + pg_trgm 부분일치 보조
        for name, a_key in (("rrf(c2_lindera+c3_trgm@0.3)", "c2_lindera"), ("rrf(c1_bigram+c3_trgm@0.3)", "c1_bigram")):
            for scope in ("small", "scale"):
                res = {q["id"]: rrf(raw[(a_key, scope)][q["id"]], raw[("c3_trgm@0.3", scope)][q["id"]]) for q in queries}
                out[f"quality_{scope}"][name] = metrics(res, queries)
            print(f"[quality] {name}: small={out['quality_small'][name]['recall@10']} scale={out['quality_scale'][name]['recall@10']}", file=sys.stderr)
        # 참고: 같은 토큰에 앱측 BM25(코퍼스 900건) — pg_textsearch 없이도 순위 함수가 바뀌면 어디까지 오르는지
        out["bm25_reference_small"], out["bm25_reference_scale"] = {}, {}
        for m in modes:
            for key, ids in (("bm25_reference_small", {d["id"] for d in corpus}), ("bm25_reference_scale", None)):
                sub = {d: t.split() for d, t in dtok[m].items() if ids is None or d in ids}
                bm = BM25(sub)
                out[key][m] = metrics({q["id"]: bm.top(qtok[m][q["id"]].split()) for q in queries}, queries)
        # 질의 지연 (scale 테이블, psql \timing, 질의당 reps회)
        out["latency_ms"] = {}
        for c, thr in variants:
            if c == "ilike": pass
            key = c if thr is None else f"{c}@{thr}"
            pre = f"set pg_trgm.word_similarity_threshold={thr};\n" if thr else ""
            body = "\\timing on\n" + pre + "\n".join(qsql(c, q, False).replace("select '" + q["id"] + "', id", "select id") for q in queries for _ in range(a.reps))
            r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-At"], input=body, text=True, capture_output=True)
            ts = sorted(float(x) for x in re.findall(r"Time: ([\d.]+) ms", r.stdout))
            if ts:
                out["latency_ms"][key] = {"p50": round(statistics.median(ts), 2), "p95": round(ts[int(len(ts) * 0.95) - 1], 2), "n": len(ts)}
        print(json.dumps(out, ensure_ascii=False, indent=1))
    finally:
        if not a.keep:
            subprocess.run(["docker", "rm", "-f", "-v", NAME], capture_output=True)

if __name__ == "__main__":
    main()
