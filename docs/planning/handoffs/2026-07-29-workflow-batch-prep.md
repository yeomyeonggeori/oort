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

## 5. 배치 1 완료 기록 (2026-07-29)

**4/4 랜딩** — track/engine: #897(`9c2bebb9`) → #898(`38754cff`) → #870+#879②(`c64fbe5a`) → #865(`a32f0279`).

- 워크플로 27분 병렬 구현(Opus medium ×4, 789k tokens) + 오케스트레이터 순차 검수·머지.
- 오케스트레이터 수리 3건: A 픽스처 provider 명시(NOT NULL 즉사) · C 054→056 재번호 · D 완주가 드러낸 스펙 누락/부채 처리.
- red proof 실측: A(dishonest-probe·pause 과금 회귀) · B(자격 술어 되돌림) · C(큐 상한 무력화— 워커 실측) · D(구조상 불필요 — 원인 판정형).
- 신규 발견→티켓: #903(verify_workd 선존재, bisect 필요) · #904(미샘플 44건 백필).
- **main 반영은 성재 승인 대기.** engine이 main보다 +4 머지 앞섬.

## 6. 배치 2 완료 기록 (2026-07-29)

**3/3 랜딩** — track/engine: G #903(`559ce690`) → E #892(`b76cd2c8`) → F #869(`7bc08b5b`). 워크플로 32분 병렬(Opus ×3, 654k tokens).

- **ADR-0140 이행 전체 완결**(T-2·T-3·T-4) — MOMO_T3_ENABLED 기본 활성화는 실 provider smoke 후 별건(성재).
- **ADR-0139 재부착 체감 완결** — 실왕복 실측(replay 13,886B → replay_end 1개 → live). 데몬↔서버↔wss프록시↔클라이언트 전 구간.
- G의 판정: verify_workd 실패는 #857 계약 변화 미반영(선존재) — bisect 없이 원장 증거로 특정. 무회귀 세트 4종 확정.
- ADR-0140 D4 증보 반영(pausing+부재→provider_missing 등 — E 이행 중 확정).
- 오케스트레이터 수리: E 검증기 3건(sweep 간섭·destroy 라우트 오기·red 사본 .env.example) + F 실왕복 하니스 신작.
- 잔여 티켓: #904(미샘플 44 백필) · #908(attach 후속 3종) · #879①(floor 정밀도) · #886~#849 기존 열림분.
- **main 반영은 성재 승인 대기** — engine이 main보다 배치 2(3머지+검증기 수리) 앞섬.
