#!/usr/bin/env python3
"""E2-A — 고밀도 경제 측정 (17-01 §2 E2, 단축판·2일 외삽).

목표: 활성 컴퓨트 단가 확증 + pause 스탠바이가 진짜 0과금인지 + 재개 지연을
집중 측정해 2일 비용을 외삽. 동시성 2 캡, 예산 하드캡.

측정: N개 세션을 CONCURRENCY씩 배치로 create→작업→pause→(스탠바이)→resume 왕복 R회.
각 단계 시간·성공을 JSONL. 종료 후 E2B 대시보드 실청구액과 활성시간을 대조.
"""
import json, os, statistics, sys, time
from e2b import Sandbox

N = int(os.environ.get("E2A_SESSIONS", "3"))
CONC = int(os.environ.get("E2A_CONCURRENCY", "2"))
ROUNDS = int(os.environ.get("E2A_ROUNDS", "6"))     # 왕복 6회 = 간헐 사용 다회 샘플
STANDBY_S = float(os.environ.get("E2A_STANDBY_S", "30"))  # 스탠바이 유지(짧게, 과금 관찰)
RATE = 0.10
LOG = os.environ.get("E2A_LOG", "/tmp/e2a.jsonl")
metrics = {"create_s": [], "exec_s": [], "pause_s": [], "resume_s": [], "errors": []}
active_s = 0.0
snaps = [None]*N

def rec(ev, **kw):
    kw["event"]=ev; kw["t"]=round(time.monotonic()-T0,1); kw["active_h"]=round(active_s/3600,4)
    open(LOG,"a").write(json.dumps(kw,ensure_ascii=False)+"\n")
    print(f"[e2a] {ev} {kw.get('detail','')}", file=sys.stderr)

T0=time.monotonic()
rec("start", detail=f"N={N} conc={CONC} rounds={ROUNDS}")
for rnd in range(ROUNDS):
    for base in range(0, N, CONC):
        batch=range(base, min(base+CONC, N)); live=[]
        b0=time.monotonic()
        for i in batch:
            try:
                t=time.monotonic()
                if snaps[i]:
                    s=Sandbox.connect(snaps[i]); metrics["resume_s"].append(time.monotonic()-t)
                else:
                    s=Sandbox.create(timeout=600); metrics["create_s"].append(time.monotonic()-t)
                t=time.monotonic()
                s.commands.run("ls / >/dev/null; echo work", timeout=30); metrics["exec_s"].append(time.monotonic()-t)
                live.append((i,s))
            except Exception as e:
                metrics["errors"].append(f"r{rnd}i{i}: {type(e).__name__}: {e}"); snaps[i]=None
        for i,s in live:
            try:
                t=time.monotonic(); s.pause(keep_memory=True); metrics["pause_s"].append(time.monotonic()-t); snaps[i]=s.sandbox_id
            except Exception as e:
                metrics["errors"].append(f"pause r{rnd}i{i}: {e}"); snaps[i]=None
        active_s += time.monotonic()-b0
    rec("round_done", detail=f"round {rnd+1}/{ROUNDS} est_cost=${round(active_s/3600*RATE,3)}")
    time.sleep(STANDBY_S)  # 스탠바이 구간(0과금 검증용)

for sid in snaps:
    if sid:
        try: Sandbox.connect(sid).kill()
        except Exception: pass
rec("end")
def st(xs): return {"n":len(xs),"p50":round(sorted(xs)[len(xs)//2],3) if xs else None,"mean":round(statistics.mean(xs),3) if xs else None}
summary={k:st(v) for k,v in metrics.items() if k!="errors"}
active_h_2day = active_s/3600  # 이 측정의 활성시간
# 2일 외삽: 중간 시나리오(세션 3×일 3h 활성×2일=18h) 기준 비용
extrap={"measured_active_h":round(active_h_2day,3),
        "2day_midscenario_active_h":18,
        "2day_compute_usd_est":round(18*RATE,2),
        "note":"스탠바이 과금은 대시보드 실청구액과 measured_active_h 대조로 확증"}
print(json.dumps({"summary":summary,"errors":metrics["errors"],"extrapolation":extrap},ensure_ascii=False,indent=2))
