# 워크플로 병렬 배치 준비 — 2026-07-29 (성재 트리거 대기)

> 성재 지시: "1개 워커 순차는 느리고 tmux에 안 보인다. 워크플로 활용 검토, 준비만 해두고 실행은 따로 요청."
> **이 문서로 준비 완료 상태를 고정한다. 성재가 "배치 실행해줘"라고 하면 §3 워크플로를 그대로 투입한다.**

## 1. 현재 상태

- **#897 워커(Opus 단일) 종료됨.** 작업물은 `feat/897-provider-adapter`에 WIP 커밋 `716ea9e3`으로 보존:
  완료 = CloudProviderKit(어댑터 프로토콜+capability) · 054 마이그레이션 초안 · E2BProvisioner 삭제.
  미완 = reconciler 어댑터 치환 마무리 · BYOC REST · mock 2종 · 연속성 검증기 · 빌드/테스트 · PR.
  **빌드 미검증 상태의 체크포인트다 — 이어받는 에이전트는 빌드부터.**
- 가시성 문제의 원인: Agent tool 서브에이전트는 tmux 창이 아니라 세션 하네스 안에서 돌아 tmux에 아무것도 안 뜬다.
  **워크플로는 `/workflows` 라이브 뷰에 단계별·에이전트별 진행이 그대로 보인다** — 성재의 두 불만(순차·불가시)을 동시에 해소.

## 2. 병렬 레인 설계 (파일 경계 비겹침이 원칙)

| 레인 | 내용 | 파일 경계 | 마이그레이션 예약 |
|---|---|---|---|
| **A** | **#897 완결**(716ea9e3 이어받기) — ADR-0142 이행 1~3 | `services/CloudProviderKit` · NotifierWorker reconciler · `CloudProvisionerRoutes` · 신규 검증기 | **054**(이미 초안) |
| **B** | **ADR-0143 이행(엔진)** — workstream 테이블·암시 생성·재개 자격 확장·검증기 4종 | 신규 마이그레이션 · `WorkSessionRoutes`(resume 경로) · 신규 검증기 | **055** |
| **C** | **#870 + #879 잔여** — 데몬 재시작 시 사라진 PTY 명시 보고 + replay 구독자 큐 상한 | `workers/WorkHostDaemon`만 | 없음 |
| **D** | **#865** — verify_openapi_contract의 remote-create 409 (3배치째 게이트 차단) | `scripts/` + openapi 스펙 | 없음 |

- **#869(WSS attach 어댑터)는 이번 배치에서 제외** — 서버 `WorkSessionRoutes`를 건드려 레인 B와 겹친다. B 랜딩 후 후속.
- **#892(T-4)는 레인 A 랜딩 후** — 어댑터 인터페이스 위에 구현하는 순서(기결정).
- 마이그레이션 번호는 레인별 예약(A=054, B=055)으로 충돌 방지. `check_migration_numbers.sh`가 최종 심판.

## 3. 실행 형태 (트리거 시)

- 워크트리 4개를 track/engine에서 선생성(A는 기존 `897-provider-adapter` 재사용), 각 레인 에이전트(Opus medium)에 패킷 프롬프트로 병렬 투입 — **Workflow 스크립트의 `parallel()` 1단계 + 오케스트레이터 검수**.
- 각 에이전트: 구현 → swift build/테스트 → push → **PR 생성 후 STOP**(merge 금지 — 기존 계약 그대로).
- 오케스트레이터(Fable): docker 검증기·하니스·T1/T2 무회귀 실행 → **순차 머지**(A→B→C→D, 각 머지 후 무회귀 확인) — "머지는 순차" 하드 룰 유지.
- 레인별 패킷 상세는 기존 문서 재사용: A=`2026-07-29-897-provider-adapter-packet.md`(+WIP 이어받기 주석), B=ADR-0143 이행·수용기준 4종, C=#870/#879 티켓 본문, D=#865 티켓 본문.

## 4. 준비 완료 체크리스트

- [x] #897 WIP 보존(`716ea9e3`) 및 워커 종료
- [x] 레인 경계·마이그레이션 번호 예약 확정
- [ ] 성재 트리거 → 워크트리 3개 추가 생성 + 워크플로 투입 (5분 내 착수 가능)
