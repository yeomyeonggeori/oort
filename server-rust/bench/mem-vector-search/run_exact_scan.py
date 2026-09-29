#!/usr/bin/env python3
"""MEM-M3 (#3173) 보조 측정: HNSW 없이 「워크스페이스로 좁힌 행만 정확 코사인 스캔」의 지연.
mem_search_items_core 는 이미 워크스페이스·멤버십으로 후보를 좁힌 뒤 계산하므로, 좁혀진 집합이 작으면 ANN 색인이 필요 없을 수 있다.
사용: python run_exact_scan.py --docs-f32 <emb50k/e5-small.docs.f32> --queries-f32 <...queries.f32> --dim 384 > exact_scan.json
"""
import argparse, json, re, statistics, subprocess, sys, time
import numpy as np
NAME = "3173-pg"

def psql(sql, tsv=True):
    r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], input=sql, text=True, capture_output=True)
    if r.returncode: sys.exit(r.stderr)
    return r.stdout

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs-f32", required=True); ap.add_argument("--queries-f32", required=True)
    ap.add_argument("--dim", type=int, required=True); ap.add_argument("--reps", type=int, default=3)
    a = ap.parse_args()
    D = np.fromfile(a.docs_f32, dtype="<f4").reshape(-1, a.dim); D /= np.linalg.norm(D, axis=1, keepdims=True)
    Q = np.fromfile(a.queries_f32, dtype="<f4").reshape(-1, a.dim); Q /= np.linalg.norm(Q, axis=1, keepdims=True)
    subprocess.run(["docker", "rm", "-f", "-v", NAME], capture_output=True)
    subprocess.run(["docker", "run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=x", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                    "--shm-size=2g", "pgvector/pgvector:pg18", "-c", "fsync=off", "-c", "shared_buffers=1GB"], check=True, capture_output=True)
    out = {"dim": a.dim, "rows": len(D)}
    try:
        for _ in range(60):
            if subprocess.run(["docker", "exec", NAME, "pg_isready", "-U", "postgres"], capture_output=True).returncode == 0:
                time.sleep(1); break
            time.sleep(1)
        psql("create extension vector; create table v(seq int primary key, ws1 int not null, ws10 int not null, e vector(%d));" % a.dim)
        body = "".join(f"{i}\t{i % 50}\t{i % 10}\t[" + ",".join(f"{x:.6f}" for x in D[i]) + "]\n" for i in range(len(D)))
        psql(f"copy v from stdin;\n{body}\\.\n")
        psql("create index v_ws1 on v(ws1); create index v_ws10 on v(ws10); vacuum analyze v;")
        ql = ["[" + ",".join(f"{x:.6f}" for x in Q[i]) + "]" for i in range(50)]
        for label, col, per in (("1000_rows_per_workspace", "ws1", 1000), ("5000_rows_per_workspace", "ws10", 5000)):
            lat = []
            plan = psql(f"explain select seq from v where {col} = 3 order by e <=> '{ql[0]}' limit 10;")
            script = "\\timing on\n" + "\n".join(f"select seq from v where {col} = {i % (50 if col == 'ws1' else 10)} order by e <=> '{q}' limit 10;" for i, q in enumerate(ql) for _ in range(a.reps))
            r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-q", "-At"], input=script, text=True, capture_output=True)
            ts = sorted(float(x) for x in re.findall(r"Time: ([\d.]+) ms", r.stdout))
            out[label] = {"p50_ms": round(statistics.median(ts), 2), "p95_ms": round(ts[int(len(ts) * .95) - 1], 2),
                          "plan": [re.sub(r"\[[-0-9.e, ]+\]'::vector", "<q>", l.strip())[:90] for l in plan.splitlines()][:4], "exact": True}
        print(json.dumps(out, ensure_ascii=False, indent=1))
    finally:
        subprocess.run(["docker", "rm", "-f", "-v", NAME], capture_output=True)

if __name__ == "__main__":
    main()
