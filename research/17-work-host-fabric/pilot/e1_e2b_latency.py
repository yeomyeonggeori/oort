#!/usr/bin/env python3
"""E1 지연 프로파일 — E2B (research/17-work-host-fabric/01 §2 E1).

측정: 콜드 create / exec 왕복 / pause→재개(connect) 왕복. p50/p95 JSON 출력.
키는 E2B_API_KEY 환경변수(루트 .env — 값 미출력). 비용 가드: 이터레이션 상한 + 즉시 kill.
"""
import json, os, statistics, sys, time

from e2b import Sandbox

N = int(os.environ.get("E1_ITERS", "10"))
results = {"provider": "e2b", "iters": N, "cold_create_s": [], "exec_roundtrip_s": [],
           "pause_s": [], "resume_s": [], "errors": []}

for i in range(N):
    try:
        t0 = time.monotonic()
        sbx = Sandbox.create(timeout=120)
        results["cold_create_s"].append(time.monotonic() - t0)

        t0 = time.monotonic()
        out = sbx.commands.run("echo momo-e1")
        assert "momo-e1" in (out.stdout or "")
        results["exec_roundtrip_s"].append(time.monotonic() - t0)

        sid = sbx.sandbox_id
        t0 = time.monotonic()
        sbx.pause(keep_memory=True)
        results["pause_s"].append(time.monotonic() - t0)

        t0 = time.monotonic()
        sbx2 = Sandbox.connect(sid)
        out = sbx2.commands.run("echo resumed")
        results["resume_s"].append(time.monotonic() - t0)

        sbx2.kill()
    except Exception as e:  # noqa: BLE001 — 파일럿: 오류 유형 수집이 목적
        results["errors"].append(f"iter{i}: {type(e).__name__}: {e}")
        try:
            sbx.kill()
        except Exception:
            pass
    print(f"[e1-e2b] iter {i+1}/{N} done", file=sys.stderr)

def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 3)

summary = {}
for k in ("cold_create_s", "exec_roundtrip_s", "pause_s", "resume_s"):
    xs = results[k]
    summary[k] = {"n": len(xs), "p50": pct(xs, 0.5), "p95": pct(xs, 0.95),
                  "mean": round(statistics.mean(xs), 3) if xs else None}
results["summary"] = summary
print(json.dumps(results, ensure_ascii=False, indent=2))
