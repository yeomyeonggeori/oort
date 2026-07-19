#!/usr/bin/env python3
"""E1 지연 프로파일 — Blaxel (research/17-work-host-fabric/01 §2 E1).

측정: create / exec 왕복 / (스탠바이 자동이라 수동 pause 없음 — 재개는 E2에서 유휴 후 실측).
키: BL_API_KEY/BL_WORKSPACE 환경변수(blaxel SDK 규약 — 루트 .env의 BLAXEL_*를 매핑).
"""
import asyncio, json, os, statistics, sys, time

os.environ.setdefault("BL_API_KEY", os.environ.get("BLAXEL_API_KEY", ""))
os.environ.setdefault("BL_WORKSPACE", os.environ.get("BLAXEL_WORKSPACE", ""))

from blaxel.core import SandboxInstance  # noqa: E402

N = int(os.environ.get("E1_ITERS", "10"))
results = {"provider": "blaxel", "iters": N, "create_s": [], "exec_roundtrip_s": [],
           "delete_s": [], "errors": []}


async def main():
    for i in range(N):
        name = f"momo-e1-{int(time.time())}-{i}"
        try:
            t0 = time.monotonic()
            sbx = await SandboxInstance.create({"name": name})
            await sbx.wait()
            results["create_s"].append(time.monotonic() - t0)

            t0 = time.monotonic()
            out = await sbx.process.exec({"command": "echo momo-e1"})
            results["exec_roundtrip_s"].append(time.monotonic() - t0)

            t0 = time.monotonic()
            await SandboxInstance.delete(name)
            results["delete_s"].append(time.monotonic() - t0)
        except Exception as e:  # noqa: BLE001 — 파일럿: 오류 유형 수집
            results["errors"].append(f"iter{i}: {type(e).__name__}: {e}")
            try:
                await SandboxInstance.delete(name)
            except Exception:
                pass
        print(f"[e1-blaxel] iter {i+1}/{N} done", file=sys.stderr)


asyncio.run(main())


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 3)


summary = {}
for k in ("create_s", "exec_roundtrip_s", "delete_s"):
    xs = results[k]
    summary[k] = {"n": len(xs), "p50": pct(xs, 0.5), "p95": pct(xs, 0.95),
                  "mean": round(statistics.mean(xs), 3) if xs else None}
results["summary"] = summary
print(json.dumps(results, ensure_ascii=False, indent=2))
