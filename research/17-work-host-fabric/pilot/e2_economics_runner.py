#!/usr/bin/env python3
"""E2 — 경제 실측 러너 (17-01 §2 E2, 2일 축소판).

중간 시나리오: 세션 3개 × 일 3h 활성(빌드/테스트 루프 mock) × 유휴 시 pause(스탠바이).
주기적으로 상태·경과 활성시간을 JSONL로 기록. 실청구액은 종료 후 대시보드와 대조.
env: E2B_API_KEY. E2_DURATION_HOURS(기본 48), E2_ACTIVE_BURST_MIN(활성 버스트 분), E2_IDLE_MIN(유휴 분).
설계: 짧은 활성 버스트→pause(0컴퓨트 스탠바이)→resume 반복으로 "간헐 사용" 실측. 예산 가드: 총 활성시간 상한.
"""
import json, os, sys, time

from e2b import Sandbox

DURATION_H = float(os.environ.get("E2_DURATION_HOURS", "48"))
ACTIVE_MIN = float(os.environ.get("E2_ACTIVE_BURST_MIN", "10"))
IDLE_MIN = float(os.environ.get("E2_IDLE_MIN", "50"))   # 시간당 10분 활성 ≈ 일 4h
# 성재 지시(2026-07-20): 한도 내 효율. $5 예산이면 동시 2개 상시 스탠바이도 충분.
# 동시 라이브 세션 수(스탠바이 제외한 순간 활성)를 CONCURRENCY로 제한하고,
# 나머지는 스냅샷 스탠바이(0컴퓨트)로 둬 "인당 예약" 낭비를 없앤다.
N_SESSIONS = int(os.environ.get("E2_SESSIONS", "3"))
CONCURRENCY = int(os.environ.get("E2_CONCURRENCY", "2"))  # 동시 활성 상한(동적 풀)
MAX_ACTIVE_H = float(os.environ.get("E2_MAX_ACTIVE_HOURS", "10"))  # 예산 하드캡(~$5 = 활성 컴퓨트 ~10h 이하)
EST_RATE_USD_PER_ACTIVE_H = 0.10
LOG = os.environ.get("E2_LOG", "/tmp/e2-economics.jsonl")

# monotonic만 사용(Date 계열 회피 규칙과 무관 — 여기는 일반 파이썬)
start = time.monotonic()
active_seconds = 0.0
cycle = 0

def emit(rec):
    rec["t_rel_s"] = round(time.monotonic() - start, 1)
    rec["active_h_cum"] = round(active_seconds / 3600, 3)
    with open(LOG, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"[e2] {rec.get('event')} cycle={cycle} active_h={rec['active_h_cum']}", file=sys.stderr)

# 세션 N개 스냅샷 ID 풀
snap_ids = [None] * N_SESSIONS
emit({"event": "start", "sessions": N_SESSIONS, "duration_h": DURATION_H})

while (time.monotonic() - start) < DURATION_H * 3600 and active_seconds / 3600 < MAX_ACTIVE_H:
    cycle += 1
    burst_start = time.monotonic()
    # 동적 풀: 한 번에 CONCURRENCY개만 resume→작업→pause. 예산 초과 예상 시 조기 중단.
    for base in range(0, N_SESSIONS, CONCURRENCY):
        if (active_seconds + (time.monotonic() - burst_start)) / 3600 >= MAX_ACTIVE_H:
            emit({"event": "budget_cap_reached"}); break
        live = []
        for i in range(base, min(base + CONCURRENCY, N_SESSIONS)):
            try:
                sbx = Sandbox.connect(snap_ids[i]) if snap_ids[i] else Sandbox.create(timeout=1200)
                sbx.commands.run("echo build-test loop; ls / >/dev/null; sleep 1", timeout=60)
                live.append((i, sbx))
            except Exception as e:  # noqa: BLE001
                emit({"event": "session_error", "i": i, "err": f"{type(e).__name__}: {e}"})
                snap_ids[i] = None
        for i, sbx in live:  # 배치 끝나면 즉시 스탠바이로(0컴퓨트)
            try:
                sbx.pause(keep_memory=True); snap_ids[i] = sbx.sandbox_id
            except Exception as e:  # noqa: BLE001
                emit({"event": "pause_error", "i": i, "err": f"{type(e).__name__}: {e}"}); snap_ids[i] = None
    active_seconds += (time.monotonic() - burst_start)
    emit({"event": "burst_done", "est_cost_usd": round(active_seconds/3600*EST_RATE_USD_PER_ACTIVE_H, 2)})
    time.sleep(IDLE_MIN * 60)  # 유휴(스탠바이 유지)

# 정리
for sid in snap_ids:
    if sid:
        try: Sandbox.connect(sid).kill()
        except Exception: pass
emit({"event": "end", "cycles": cycle})
print(json.dumps({"cycles": cycle, "active_h": round(active_seconds/3600,3), "log": LOG}, ensure_ascii=False))
