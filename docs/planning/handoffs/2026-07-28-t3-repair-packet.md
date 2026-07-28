# goal #876+#877+#878 — T3 수명주기·정산 수리 (한 배치)

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(최신 — #875 서명 v2 랜딩분 포함). 모델: gpt-5.6-sol medium.

**세 티켓을 한 배치로 묶는다** — 같은 코드 영역(정산·수명주기·프로비저닝)이라 따로 고치면 서로 충돌한다.
발단은 `adversarial-review`(2026-07-28)가 잡은 교차 결함이고, **오케스트레이터가 코드로 실증했다.**

## 0. 착수 전 필수
1. `git status` clean. 2. **자격증명·`.env` 금지 — E2B 키를 읽지 마라**(실호출은 오케스트레이터). 3. **PR 후 STOP.** 4. docker는 오케스트레이터. 5. 심볼 grep 실재 확인. 6. UUID 비교는 lower() 정규화.

## 1. [#876] 종료·orphan 경로가 T3 사용량을 영구 미정산으로 남긴다
`TierFallbackSweep.swift`에 **`credit_entry`·`work_host_usage`·`CloudUsageLedger` 참조가 0건**(grep 실증). idle 타임아웃과 stale sweep이 `work_session`만 바꾸고 **interval을 안 닫고, 차감 안 하고, `work_cloud_host`를 해제하지 않는다.**
**가장 나쁜 조합**: pause된 T3 workd는 heartbeat를 못 보내 **stale sweep의 표적**이 된다 → 이미 쓴 활성시간 미차감 + 슬롯 계속 점유.

→ **모든 terminal/orphan 전이를 하나의 정산 primitive로 통합**(같은 트랜잭션에서 interval 종료·usage 확정·credit 차감·cloud host 해제). provider destroy는 **트랜잭션 밖** 재시도 가능 단계로.
→ **paused 호스트가 stale sweep에 걸리는 문제를 함께 판단하라** — paused는 heartbeat 부재가 정상이다. sweep이 cloud paused를 알아야 하는지, 대체 신호가 필요한지 근거와 함께 결정.

## 2. [#877] 순환 의존 · host당 세션 유일성 · provider 경합
**① pause가 resume 주체를 정지시킨다**: idle에서 sandbox를 pause하는데(`WorkSessionRoutes.swift:829-838`) resume 트리거가 "그 sandbox 안 workd의 signed running PATCH"다 — 멈춘 데몬은 못 보낸다. human resume REST는 cloud_host/원장만 running으로 바꾸고 `work_session`은 idle로 남겨 **다음 호스트 보고가 불일치로 실패**.
→ **durable resume intent 기록 → provider 먼저 resume → session·cloud-host·원장 CAS 전이.** 호스트 보고는 *시작 조건*이 아니라 *완료 확인*.

**② host당 unsettled usage 유일성 없음 → 이중 과금**: cloud host가 running이어도 새 usage가 열리고 host_id 유일 제약이 없다. 한 sandbox에 세션 둘이면 **하나의 idle이 sandbox 전체를 pause**시키는데 원장은 그 세션만 paused로 바꿔 **나머지는 멈춘 채 계속 과금**.
→ v0은 **host_id당 unsettled usage 1건 partial unique**. 멀티세션이 필요하면 참조 카운트(전 세션 idle일 때만 pause).

**③ provider 호출이 DB 전이보다 먼저**: 잠금 없는 preflight → provider 호출 → 그제서야 `FOR UPDATE`(`:514-525`). 사이에 sweep·종료·중복 보고가 끼면 **provider는 성공, DB는 롤백** → 실제 sandbox와 원장이 갈라진다.
→ 트랜잭션에서 `pausing/resuming` intent+version **먼저 CAS** → idempotency key로 provider 호출 → 별도 트랜잭션 확정 + 수렴 reconciler.

## 3. [#878] provisioning crash-safety + topup 관리 REST
**① crash-safe·idempotent하지 않다**: provisioning row 커밋 → E2B create → sandbox ID를 **두 번째 트랜잭션**에 저장. 201 직후 죽으면 **유료 sandbox가 살아 있는데 DB에 ID가 없어 destroy 불가**(청구 지속). 재시도는 **새 sandbox를 또 만든다.** 회수 reconciler도 없다.
→ idempotency key 기반 create + 미확정 provisioning 수렴 reconciler(고아 sandbox 정리 포함).

**② topup 경로가 프로덕션에 없다**: `credit_entry` 쓰기가 `t3_usage` 차감 한 곳뿐(`CloudUsageLedger.swift:308`). 검증기만 `row_security=off`로 직접 충전(`verify_t3_provisioner.sh:228`). 일반 워크스페이스는 T3를 **시작할 방법이 없다**.
→ **instance-operator 전용 관리 REST**: 양수 topup · idempotency ref · 강한 권한 검사 · 감사, 한 트랜잭션. 워크스페이스 생성 시 0 잔액 원장 초기화. openapi 명세 동반.

## 4. 반드시 지킬 불변식 (깨면 회귀다)
- **pause 구간 0 계상이 GENERATED 컬럼으로 구조적 보장**(045) — 정산 코드의 빼기에 의존하지 않는다. 유지해라.
- **서명 v2**(#875 랜딩): 모든 호스트 요청은 body digest + 1회용 request ID. 새 호스트 경로를 추가하면 v2 서명으로.
- 자격증명 비유입(ADR-0004). 자동 T3 전환 기본값 금지(질문 없는 과금). 서버가 PTY 바이트 비경유(D10).
- `schema_v0.sql` 수정 금지.

## 5. 검증
- `swift build`·서버 테스트 무회귀(현재 344)·데몬 32.
- **기존 검증기 8종 전부 그린 유지**: work_session_idle · work_session · terminal_attach · observer_attach · work_pool · t3_provisioner · agent_run_history · push_notifier.
- **신규 관문**(t3_provisioner 확장 권장): ①idle 타임아웃/stale sweep/paused-sweep 각각에서 interval 닫힘·차감·슬롯 해제(이중 차감 없음=멱등) ②resume가 **호스트 보고 없이** 성립 ③같은 host 두 번째 세션 거부(또는 참조 카운트 정확) ④provider 성공 후 DB 충돌 시 수렴(불일치 잔존 0) ⑤create 응답 유실 후 재시도가 **sandbox 중복 생성 안 함** ⑥topup REST가 비운영자 거부 + 감사·멱등.
- **red proof는 항목당 1개, 전부 이름 있는 실패**(행·타임아웃은 깨진 증명 — 실측 교훈). 절차를 PR에 정확히.
- **전이는 실제 REST/sweep/mock-E2B 경로로** — SQL 지름길로 상태를 심어 경계를 우회하지 마라(이 레포가 6회 밟았다).

## 6. PR
`feat/876-t3-lifecycle-settlement` → `track/engine`. 본문: 정산 primitive 설계, paused-sweep 판단, resume intent 상태기계, 유일성 vs 참조카운트 선택 근거, provisioning idempotency 키 설계, topup 권한 경계, 오케스트레이터 실행 목록(mock 검증기 + 실 E2B 스모크 절차), 계획 이탈. **PR 후 STOP.**
