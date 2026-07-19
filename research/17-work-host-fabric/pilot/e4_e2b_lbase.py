#!/usr/bin/env python3
"""E4 — momo L-base 템플릿(swift+repo+웜빌드) 스폰 분기 + 캐시 재사용 (17-01 §2 E4).

판정선: 분기(create from template) < 5s, 두 번째 사용자 빌드 캐시 단축 >= 50%.
"""
import json, os, statistics, sys, time

from e2b import Sandbox

N = int(os.environ.get("E4_ITERS", "10"))
results = {"provider": "e2b", "template": "momo-lbase", "iters": N,
           "branch_create_s": [], "warm_build_s": [], "errors": []}

for i in range(N):
    try:
        t0 = time.monotonic()
        sbx = Sandbox.create(template="momo-lbase", timeout=180)
        results["branch_create_s"].append(time.monotonic() - t0)

        if i < 3:  # 캐시 재사용은 3회만 (빌드 시간 비용 절약)
            t0 = time.monotonic()
            out = sbx.commands.run(
                "cd /workspace && swift build -j 4 --package-path server 2>&1 | tail -1",
                timeout=600)
            results["warm_build_s"].append(round(time.monotonic() - t0, 2))
            if i == 0:
                results["warm_build_tail"] = (out.stdout or "").strip()[-120:]
        sbx.kill()
    except Exception as e:  # noqa: BLE001
        results["errors"].append(f"iter{i}: {type(e).__name__}: {e}")
        try:
            sbx.kill()
        except Exception:
            pass
    print(f"[e4] iter {i+1}/{N} done", file=sys.stderr)

def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 3)

results["summary"] = {
    "branch_create_s": {"n": len(results["branch_create_s"]),
                        "p50": pct(results["branch_create_s"], 0.5),
                        "p95": pct(results["branch_create_s"], 0.95)},
    "warm_build_s": results["warm_build_s"],
}
print(json.dumps(results, ensure_ascii=False, indent=2))
