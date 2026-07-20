#!/usr/bin/env python3
"""E2-A — 고밀도 단축 경제 측정 (성재 승인 2026-07-20, 2일 러너 대체).

측정 항목(몇 시간 → 2일 외삽):
 1) 활성 컴퓨트 사이클: 세션 2개 동시(성재 지시 동시성 2), N burst의 활성 초 정밀 기록
 2) 스탠바이 0과금 검증: pause 상태 T분 유지 후 대시보드 usage 대조용 타임스탬프 기록
 3) 재개 지연 재확인(E1 교차검증)
출력: JSONL + 요약(활성 h, 예상 $, 스탠바이 구간 명세) — 실청구는 e2b 대시보드와 수동 대조.
"""
import json, os, sys, time
from e2b import Sandbox

BURSTS = int(os.environ.get("E2A_BURSTS", "6"))
STANDBY_MIN = float(os.environ.get("E2A_STANDBY_MIN", "20"))
CONCURRENCY = 2
LOG = os.environ.get("E2A_LOG", "/tmp/e2a.jsonl")
rec_all = []

def emit(**kw):
    kw["mono"] = round(time.monotonic(), 1)
    rec_all.append(kw)
    with open(LOG, "a") as f: f.write(json.dumps(kw) + "\n")
    print(f"[e2a] {kw}", file=sys.stderr)

snap = [None, None]
active_s = 0.0
emit(event="start", bursts=BURSTS, standby_min=STANDBY_MIN)
for b in range(BURSTS):
    t0 = time.monotonic()
    live = []
    for i in range(CONCURRENCY):
        sbx = Sandbox.connect(snap[i]) if snap[i] else Sandbox.create(timeout=600)
        r0 = time.monotonic()
        sbx.commands.run("for i in $(seq 1 30); do sha256sum /usr/bin/* >/dev/null 2>&1; done; echo done", timeout=300)
        live.append((i, sbx, round(time.monotonic()-r0, 2)))
    for i, sbx, dur in live:
        sbx.pause(keep_memory=True); snap[i] = sbx.sandbox_id
    bur