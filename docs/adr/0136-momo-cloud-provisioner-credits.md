# ADR-0136: oort Cloud(T3) 프로비저너 v0 + 크레딧 원장

- **운영 상태(2026-07-28): T3는 기본 비활성이다. 재설계 진행 중(#888)이며 `MOMO_T3_ENABLED=1` 명시 옵트인 없이는 전 표면이 503으로 닫힌다.**
- Status: **Accepted** (2026-07-26, 성재 — "둘다 승인할게". 초안 Fable 2026-07-26)
- 관련: ADR-0125(work host fabric — D3 기질 미결분 해소, D7/D8 과금 모델), 프로그램 AX-6·AX-7 2층, 레퍼런스 §6

## Context

1. `work_host.type='cloud'`는 셀렉터·정책 타깃으로만 존재 — 프로비저너/오토스케일 코드 0줄, `TerminalAttachRoutes` 자체 고지("Real workd/provisioner PTY adapters are follow-up").
2. 성재 지시: "cloud까지 T1~T3 CLI 기반 개발 특화 작업 확인, 크레딧 충전하고 오토스케일링 보기" — 1인 테스트 중점 항목.
3. ADR-0125 D7: 워크스페이스 단위 동시 슬롯 N + 월 활성시간 H, T1/T2 무료·T3만 유료, 모델요금은 BYOA. 현 `usage_ledger`는 토큰 비용 전용 — **활성시간을 재는 원장이 없다.**
4. 레퍼런스 실측: Daytona auto top-up = Threshold+Target 2필드(둘 다 0=비활성). E2B는 429 즉시 실패·큐잉 없음, Modal만 큐 깊이 시각화. Vercel 50/75/100% 단계 알림, Railway 소프트/하드 분리.

## Decisions

### D1. 기질 = E2B (v0)
- **A (권고)**: E2B 샌드박스에 workd를 부트스트랩하는 서버 측 프로비저너. 흐름: 세션 요청(auto_target=cloud) → 프로비저너가 E2B API로 생성 → workd 기동+자기등록(type=cloud, 기존 Ed25519 등록 계약 그대로) → 세션 라우팅은 기존 D6 로직. **E2B API 키는 인스턴스 운영자 시크릿**(env)이며 워크스페이스/사용자에게 비노출 — ADR-0004 동형 경계.
- B — Fly/자체 VM: 부트 속도·스냅샷·과금 단위에서 v0 이점 없음. **보류**(v1 재평가).

### D2. 활성시간 미터 + 크레딧 원장
- 신규 원장 2개(마이그레이션): `work_host_usage(session_id, host_id, workspace_id, started_at, ended_at, active_seconds)` — T3만 기록 v0. `workspace_credit(workspace_id, balance_micro_usd, updated_at)` + `credit_entry(워크스페이스, delta, reason(topup|t3_usage), ref)` 이중 기입.
- 정산: 프로비저너가 세션 종료 시 active_seconds×단가를 credit_entry로 차감. 잔액 0 이하 → 신규 T3 세션 거부(**기존 세션은 죽이지 않는다** — 진행 중 작업 보호, 소프트/하드 분리 원칙).
- 충전 v0 = 운영자 수동(관리 REST). auto top-up(Threshold+Target)·결제 연동은 v1.
- **2026-07-28 수명주기 수리(#876~878)**: host당 미정산 usage는 v0에서 1건만
  허용한다. terminal/orphan은 interval 종료·active 합계 확정·멱등 차감·slot 해제와
  provider destroy intent를 한 DB transaction에서 만든다. pause/resume/destroy는
  `pausing|resuming|destroy_pending` intent+version CAS를 provider 호출보다 먼저
  커밋하고, provider 호출은 intent UUID를 idempotency key로 사용한 뒤 별도
  transaction/reconciler가 확정한다.
- E2B create도 client create ref와 provision UUID를 각각 DB/provider idempotency key로
  사용한다. bootstrap token은 process-only E2B key와 provision UUID에서 결정적으로
  유도하므로 응답 유실 뒤에도 raw token을 저장하지 않고 같은 sandbox로 수렴한다.
- **2026-07-28 #882 보안 수리**: 관리 topup REST는 cross-tenant 읽기 권한과
  분리된 `platform:credits:write`를 가진 human token만 허용한다.
  `platform:read` 또는 verified allowlist identity만으로는 크레딧을 늘릴 수 없다.
  platform-admin secret login은 두 scope를 함께 발급하며, 양수 금액·UUID ref·감사는
  한 transaction에 기록한다.
- provisioning의 client idempotency ref는 row 부재 전 tenant+ref advisory
  transaction lock을 선취한다. provider 호출 뒤 lifecycle reconciler는 host row를
  잠그고 operation/state를 재검증한 뒤에만 usage/session을 바꾸며 최종 CAS 1행을
  단정한다. resume 404/410은 같은 transaction에서 terminal 정산·slot 해제·host
  revoke·orphan sweep 적격화를 확정한다.

### D3. 관측 — 레이트 미터 + 큐
- 사용량 섹션에 T3 블록: **동시 세션 N/M 레이트 미터**(잔액과 프레임 분리 — 레퍼런스 교차 발견) + 월 활성시간 + 크레딧 잔액.
- 슬롯 캡 도달 시 즉시 실패 대신 **대기열 + 깊이 노출**(Modal 문법, "김인턴이 대기열 2번째" — 기존 work_pool 대기열 재사용).
- 50/75/100% 알림은 v1(알림 파이프라인 있음 — 문구만 결정).

### D4. 실동 리허설 게이트
- Accepted 후 첫 티켓은 구현이 아니라 **T1→T2→T3 CLI 작업 실왕복 리허설 시나리오 정의**: 같은 goal을 세 티어에서 수행·중단·재개(D11 폴백 경로 포함)하고 각 단계 실측 기록. 성재 1인 테스트의 대본이 된다.

## Consequences
- (+) D3 미결 해소, D7 과금 축(활성시간)이 처음으로 원장을 얻음. 크레딧·동시성·큐가 전부 가시화.
- (−) E2B 종속(v0 명시적 트레이드오프)·외부 과금 발생(성재 충전 결정 필요)·마이그레이션 3건.
- 파생(Accepted 시): 엔진 2장(프로비저너+원장 / 정산·거부 게이트), 웹 1장(T3 블록+큐 표기), 리허설 1장(D4). MOMO-520(T3 재개 카드)이 이 위에 얹힌다.
